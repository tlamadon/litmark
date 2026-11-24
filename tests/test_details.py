"""What a paper is called, deleting a note, and naming one paper in another's text.

A PDF's own metadata is often junk — a word processor's file path for a title,
the publisher for an author, the day the file was made for a year — so what a
paper is called comes from what someone read on its title page, and until then
junk is at least not shown as though it were a title.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from conftest import upload, wait_for_extraction
from litmark.agent.prompts import summary_prompt
from litmark.agent.tools import TOOL_SCHEMAS, dispatch
from litmark.api.app import TOKEN_HEADER, create_app
from litmark.documents import Document, author_names, surname_of
from litmark.extraction import clean_authors, clean_title
from litmark.mcpserver import ATTRIBUTED
from litmark.references import paper_ids_in_markdown


def paper(**fields: Any) -> Document:
    return Document.from_json(
        {"document_id": "doc-001", "sha256": "0" * 64, "original_filename": "a.pdf", **fields}
    )


# ------------------------------------------------------------ what it is called


@pytest.mark.parametrize(
    "junk",
    [
        r"K:\MEMOS\DISCUSS\92-2\CES92-2.FNL",
        "CES92-2.FNL",
        "/home/someone/drafts/paper.dvi",
        "C:/Users/someone/paper.tex",
        "Microsoft Word - final_v3.doc",
        "untitled",
    ],
)
def test_what_a_word_processor_left_as_a_title_is_not_one(junk):
    assert clean_title(junk) is None


@pytest.mark.parametrize(
    "title",
    [
        "Firm wage effects",
        "Returns to Schooling in the U.S.",
        "Input/Output Linkages and Growth",
        "Econometrica, Vol. 64, No. 6",
        "Version 2.0 of the Model",
    ],
)
def test_a_real_title_is_kept(title):
    assert clean_title(title) == title


def test_whoever_produced_the_file_is_not_its_author():
    for producer in ("Center for Economic Studies", "Elsevier", "MIT Press", "anonymous"):
        assert clean_authors(producer) is None
    assert clean_authors("  Ariel   Pakes ") == "Ariel Pakes"


def test_names_are_read_however_the_author_field_was_written():
    assert author_names("G. Steven Olley and Ariel Pakes") == ["G. Steven Olley", "Ariel Pakes"]
    assert author_names("Alice Researcher, Bob Coauthor") == ["Alice Researcher", "Bob Coauthor"]
    assert author_names("Researcher, Alice") == ["Researcher, Alice"]
    assert author_names(None) == []
    assert [
        surname_of(name)
        for name in (
            "G. Steven Olley",
            "Researcher, Alice",
            "Jan De Loecker",
            "Wilbert van der Klaauw",
            "J.Levinsohn",
        )
    ] == ["Olley", "Researcher", "De Loecker", "van der Klaauw", "Levinsohn"]


def test_a_paper_is_spoken_of_by_its_authors_and_year():
    assert paper(authors="Patrick Kline", year=2025).label == "Kline (2025)"
    assert paper(authors="G. Steven Olley and Ariel Pakes", year=1996).label == "Olley & Pakes (1996)"
    three = "Amit Gandhi and Salvador Navarro and David Rivers"
    assert paper(authors=three, year=2020).label == "Gandhi et al. (2020)"
    assert paper(authors="Ariel Pakes").label == "Pakes"
    # A year alone names nothing.
    assert paper(year=1996).label is None


def test_junk_recorded_before_it_was_recognised_is_not_shown(services):
    """A project holds papers imported by an earlier version."""
    old = paper(
        title=r"K:\MEMOS\DISCUSS\92-2\CES92-2.FNL",
        authors="Center for Economic Studies",
        original_filename="olley-1996-productivity.pdf",
    )
    assert (old.title, old.authors, old.label) == (None, None, None)
    assert old.display_title == "olley-1996-productivity"
    # What someone said it is called is left as they said it.
    said = paper(title="CES92-2.FNL", authors="The Econometric Society", details_by="user")
    assert (said.title, said.authors) == ("CES92-2.FNL", "The Econometric Society")


def test_details_are_set_by_whoever_read_the_title_page(services, client, paper_one):
    document_id = upload(client, "mobility.pdf", paper_one)["imported"][0]["document"]["document_id"]
    wait_for_extraction(client, document_id)
    listed = dispatch(services.tools, "list_documents", {})["documents"][0]
    assert listed["cite_as"] is None and listed["details_confirmed"] is False
    assert listed["link"] == f"[Mobility Restrictions and Wage Growth](paper:{document_id})"

    result = dispatch(
        services.tools,
        "set_document_details",
        {"document_id": document_id, "authors": ["Alice Researcher", "Bob Coauthor"], "year": 2019},
    )
    assert result["ok"] and result["cite_as"] == "Researcher & Coauthor (2019)"
    listed = dispatch(services.tools, "list_documents", {})["documents"][0]
    assert listed["details_confirmed"] is True
    assert listed["link"] == f"[Researcher & Coauthor (2019)](paper:{document_id})"
    # The title was left out, so it stays; and it travels with the project.
    stored = services.documents.get(document_id)
    assert stored.title == "Mobility Restrictions and Wage Growth"
    assert stored.to_json()["details_by"] == "agent"

    for wrong in ({}, {"year": 12}, {"authors": []}, {"title": "  "}):
        refused = dispatch(services.tools, "set_document_details", {"document_id": document_id, **wrong})
        assert refused["ok"] is False, wrong
    assert dispatch(services.tools, "set_document_details", {"document_id": "doc-404", "year": 2000})[
        "error"
    ] == "not_found"


def test_the_user_can_say_what_a_paper_is(services, client, paper_one):
    document_id = upload(client, "mobility.pdf", paper_one)["imported"][0]["document"]["document_id"]
    wait_for_extraction(client, document_id)
    response = client.put(
        f"/api/documents/{document_id}/details",
        json={"authors": "Researcher, Alice; Coauthor, Bob", "year": 2019, "title": "Mobility and Wages"},
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["label"] == "Researcher & Coauthor (2019)"
    assert saved["display_title"] == "Mobility and Wages"
    assert services.documents.get(document_id).details_by == "user"
    assert client.put(f"/api/documents/{document_id}/details", json={"year": 3}).status_code == 422


def test_the_summary_is_asked_to_settle_what_the_paper_is():
    unsure = summary_prompt(document_id="doc-001", title="a", quality="ok", warnings=[], year=1995)
    assert "set_document_details" in unsure and "only what the PDF file says" in unsure
    assert "authors unknown; year 1995" in unsure
    sure = summary_prompt(
        document_id="doc-001", title="a", quality="ok", warnings=[], authors="A B", details_confirmed=True
    )
    assert "only what the PDF file says" not in sure and "paper:doc-" in sure


# ------------------------------------------------------------- deleting a note


def test_a_deleted_note_can_be_brought_back(services, client):
    created = client.post("/api/notes", json={"title": "Scratch", "text": "# Scratch\n\nKeep me.\n"}).json()
    note_id, revision = created["note_id"], created["revision"]
    assert client.delete(f"/api/notes/{note_id}?expected_revision=stale").status_code == 409
    assert client.delete(f"/api/notes/{note_id}?expected_revision={revision}").status_code == 204
    assert client.get(f"/api/notes/{note_id}").status_code == 404
    assert client.delete(f"/api/notes/{note_id}").status_code == 404

    record = client.get("/api/changes").json()["changes"][0]
    assert (record["origin"], record["summary"], record["undoable"]) == ("user", "Deleted note", True)
    assert client.post(f"/api/changes/{record['change_id']}/undo", json={}).status_code == 200
    assert client.get(f"/api/notes/{note_id}").json()["text"] == "# Scratch\n\nKeep me.\n"


def test_undoing_a_deletion_does_not_write_over_a_note_made_since(services, client):
    client.put("/api/notes/plan", json={"text": "Old plan.\n", "expected_revision": None})
    assert dispatch(services.tools, "delete_note", {"note_id": "plan"})["deleted"] is True
    deletion = client.get("/api/changes").json()["changes"][0]
    client.put("/api/notes/plan", json={"text": "New plan.\n", "expected_revision": None})
    assert client.post(f"/api/changes/{deletion['change_id']}/undo", json={}).status_code == 409
    assert client.get("/api/notes/plan").json()["text"] == "New plan.\n"

    refused = dispatch(services.tools, "delete_note", {"note_id": "plan", "expected_revision": "stale"})
    assert refused["error"] == "revision_conflict"
    assert dispatch(services.tools, "delete_note", {"note_id": "absent"})["error"] == "not_found"


def test_what_a_session_elsewhere_may_do_is_recorded_under_its_name():
    names = {schema["name"] for schema in TOOL_SCHEMAS}
    assert {"delete_note", "set_document_details"} <= names & ATTRIBUTED


# ------------------------------------------------------- one paper in another


def test_a_link_to_a_paper_must_be_to_one_that_is_there(services, client, paper_one):
    document_id = upload(client, "mobility.pdf", paper_one)["imported"][0]["document"]["document_id"]
    text = f"This extends [Researcher & Coauthor (2019)](paper:{document_id})."
    assert paper_ids_in_markdown(text + " `[x](paper:doc-999)`") == {document_id}
    assert dispatch(services.tools, "append_note", {"note_id": "log", "text": text})["ok"] is True

    made_up = dispatch(
        services.tools, "append_note", {"note_id": "log", "text": "See [Nobody (1900)](paper:doc-999)."}
    )
    assert made_up["error"] == "unregistered_references" and "paper:doc-999" in made_up["message"]
    refused = dispatch(
        services.tools, "write_summary", {"document_id": document_id, "text": "As in [x](paper:doc-999)."}
    )
    assert refused["ok"] is False and "list_documents" in refused["message"]
