"""The agent fetching a paper from the web, as far as the reader allows."""

from __future__ import annotations

import asyncio
import http.server
import threading
import time
import tomllib

import pytest

from litmark import downloads
from litmark.errors import InvalidInput
from litmark.mcpserver import MCP_TOOL_SCHEMAS
from litmark.services import Services

ADDRESS = "https://example.org/papers/mobility.pdf"


def settle(services: Services, timeout: float = 10.0) -> None:
    async def wait() -> None:
        services.runner.start()
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if not services.db.query("SELECT id FROM runs WHERE status IN ('queued', 'running')"):
                await services.runner.stop()
                return
            await asyncio.sleep(0.01)
        raise AssertionError("Agent runs did not settle")

    asyncio.run(wait())


def events_of(services: Services, *types: str) -> list[dict]:
    return [event for event in services.db.events_since(0) if event["type"] in types]


@pytest.fixture
def fetched(monkeypatch, paper_one: bytes) -> list[str]:
    """Stand in for the network: every address answers with the same paper."""
    asked: list[str] = []

    def fake_fetch(url: str, *, max_bytes: int, timeout: float = 0) -> downloads.Fetched:
        asked.append(url)
        return downloads.Fetched(data=paper_one, filename="mobility.pdf", url=url)

    monkeypatch.setattr(downloads, "fetch_pdf", fake_fetch)
    return asked


def ask_to_download(services: Services, url: str = ADDRESS) -> dict:
    services.backend.script = [("tool", "download_paper", {"url": url})]
    conversation = services.runner.create_conversation(None)
    services.runner.submit(conversation_id=conversation, prompt="Add this paper")
    settle(services)
    return events_of(services, "tool_finished")[-1]["result"]


def answer_when_asked(services: Services, answer: str) -> threading.Thread:
    def run() -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            asked = events_of(services, "permission_requested")
            if asked:
                assert services.answer_permission(asked[0]["request_id"], answer)
                return
            time.sleep(0.01)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def test_asking_is_the_default(services):
    assert services.download_mode() == "ask"
    assert services.project_state()["settings"] == {"downloads": "ask"}


def test_allowed_once_the_paper_is_imported(services, fetched):
    waiter = answer_when_asked(services, "allow")
    result = ask_to_download(services)
    waiter.join(5)

    assert result["ok"] is True and result["duplicate"] is False
    assert fetched == [ADDRESS]
    assert [doc.document_id for doc in services.documents.list()] == [result["document_id"]]
    (asked,) = events_of(services, "permission_requested")
    assert asked["url"] == ADDRESS and asked["host"] == "example.org"
    (resolved,) = events_of(services, "permission_resolved")
    assert resolved["request_id"] == asked["request_id"] and resolved["answer"] == "allow"
    # Once is once: the next one is asked about again.
    assert services.download_mode() == "ask"


def test_declined_nothing_is_fetched(services, fetched):
    waiter = answer_when_asked(services, "deny")
    result = ask_to_download(services)
    waiter.join(5)

    assert result["ok"] is False and result["error"] == "download_declined"
    assert fetched == [] and services.documents.list() == []


def test_always_is_remembered_in_the_project_file(services, fetched):
    waiter = answer_when_asked(services, "always")
    assert ask_to_download(services)["ok"] is True
    waiter.join(5)

    assert tomllib.loads(services.workspace.project_file.read_text())["agent"]["downloads"] == "always"
    # And so the next download does not ask.
    again = ask_to_download(services, "https://example.org/other.pdf")
    assert len(events_of(services, "permission_requested")) == 1
    assert again["ok"] is True and again["duplicate"] is True


def test_never_refuses_without_asking(services, fetched):
    services.set_download_mode("never")
    result = ask_to_download(services)
    assert result["ok"] is False and result["error"] == "downloads_off"
    assert fetched == [] and events_of(services, "permission_requested") == []


def test_no_answer_is_not_a_yes(services, fetched):
    services.permissions.wait_seconds = 0.05
    result = ask_to_download(services)
    assert result["ok"] is False and result["error"] == "download_unanswered"
    assert fetched == []
    assert events_of(services, "permission_resolved")[0]["answer"] == "expired"


def test_background_work_cannot_download(services, fetched):
    services.set_download_mode("always")
    result = services.tools.download_paper(ADDRESS, run_id=None)
    assert result["ok"] is False and fetched == []


def test_settings_and_answers_over_the_api(client, services):
    assert client.get("/api/settings").json() == {"downloads": "ask"}
    assert client.put("/api/settings", json={"downloads": "always"}).json() == {"downloads": "always"}
    assert client.get("/api/state").json()["settings"] == {"downloads": "always"}
    assert client.put("/api/settings", json={"downloads": "sometimes"}).status_code == 422
    assert client.post("/api/permissions/ask-nothing", json={"answer": "allow"}).status_code == 404


def test_a_setting_is_changed_in_place(project):
    before = project.project_file.read_text()
    project.set_setting("agent", "downloads", "never")
    after = project.project_file.read_text()
    assert after.startswith("# Litmark project settings")
    assert 'backend = "claude"\nauto_summary = true\ndownloads = "never"\n' in after
    project.set_setting("agent", "downloads", "ask")
    assert project.project_file.read_text() == before.replace(
        "auto_summary = true\n", 'auto_summary = true\ndownloads = "ask"\n'
    )
    project.set_setting("other", "key", "value")
    assert tomllib.loads(project.project_file.read_text())["other"] == {"key": "value"}


def test_the_tool_is_not_offered_to_sessions_elsewhere():
    assert "download_paper" not in {schema["name"] for schema in MCP_TOOL_SCHEMAS}


# ---------------------------------------------------------------- the fetch


def test_an_arxiv_abstract_page_becomes_its_pdf():
    assert downloads.normalize("https://arxiv.org/abs/2401.01234v2") == "https://arxiv.org/pdf/2401.01234v2"
    assert downloads.normalize("https://example.org/a.pdf?x=1") == "https://example.org/a.pdf?x=1"


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "ftp://example.org/a.pdf", "https://user:pw@example.org/a.pdf", "nonsense", ""]
)
def test_only_plain_web_addresses(url):
    with pytest.raises(InvalidInput):
        downloads.normalize(url)


@pytest.mark.parametrize(
    ("address", "public"),
    [
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("192.168.1.10", False),
        ("100.75.223.47", False),  # a tailnet address
        ("169.254.169.254", False),
        ("::1", False),
        ("::ffff:127.0.0.1", False),
        ("93.184.216.34", True),
    ],
)
def test_what_counts_as_the_public_internet(address, public):
    assert downloads._is_public(address) is public


def test_this_machine_is_never_fetched_from():
    class Handler(http.server.BaseHTTPRequestHandler):
        hits = 0

        def do_GET(self) -> None:  # noqa: N802
            Handler.hits += 1
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"%PDF-1.4 secret")

        def log_message(self, *args) -> None:
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(InvalidInput, match="public internet"):
            downloads.fetch_pdf(f"http://127.0.0.1:{server.server_port}/a.pdf", max_bytes=1 << 20)
        assert Handler.hits == 0
    finally:
        server.shutdown()
        server.server_close()
