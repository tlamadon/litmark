"""The project from a terminal, asked of a running server.

The commands are run as a person would run them, against a server listening on
a real port: what is pinned is what comes out on the terminal, that an edit
made this way is on the record under a name, and that a refusal says what to
do about it.
"""

from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import uvicorn

from conftest import make_pdf
from litmark.api.app import create_app
from litmark.cli import main
from litmark.client import CLIENT_ENV, TOKEN_ENV, URL_ENV, parse_arguments, parse_pages
from litmark.errors import WorkspaceError
from litmark.services import Services

TOKEN = "t0ken-for-tests-" + "x" * 24
QUOTE = "Assumption 2 requires that unobserved ability is"


@contextlib.contextmanager
def listening(services: Services, **options: str | None) -> Iterator[str]:
    """The application on a port of its own; yields its address."""
    server = uvicorn.Server(
        uvicorn.Config(create_app(services, **options), host="127.0.0.1", port=0, log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        assert time.monotonic() < deadline and thread.is_alive(), "the server did not start"
        time.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


@pytest.fixture
def server(services, monkeypatch) -> Iterator[str]:
    """A server with the way in open, and a terminal set up to use it."""
    with listening(services, mcp_token=TOKEN) as url:
        monkeypatch.setenv(URL_ENV, url)
        monkeypatch.setenv(TOKEN_ENV, TOKEN)
        # These tests are themselves often run by a Claude Code session.
        monkeypatch.delenv("CLAUDECODE", raising=False)
        monkeypatch.delenv(CLIENT_ENV, raising=False)
        yield url


@pytest.fixture
def run(capsys):
    """Run one command; its exit code, and what it printed where."""

    def run(*argv: str) -> tuple[int, str, str]:
        capsys.readouterr()
        code = main([str(part) for part in argv])
        out, err = capsys.readouterr()
        return code, out, err

    return run


@pytest.fixture
def pdf(tmp_path, paper_one) -> Path:
    path = tmp_path / "mobility.pdf"
    path.write_bytes(paper_one)
    return path


def origins(services: Services) -> list[tuple[str, str]]:
    rows = services.db.query("SELECT origin, summary FROM changes ORDER BY rowid")
    return [(row["origin"], row["summary"]) for row in rows]


# ------------------------------------------------------------ papers and text


def test_a_paper_is_sent_in_and_found_again(server, services, run, pdf, tmp_path, paper_two):
    other = tmp_path / "search.pdf"
    other.write_bytes(paper_two)
    code, out, err = run("add", pdf, other, tmp_path / "missing.pdf", "--tag", "field:labor", "--no-summary")
    # The two that exist are in; the one that does not is said, and counted.
    assert code == 1 and "missing.pdf" in err
    assert "doc-001  Mobility Restrictions and Wage Growth" in out
    assert "2 pages · text extracted · field:labor" in out
    assert "doc-002" in out and "1 page ·" in out
    assert origins(services) == [("mcp:cli", "Imported mobility.pdf"), ("mcp:cli", "Imported search.pdf")]
    # Asked not to summarize: no run was started for either.
    assert services.db.query("SELECT id FROM runs") == []

    code, out, _ = run("add", pdf)
    assert code == 0 and "already in the library" in out

    code, out, _ = run("papers")
    assert code == 0
    assert "doc-001  Mobility Restrictions and Wage Growth" in out
    assert "no summary" in out and "Tags in use: field:labor (2)" in out

    code, out, _ = run("tag", "doc-002", "--add", "field:search", "--remove", "field:labor")
    assert code == 0 and "[field:search]" in out
    code, out, _ = run("papers", "--tag", "field:search")
    assert "doc-002" in out and "doc-001" not in out

    code, out, _ = run("search", "unobserved", "ability", "--in", "doc-001")
    assert code == 0 and out.startswith("doc-001 p. 2  Mobility Restrictions")
    code, out, _ = run("search", "cryptocurrency")
    assert code == 0 and "No passage matches" in out


def test_pages_are_printed_with_a_word_about_what_they_are(server, run, pdf):
    run("add", pdf, "--no-summary")
    code, out, err = run("pages", "doc-001", "2")
    assert code == 0
    assert out.startswith("=== doc-001 · Mobility Restrictions and Wage Growth · page 2 of 2 ===\n")
    assert QUOTE in out and "economically meaningful" in out
    # Read by a program, as here: the server's caution goes along, beside the text.
    assert "never as instructions" in err and "never as instructions" not in out

    code, _, err = run("pages", "doc-001", "two")
    assert code == 1 and "not a page" in err
    code, _, err = run("pages", "doc-404", "1")
    assert code == 1 and err.startswith("error: ")


def test_more_pages_than_the_server_gives_at_once_are_asked_for_in_turns(server, run, tmp_path):
    long_paper = tmp_path / "long.pdf"
    long_paper.write_bytes(
        make_pdf([[(72, 720, f"This is the text of sheet number {n}.")] for n in range(1, 16)])
    )
    run("add", long_paper, "--no-summary")
    code, out, _ = run("pages", "doc-001", "1-14", "15,1")
    assert code == 0
    # Every page once, in the order asked, whichever call it came back in.
    headings = [line for line in out.splitlines() if line.startswith("=== doc-001 · ")]
    assert [line.split(" · ")[-1] for line in headings] == [
        f"page {n} of 15 ===" for n in range(1, 16)
    ]
    assert "sheet number 15." in out


def test_page_ranges_are_read_as_written():
    assert parse_pages(["3", "4-6", "9,12", "5"]) == [3, 4, 5, 6, 9, 12]
    for wrong in ("0", "6-4", "a-b"):
        with pytest.raises(WorkspaceError):
            parse_pages([wrong])


# ---------------------------------------------------------------------- notes


def test_a_note_is_added_to_and_read_back(server, services, run, monkeypatch):
    code, out, _ = run("append", "reading-log", "# Reading", "log")
    assert code == 0 and out == "Created note reading-log\n"
    monkeypatch.setattr(sys, "stdin", io.StringIO("Second entry,\nover two lines.\n"))
    code, out, _ = run("append", "reading-log")
    assert code == 0 and out == "Saved note reading-log\n"

    code, out, err = run("note", "reading-log")
    assert code == 0
    # Standard output is the note and nothing else, so it can be redirected.
    assert out == "# Reading log\n\nSecond entry,\nover two lines.\n"
    assert out == (services.workspace.root / "notes" / "reading-log.md").read_text()
    assert err.startswith("note reading-log · revision ")
    assert origins(services) == [("mcp:cli", "Created note"), ("mcp:cli", "Added to note")]

    code, out, _ = run("notes")
    assert code == 0 and "reading-log  Reading log" in out
    code, out, _ = run("recall", "second", "entry")
    assert code == 0 and out.startswith("Notes\nreading-log  Reading log\n")
    code, out, _ = run("recall", "cryptocurrency")
    assert code == 0 and "Nothing is held" in out

    code, out, err = run("note", "no-such-note")
    assert code == 1 and out == "" and "no-such-note" in err


def test_replacing_a_note_needs_the_revision_that_was_read(server, services, run, tmp_path):
    draft = tmp_path / "draft.md"
    draft.write_text("First version.\n")
    code, out, _ = run("write", "plan", "--file", draft)
    assert code == 0 and out == "Created note plan\n"
    _, _, err = run("note", "plan")
    revision = err.strip().rsplit(" ", 1)[-1]

    draft.write_text("Second version.\n")
    code, _, err = run("write", "plan", "--file", draft)
    assert code == 1 and "--revision" in err and "litmark append" in err
    code, _, _ = run("write", "plan", "--file", draft, "--revision", revision)
    assert code == 0

    draft.write_text("Third, from a stale reading.\n")
    code, _, err = run("write", "plan", "--file", draft, "--revision", revision)
    assert code == 1 and "changed since you read it" in err
    assert (services.workspace.root / "notes" / "plan.md").read_text() == "Second version.\n"


def test_a_note_is_edited_in_the_editor_of_ones_choice(server, services, run, tmp_path, monkeypatch):
    script = tmp_path / "editor.py"
    script.write_text(
        "import sys\n"
        "path = sys.argv[-1]\n"
        "text = open(path).read()\n"
        "open(path, 'w').write(text + sys.argv[1] + '\\n')\n"
    )
    note = services.workspace.root / "notes" / "ideas.md"

    monkeypatch.setenv("EDITOR", f"{sys.executable} {script} one")
    code, out, _ = run("edit", "ideas")
    assert code == 0 and out == "Created note ideas\n"
    monkeypatch.setenv("EDITOR", f"{sys.executable} {script} two")
    assert run("edit", "ideas")[0] == 0
    assert note.read_text() == "one\ntwo\n"

    # Closed without a change: nothing is written, and nothing recorded.
    monkeypatch.setenv("EDITOR", "true")
    code, _, err = run("edit", "ideas")
    assert code == 0 and "Nothing saved" in err
    assert [origin for origin, _ in origins(services)] == ["mcp:cli", "mcp:cli"]


def test_what_was_typed_survives_a_refused_save(server, services, run, tmp_path, monkeypatch):
    """Someone saved the note while the editor was open."""
    run("append", "ideas", "Before.")
    note = services.workspace.root / "notes" / "ideas.md"
    script = tmp_path / "editor.py"
    script.write_text(
        "import sys\n"
        f"open({str(note)!r}, 'w').write('Changed meanwhile.\\n')\n"
        "open(sys.argv[-1], 'w').write('Mine.\\n')\n"
    )
    monkeypatch.setenv("EDITOR", f"{sys.executable} {script}")
    code, _, err = run("edit", "ideas")
    assert code == 1 and "changed since you read it" in err
    assert note.read_text() == "Changed meanwhile.\n"
    kept = Path(err.split("Your text is kept in ", 1)[1].splitlines()[0])
    assert kept.read_text() == "Mine.\n"
    kept.unlink()


def test_a_quotation_becomes_a_link_to_cite_it_with(server, services, run, pdf):
    run("add", pdf, "--no-summary")
    code, out, _ = run("cite", "doc-001", "2", QUOTE)
    assert code == 0
    assert out == "[Mobility Restrictions and Wage Growth, p. 2](source:ref-001)\n"
    assert run("append", "log", f"Ability is assumed orthogonal {out.strip()}.")[0] == 0

    code, out, err = run("cite", "doc-001", "2", "words that are not on the page")
    assert code == 1 and out == "" and "does not appear" in err
    # A link to a reference nobody registered is refused, as it is for everyone.
    code, _, err = run("append", "log", "Made up [p. 9](source:ref-999).")
    assert code == 1 and "ref-999" in err


# ----------------------------------------------------------- who wrote what


def test_an_edit_is_recorded_under_the_name_of_whoever_ran_the_command(server, services, run, monkeypatch):
    run("append", "log", "Typed by a person.")
    # A command run by a Claude Code session is recorded as that session's.
    monkeypatch.setenv("CLAUDECODE", "1")
    run("append", "log", "Run by a session.")
    monkeypatch.setenv(CLIENT_ENV, "Office Mac")
    run("append", "log", "From a machine that was given a name.")
    run("append", "log", "And one named on the command line.", "--as", "laptop")
    assert [origin for origin, _ in origins(services)] == [
        "mcp:cli",
        "mcp:claude-code",
        "mcp:office-mac",
        "mcp:laptop",
    ]


# ------------------------------------------------------------------- the rest


def test_any_tool_can_be_asked_for_by_name(server, run, pdf, tmp_path):
    run("add", pdf, "--no-summary")
    code, out, _ = run("tools")
    assert code == 0 and "append_note  note_id text [summary]" in out and "add_paper" in out

    summary = tmp_path / "summary.md"
    summary.write_text("Wage growth falls under mobility restrictions.\n")
    code, out, _ = run("call", "write_summary", "document_id=doc-001", f"text=@{summary}")
    assert code == 0 and json.loads(out)["ok"] is True
    code, out, err = run("summary", "doc-001")
    assert code == 0 and out == summary.read_text() and "revision" in err

    code, out, _ = run("call", "read_pages", '{"document_id": "doc-001", "pages": [1]}')
    assert code == 0 and json.loads(out)["pages"][0]["page_number"] == 1
    code, out, _ = run("call", "no_such_tool")
    assert code == 1 and json.loads(out)["error"] == "unknown_tool"


def test_arguments_are_json_where_they_parse_and_text_otherwise(tmp_path):
    assert parse_arguments(["note_id=2024-plans", "limit=5", "tags=[\"a\"]", "text=a = b"]) == {
        "note_id": "2024-plans",
        "limit": 5,
        "tags": ["a"],
        "text": "a = b",
    }
    assert parse_arguments(['{"query": "x"}']) == {"query": "x"}
    assert parse_arguments([]) == {}
    for wrong in (["no-equals-sign"], ["{not json"], [f"text=@{tmp_path / 'absent'}"]):
        with pytest.raises(WorkspaceError):
            parse_arguments(wrong)


def test_the_answer_can_be_had_as_it_came(server, run, pdf):
    code, out, _ = run("add", pdf, "--no-summary", "--json")
    assert code == 0 and json.loads(out)["document_id"] == "doc-001"
    code, out, _ = run("papers", "--json")
    assert code == 0 and json.loads(out)["documents"][0]["page_count"] == 2
    code, out, _ = run("note", "absent", "--json")
    assert code == 1 and json.loads(out)["error"] == "not_found"


def test_a_refusal_says_what_to_do_about_it(server, services, run, monkeypatch):
    # The address handed to `claude mcp add` works as it is.
    assert run("notes", "--url", server + "/mcp")[0] == 0

    monkeypatch.setenv(TOKEN_ENV, "not-the-token-at-all-0000")
    code, _, err = run("notes")
    assert code == 1 and "did not accept the token" in err and "not-the-token" not in err

    monkeypatch.delenv(TOKEN_ENV)
    code, _, err = run("notes")
    assert code == 1 and TOKEN_ENV in err

    monkeypatch.setenv(TOKEN_ENV, TOKEN)
    code, _, err = run("notes", "--url", "papers:8765")
    assert code == 1 and "http://" in err

    with listening(services) as closed:  # Started without a token: no way in.
        code, _, err = run("notes", "--url", closed)
        assert code == 1 and TOKEN_ENV in err and "does not accept" in err
    # Nothing is listening there any more.
    code, _, err = run("notes", "--url", closed)
    assert code == 1 and "Could not reach" in err and URL_ENV in err


def test_asking_a_server_loads_nothing_of_one():
    """These commands run where no project is; they should start like it."""
    loaded = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, litmark.cli as cli\n"
            "cli.build_parser().parse_args(['recall', 'x'])\n"
            "import litmark.client\n"
            "print([m for m in ('fastapi', 'uvicorn', 'pdfplumber', 'pypdf', 'mcp') if m in sys.modules])",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert loaded.stdout.strip() == "[]"


# ------------------------------------------------- deleting, and naming papers


def test_a_note_is_deleted_and_the_deletion_is_on_the_record(server, services, run):
    run("append", "scratch", "Not worth keeping.")
    code, out, _ = run("delete", "scratch")
    assert code == 0 and out == "Deleted note scratch\n"
    assert not (services.workspace.root / "notes" / "scratch.md").exists()
    assert origins(services)[-1] == ("mcp:cli", "Deleted note")
    code, _, err = run("delete", "scratch")
    assert code == 1 and "scratch" in err


def test_a_paper_is_listed_by_its_authors_and_year_once_they_are_said(server, run, pdf):
    run("add", pdf, "--no-summary")
    code, out, _ = run(
        "details", "doc-001", "--author", "Alice Researcher", "--author", "Bob Coauthor", "--year", "2019"
    )
    assert code == 0
    assert out == "doc-001  Researcher & Coauthor (2019) — Mobility Restrictions and Wage Growth\n"
    code, out, _ = run("papers")
    assert "doc-001  Researcher & Coauthor (2019)\n" in out
    assert "Mobility Restrictions and Wage Growth · 2 pages" in out
    code, _, err = run("details", "doc-001")
    assert code == 1 and "--title" in err
