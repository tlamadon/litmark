"""The project as a memory for sessions elsewhere, over MCP.

A Claude session on another machine recalls what the project holds, sets down
what it learns, and sends papers in. What is pinned here: the way in is closed
without a token, every edit from outside carries the name of who made it, and a
PDF arrives through an address that works once.
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any

import pytest
from fastapi.testclient import TestClient

from litmark.api.app import TOKEN_HEADER, create_app
from litmark.cli import main
from litmark.errors import WorkspaceError
from litmark.mcpserver import MCP_TOOL_SCHEMAS, TOKEN_ENV, check_token, clean_label

TOKEN = "t0ken-for-tests-" + "x" * 24
BASE = "http://127.0.0.1:8765"


@pytest.fixture
def outside(services):
    """The server with MCP open, and the browser's credential for looking in."""
    app = create_app(services, mcp_token=TOKEN)
    with TestClient(app, base_url=BASE) as client:
        client.headers.update({TOKEN_HEADER: services.session_token})
        yield client


def rpc(client: TestClient, method: str, params: dict[str, Any] | None = None, **headers: str):
    return client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers={
            "authorization": f"Bearer {TOKEN}",
            "accept": "application/json, text/event-stream",
            "user-agent": "claude-code/2.1.0 (cli)",
            **headers,
        },
    )


def call(client: TestClient, name: str, arguments: dict[str, Any] | None = None, **headers: str):
    response = rpc(client, "tools/call", {"name": name, "arguments": arguments or {}}, **headers)
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    return json.loads(result["content"][0]["text"]), result.get("isError", False)


def send_paper(client: TestClient, data: bytes, **arguments: Any):
    ticket, failed = call(client, "add_paper", arguments)
    assert not failed, ticket
    assert ticket["upload_url"].startswith(BASE + "/upload/")
    path = ticket["upload_url"].removeprefix(BASE)
    # No credential but the address itself: that is the point of it.
    return path, client.put(path, content=data, headers={TOKEN_HEADER: ""})


def changes(client: TestClient) -> list[dict[str, Any]]:
    return client.get("/api/changes").json()["changes"]


# ------------------------------------------------------------- the way in


def test_without_a_token_nothing_is_served(services):
    with TestClient(create_app(services), base_url=BASE) as client:
        response = rpc(client, "tools/list")
        assert response.status_code == 404
        assert TOKEN_ENV in response.json()["error"]["message"]
        assert client.put("/upload/anything", content=b"%PDF-").status_code in (404, 405)


def test_the_token_is_asked_for_and_checked(outside):
    assert outside.post("/mcp", json={}).status_code == 401
    wrong = rpc(outside, "tools/list", authorization="Bearer not-the-token")
    assert wrong.status_code == 401
    # The page's own credential is not a way in either.
    assert rpc(outside, "tools/list", authorization="").status_code == 401

    listed = rpc(outside, "tools/list")
    assert listed.status_code == 200
    names = {tool["name"] for tool in listed.json()["result"]["tools"]}
    assert names == {schema["name"] for schema in MCP_TOOL_SCHEMAS}
    assert {"recall", "append_note", "add_paper", "resolve_source"} <= names


def test_a_session_is_told_what_this_is_for(outside):
    response = rpc(
        outside,
        "initialize",
        {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "claude-code", "version": "2"},
        },
    )
    assert response.status_code == 200
    result = response.json()["result"]
    assert result["serverInfo"]["name"] == "litmark"
    assert "recall" in result["instructions"] and "add_paper" in result["instructions"]


def test_a_browser_password_does_not_stand_in_the_way_of_a_token(services):
    app = create_app(services, mcp_token=TOKEN, password="open sesame")
    with TestClient(app, base_url=BASE) as client:
        assert client.get("/").status_code == 401  # The browser is still asked.
        assert rpc(client, "tools/list").status_code == 200
        assert rpc(client, "tools/list", authorization="Bearer nope").status_code == 401


def test_the_outside_routes_are_no_way_around_the_password(services, paper_one):
    """What excuses a request from the password is drawn exactly.

    The page carries the browser's credential, and any path the server does not
    know is answered with the page — so a path merely *named* like an upload or
    like the MCP endpoint must still be asked for the password.
    """
    app = create_app(services, mcp_token=TOKEN, password="open sesame")
    with TestClient(app, base_url=BASE) as client:
        for path in ("/upload/whatever", "/upload/", "/upload/a/b", "/mcp/anything"):
            response = client.get(path)
            assert response.status_code == 401, path
            assert "litmark-token" not in response.text
        bearer = {"authorization": f"Bearer {TOKEN}"}
        assert client.get("/mcp/anything", headers=bearer).status_code == 401
        assert client.put("/upload/a/b", content=paper_one).status_code == 401
        # The real thing still needs none: the address is the credential.
        assert client.put("/upload/" + "z" * 43, content=paper_one).status_code == 404


def test_with_mcp_off_nothing_is_excused_from_the_password(services, paper_one):
    with TestClient(create_app(services, password="open sesame"), base_url=BASE) as client:
        assert client.put("/upload/" + "z" * 43, content=paper_one).status_code == 401
        assert client.get("/upload/" + "z" * 43).status_code == 401


def test_a_foreign_host_is_refused_as_everywhere_else(outside):
    assert rpc(outside, "tools/list", host="evil.example").status_code == 400


def test_only_the_listed_tools_can_be_called(outside):
    payload, failed = call(outside, "drain_changes")
    assert failed and payload["error"] == "unknown_tool"
    payload, failed = call(outside, "record_document_change", {"document_id": "x"})
    assert failed and payload["error"] == "unknown_tool"


def test_a_token_too_short_to_protect_anything_is_refused(tmp_path, monkeypatch, capsys):
    with pytest.raises(WorkspaceError):
        check_token("hunter2")
    assert check_token("  " + TOKEN + "\n") == TOKEN

    assert main(["init", str(tmp_path / "p")]) == 0
    monkeypatch.setenv(TOKEN_ENV, "short")
    assert main(["serve", str(tmp_path / "p"), "--backend", "fake"]) == 1
    assert "openssl rand" in capsys.readouterr().err


# ------------------------------------------------------- who wrote what


def test_an_edit_from_outside_is_recorded_under_the_clients_name(outside, services):
    payload, failed = call(
        outside, "append_note", {"note_id": "reading-log", "text": "# Reading log\n\nFirst entry."}
    )
    assert not failed and payload["created"] is True

    payload, _ = call(outside, "append_note", {"note_id": "reading-log", "text": "Second entry."})
    note = outside.get("/api/notes/reading-log").json()
    assert note["text"] == "# Reading log\n\nFirst entry.\n\nSecond entry.\n"
    assert payload["revision"] == note["revision"]

    recorded = [c for c in changes(outside) if c["target_id"] == "reading-log"]
    assert [c["origin"] for c in recorded] == ["mcp:claude-code", "mcp:claude-code"]
    assert recorded[0]["summary"] == "Added to note"
    assert recorded[0]["undoable"] is True

    # Open windows are told at once: there is no run to announce it.
    events = services.db.query("SELECT payload_json FROM events WHERE type = 'file_changed'")
    assert len(events) == 2
    assert json.loads(events[-1]["payload_json"])["origin"] == "mcp:claude-code"


def test_an_edit_from_outside_can_be_undone(outside):
    call(outside, "append_note", {"note_id": "log", "text": "Kept."})
    call(outside, "append_note", {"note_id": "log", "text": "Regretted."})
    latest = changes(outside)[0]
    assert outside.post(f"/api/changes/{latest['change_id']}/undo", json={}).status_code == 200
    assert outside.get("/api/notes/log").json()["text"] == "Kept.\n"


def test_saving_back_what_was_just_read_is_not_an_edit_by_the_user(outside, services):
    """An open editor takes in an outside edit; that must not look like its own."""
    call(outside, "append_note", {"note_id": "log", "text": "From afar."})
    note = outside.get("/api/notes/log").json()
    path = services.workspace.root / "notes" / "log.md"
    before = path.stat().st_mtime_ns

    saved = outside.put(
        "/api/notes/log", json={"text": note["text"], "expected_revision": note["revision"]}
    )
    assert saved.status_code == 200 and saved.json()["revision"] == note["revision"]
    assert [c["origin"] for c in changes(outside)] == ["mcp:claude-code"]
    assert path.stat().st_mtime_ns == before

    # A real edit by the user is still recorded as theirs.
    outside.put("/api/notes/log", json={"text": "Mine.\n", "expected_revision": note["revision"]})
    assert [c["origin"] for c in changes(outside)] == ["user", "mcp:claude-code"]


def test_a_session_can_say_which_machine_it_is(outside):
    call(outside, "append_note", {"note_id": "log", "text": "x"}, **{"x-litmark-client": "Office Mac!"})
    assert changes(outside)[0]["origin"] == "mcp:office-mac"
    assert clean_label("  ../Weird name\n") == "weird-name"
    assert clean_label(None) == ""


def test_a_session_cannot_sign_as_someone_else(outside, services):
    payload, failed = call(
        outside,
        "write_note",
        {"note_id": "forged", "text": "hello", "origin": "user", "run_id": "run-1"},
    )
    assert not failed, payload
    record = changes(outside)[0]
    assert record["origin"] == "mcp:claude-code"
    # Nor pass its edit off as part of one of the application's own runs.
    row = services.db.query_one("SELECT run_id FROM changes WHERE id = ?", (record["change_id"],))
    assert row["run_id"] is None


def test_the_version_check_holds_for_outside_edits_too(outside):
    call(outside, "append_note", {"note_id": "log", "text": "One."})
    stale = outside.get("/api/notes/log").json()["revision"]
    call(outside, "append_note", {"note_id": "log", "text": "Two."})
    payload, failed = call(
        outside, "write_note", {"note_id": "log", "text": "Clobber.", "expected_revision": stale}
    )
    assert failed and payload["error"] == "revision_conflict"
    assert "Two." in outside.get("/api/notes/log").json()["text"]


def test_tagging_from_outside_is_recorded(outside, paper_one):
    _, response = send_paper(outside, paper_one, filename="mobility.pdf")
    document_id = response.json()["document_id"]
    payload, failed = call(
        outside, "tag_documents", {"document_ids": [document_id], "add": ["field:labor"]}
    )
    assert not failed and payload["changed"] == 1
    record = changes(outside)[0]
    assert (record["target_kind"], record["target_id"]) == ("document", document_id)
    assert record["origin"] == "mcp:claude-code"
    assert record["summary"] == "Tagged +field:labor"
    assert record["undoable"] is False


def test_the_commit_that_carries_an_outside_edit_says_whose_it_was(outside, services, monkeypatch):
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    root = services.workspace.root
    services.git.init()
    call(outside, "append_note", {"note_id": "log", "text": "From afar."})
    assert services.git.commit() is not None
    message = subprocess.run(
        ["git", "log", "-1", "--format=%B"], cwd=root, capture_output=True, text=True, check=True
    ).stdout
    assert "Edited over MCP by claude-code: note log" in message

    # Said once: the next commit is the user's own and carries no such line.
    revision = outside.get("/api/notes/log").json()["revision"]
    saved = outside.put("/api/notes/log", json={"text": "Mine now.\n", "expected_revision": revision})
    assert saved.status_code == 200
    assert services.git.commit() is not None
    message = subprocess.run(
        ["git", "log", "-1", "--format=%B"], cwd=root, capture_output=True, text=True, check=True
    ).stdout
    assert "MCP" not in message


# --------------------------------------------------------------- papers in


def test_a_paper_is_sent_to_a_one_time_address(outside, services, paper_one):
    path, response = send_paper(
        outside, paper_one, filename="/home/someone/mobility.pdf", tags=["field:labor"], summarize=False
    )
    assert response.status_code == 201, response.text
    paper = response.json()
    assert paper["extraction_status"] == "ok" and paper["page_count"] == 2
    assert paper["tags"] == ["field:labor"]
    assert "read_pages" in paper["message"]

    document = services.documents.get(paper["document_id"])
    assert document.original_filename == "mobility.pdf"
    record = changes(outside)[0]
    assert record["origin"] == "mcp:claude-code"
    assert record["summary"] == "Imported mobility.pdf"

    # Readable and citable straight away, by the session that sent it.
    pages, _ = call(outside, "read_pages", {"document_id": paper["document_id"], "pages": [2]})
    assert "Assumption 2" in pages["pages"][0]["text"]
    cited, _ = call(
        outside,
        "resolve_source",
        {
            "document_id": paper["document_id"],
            "page_number": 2,
            "quote": "Assumption 2 requires that unobserved ability is",
        },
    )
    assert cited["status"] == "resolved"

    # Asked not to summarize: the session means to write the summary itself.
    assert services.db.query("SELECT id FROM runs") == []

    # The address worked once.
    assert outside.put(path, content=paper_one).status_code == 404


def test_the_same_paper_sent_twice_is_one_paper(outside, paper_one):
    _, first = send_paper(outside, paper_one, filename="a.pdf")
    _, second = send_paper(outside, paper_one, filename="b.pdf", tags=["again"])
    assert second.status_code == 200
    again = second.json()
    assert again["duplicate"] is True and again["document_id"] == first.json()["document_id"]
    assert again["tags"] == ["again"]
    assert len(outside.get("/api/documents").json()["documents"]) == 1


def test_what_is_not_a_pdf_is_refused_and_the_address_stays_good(outside, paper_one):
    path, response = send_paper(outside, b"<html>not a paper</html>", filename="x.pdf")
    assert response.status_code == 422
    assert "PDF" in response.json()["error"]["message"]
    assert outside.put(path, content=paper_one).status_code == 201


def test_a_bad_tag_is_refused_before_an_address_is_given(outside):
    payload, failed = call(outside, "add_paper", {"filename": "x.pdf", "tags": ["a, b"]})
    assert failed and "upload_url" not in payload


def test_an_address_that_has_lapsed_says_what_to_do(services, paper_one):
    app = create_app(services, mcp_token=TOKEN)
    with TestClient(app, base_url=BASE) as client:
        response = client.put("/upload/" + "z" * 43, content=paper_one)
        assert response.status_code == 404
        assert "add_paper" in response.json()["error"]["message"]


# ---------------------------------------------------------------- recalling


def test_recall_finds_notes_summaries_and_passages_together(outside, services, paper_one, paper_two):
    _, first = send_paper(outside, paper_one, filename="mobility.pdf", tags=["field:labor"], summarize=False)
    _, second = send_paper(outside, paper_two, filename="search.pdf", summarize=False)
    mobility = first.json()["document_id"]
    call(outside, "write_summary", {"document_id": mobility, "text": "Wage growth falls under mobility restrictions."})
    call(outside, "append_note", {"note_id": "ideas", "text": "Compare mobility restrictions across regions."})
    call(outside, "append_note", {"note_id": "todo", "text": "Buy coffee."})

    found, failed = call(outside, "recall", {"query": "mobility restrictions"})
    assert not failed
    assert [note["note_id"] for note in found["notes"]] == ["ideas"]
    assert "mobility restrictions" in found["notes"][0]["excerpts"][0]
    assert [summary["document_id"] for summary in found["summaries"]] == [mobility]
    assert {passage["document_id"] for passage in found["passages"]} >= {mobility}

    # A paper's tags and title are part of what it is known by.
    by_tag, _ = call(outside, "recall", {"query": "labor wage"})
    assert [summary["document_id"] for summary in by_tag["summaries"]] == [mobility]

    # Kept to tagged papers, notes are left out and the other paper with them.
    tagged, _ = call(outside, "recall", {"query": "mobility", "tags": ["field:labor"]})
    assert tagged["notes"] == []
    assert {passage["document_id"] for passage in tagged["passages"]} == {mobility}
    assert second.json()["document_id"] != mobility

    nothing, _ = call(outside, "recall", {"query": "cryptocurrency"})
    assert nothing["count"] == 0
