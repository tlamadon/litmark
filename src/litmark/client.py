"""The project from a terminal: commands that ask a running server.

`litmark serve` runs where the project lives; these run wherever you happen to
be working, and reach it the way a session elsewhere does — the MCP endpoint,
with the same token. So a command here is one tool call, and what it writes is
recorded, attributed and undoable exactly as that session's would be.

    export LITMARK_URL=http://papers:8765
    export LITMARK_MCP_TOKEN=…
    litmark recall minimum wage
    litmark add ~/Downloads/card-krueger.pdf --tag field:labor
    litmark append reading-log "Card and Krueger: no employment effect."

Nothing but the standard library is used, and nothing of the server is
imported: the endpoint answers plain JSON to a plain POST.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import __version__
from .errors import WorkspaceError

URL_ENV = "LITMARK_URL"
# Named here rather than imported: the server's module is not needed to ask it.
TOKEN_ENV = "LITMARK_MCP_TOKEN"
CLIENT_ENV = "LITMARK_CLIENT"
DEFAULT_URL = "http://127.0.0.1:8765"
MCP_PATH = "/mcp"
CALL_TIMEOUT = 60.0
DEFAULT_UPLOAD_WAIT = 60.0
# What the server gives in one `read_pages`; more is asked for in turns.
PAGES_PER_CALL = 12


class ClientError(WorkspaceError):
    """The server could not be asked, or did not answer as one would."""

    code = "client_error"


# ---------------------------------------------------------------- the server


def _request(
    method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float
) -> tuple[int, bytes]:
    """One HTTP exchange: the status and the body, whatever the status."""
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise ClientError(
            f"Could not reach Litmark at {_origin_of(url)} ({reason}). "
            f"Is it running there? Set {URL_ENV}, or pass --url."
        ) from exc


def _origin_of(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def default_client() -> str:
    """The name edits from here are recorded under, unless one is given.

    A command run by a Claude Code session is that session's doing, and is
    recorded as it would be had the session used MCP directly; one typed by a
    person is the command line's.
    """
    named = (os.environ.get(CLIENT_ENV) or "").strip()
    if named:
        return named
    return "claude-code" if os.environ.get("CLAUDECODE") else "cli"


@dataclass
class Server:
    """A running Litmark, asked one tool call at a time."""

    url: str
    token: str
    client: str

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> Server:
        url = (args.url or os.environ.get(URL_ENV) or DEFAULT_URL).strip().rstrip("/")
        # The address given to `claude mcp add` ends in /mcp; take that too.
        url = url.removesuffix(MCP_PATH)
        if not url.startswith(("http://", "https://")):
            raise ClientError(
                f"{url!r} is not an address this can use; it should look like "
                "http://papers:8765."
            )
        token = (os.environ.get(TOKEN_ENV) or "").strip()
        if not token:
            raise ClientError(
                f"No access token. Set {TOKEN_ENV} to the token the server was "
                "started with (it is read from the environment, never from the "
                "command line)."
            )
        return cls(url=url, token=token, client=args.client or default_client())

    def _headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {self.token}",
            "user-agent": f"litmark-cli/{__version__}",
            "x-litmark-client": self.client,
        }

    def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        status, body = _request(
            "POST",
            self.url + MCP_PATH,
            {
                **self._headers(),
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
            },
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
            CALL_TIMEOUT,
        )
        answer = _json(body)
        if status == 401:
            raise ClientError(
                f"Litmark at {self.url} did not accept the token in {TOKEN_ENV}."
            )
        error = answer.get("error") if isinstance(answer, dict) else None
        if isinstance(error, dict):
            raise ClientError(str(error.get("message") or error))
        if status != 200 or not isinstance(answer, dict) or "result" not in answer:
            raise ClientError(
                f"{self.url} answered {status}, and not as Litmark does. Is that "
                "the right address, and is the server recent enough to serve MCP?"
            )
        return answer["result"]

    def call(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """One tool call. The tool's own refusals come back as `ok: False`."""
        result = self._rpc("tools/call", {"name": name, "arguments": arguments or {}})
        text = "".join(
            part.get("text", "") for part in result.get("content") or [] if isinstance(part, dict)
        )
        payload = _json(text.encode())
        if not isinstance(payload, dict):
            # Not one of the project's tools speaking: the protocol's own refusal.
            return {"ok": False, "error": "tool_failed", "message": text.strip() or "No answer."}
        if result.get("isError") and "ok" not in payload:
            payload["ok"] = False
        return payload

    def tools(self) -> list[dict[str, Any]]:
        return list(self._rpc("tools/list", {}).get("tools") or [])

    def upload(self, address: str, data: bytes, wait: float) -> tuple[int, dict[str, Any]]:
        """Send a PDF to the one-time address `add_paper` gave out."""
        # The address is built from how the request reached the server, which a
        # proxy can change; its path is what matters, at the address used here.
        path = urllib.parse.urlsplit(address).path
        status, body = _request(
            "PUT",
            f"{self.url}{path}?wait={wait:g}",
            # No token: the address is its own credential, and asks for no other.
            {"user-agent": f"litmark-cli/{__version__}", "content-type": "application/pdf"},
            data,
            wait + CALL_TIMEOUT,
        )
        answer = _json(body)
        return status, answer if isinstance(answer, dict) else {}


def _json(body: bytes) -> Any:
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


# ------------------------------------------------------------------ commands


def add_commands(sub: Any) -> None:
    """Register the commands that ask a running server."""
    common = argparse.ArgumentParser(add_help=False)
    group = common.add_argument_group(
        "the server",
        f"Which Litmark to ask. The access token is read from {TOKEN_ENV}.",
    )
    group.add_argument(
        "--url",
        metavar="URL",
        help=f"Where it is served (default: ${URL_ENV}, else {DEFAULT_URL}).",
    )
    group.add_argument(
        "--as",
        dest="client",
        metavar="NAME",
        help=f"The name edits are recorded under (default: ${CLIENT_ENV}, else 'cli').",
    )
    group.add_argument(
        "--json", action="store_true", help="Print the server's answer as JSON."
    )

    def command(name: str, help_text: str, **kwargs: Any) -> argparse.ArgumentParser:
        return sub.add_parser(name, help=help_text, parents=[common], **kwargs)

    def tags(parser: argparse.ArgumentParser, what: str) -> None:
        parser.add_argument(
            "--tag", action="append", default=[], metavar="TAG", help=f"{what} Repeatable."
        )

    recall = command("recall", "Find what the project holds: notes, summaries, passages.")
    recall.add_argument("query", nargs="+", help="A few words; every one must occur.")
    tags(recall, "Only papers carrying this tag (leaves notes out).")
    recall.add_argument("--limit", type=int, help="Most results of each kind (default 8).")

    papers = command("papers", "List the papers, with their IDs and tags.")
    tags(papers, "Only papers carrying this tag.")

    search = command("search", "Search the papers' text for a passage.")
    search.add_argument("query", nargs="+")
    search.add_argument(
        "--in", dest="documents", action="append", default=[], metavar="DOC",
        help="Only this paper. Repeatable.",
    )
    tags(search, "Only papers carrying this tag.")
    search.add_argument("--limit", type=int, help="Most matches (default 20).")

    pages = command("pages", "Print pages of a paper's extracted text.")
    pages.add_argument("document", metavar="DOC", help="A document ID, as `papers` lists them.")
    pages.add_argument("pages", nargs="+", metavar="PAGES", help="For example: 3  4-6  9,12")

    summary = command("summary", "Print a paper's summary.")
    summary.add_argument("document", metavar="DOC")

    command("notes", "List the notes.")

    note = command("note", "Print a note.")
    note.add_argument("note", metavar="NOTE", help="A note ID, as `notes` lists them.")

    append = command("append", "Add to the end of a note, creating it if need be.")
    append.add_argument("note", metavar="NOTE")
    append.add_argument("text", nargs="*", help="What to add; read from standard input if absent.")

    write = command("write", "Replace a note's text with standard input (or a file).")
    write.add_argument("note", metavar="NOTE")
    write.add_argument("--file", type=Path, help="Read the text from here instead.")
    write.add_argument(
        "--revision",
        help="The revision you read, as `note` reports it. Needed to replace an existing note.",
    )

    edit = command("edit", "Open a note in $EDITOR and save it back.")
    edit.add_argument("note", metavar="NOTE")

    add = command("add", "Send PDFs to the library.")
    add.add_argument("files", nargs="+", type=Path, metavar="PDF")
    tags(add, "A tag to give them.")
    add.add_argument(
        "--no-summary", action="store_true", help="Do not have Litmark summarize them."
    )
    add.add_argument(
        "--wait",
        type=float,
        default=DEFAULT_UPLOAD_WAIT,
        metavar="SECONDS",
        help="How long to wait for the text to be extracted (default 60).",
    )

    tag = command("tag", "Add tags to papers, or remove them.")
    tag.add_argument("documents", nargs="+", metavar="DOC")
    tag.add_argument("--add", action="append", default=[], metavar="TAG")
    tag.add_argument("--remove", action="append", default=[], metavar="TAG")

    cite = command("cite", "Register a quotation as a source, and print the link to cite it.")
    cite.add_argument("document", metavar="DOC")
    cite.add_argument("page", type=int, help="The page it is on, counted from 1.")
    cite.add_argument("quote", nargs="?", help="The words, verbatim.")
    cite.add_argument("--prefix", help="What comes just before, if the words occur twice.")
    cite.add_argument("--suffix", help="What comes just after.")
    cite.add_argument(
        "--page-only", action="store_true", help="Cite the page if the words are not found."
    )

    command("tools", "List everything the server can be asked.")

    call = command(
        "call",
        "Ask for any tool by name.",
        description=(
            "Call a tool directly. Arguments are a JSON object, `-` to read one "
            "from standard input, or key=value pairs: a value is taken as JSON "
            "where it parses and as text otherwise, and `key=@path` takes the "
            "text of a file."
        ),
    )
    call.add_argument("tool")
    call.add_argument("arguments", nargs="*")


def run(args: argparse.Namespace) -> int:
    handler = COMMANDS[args.command]
    return handler(Server.from_args(args), args)


def _finish(args: argparse.Namespace, payload: dict[str, Any], show: Any) -> int:
    """Print an answer — as it came with --json — and say whether it was a refusal."""
    refused = payload.get("ok") is False
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    elif refused:
        print(f"error: {payload.get('message') or payload.get('error')}", file=sys.stderr)
    else:
        show(payload)
        _caution(payload)
    return 1 if refused else 0


def _caution(payload: dict[str, Any]) -> None:
    """Pass on the server's word about what was returned, to a program reading it.

    Text out of a PDF is evidence and never instruction, and the server says so
    with each answer that carries some. A person at a terminal does not need
    telling every time; whatever else reads this output does.
    """
    note = payload.get("note")
    if note and not sys.stdout.isatty():
        sys.stdout.flush()  # So the word comes after what it is about.
        print(f"\nnote: {note}", file=sys.stderr)


def cmd_recall(server: Server, args: argparse.Namespace) -> int:
    arguments: dict[str, Any] = {"query": " ".join(args.query)}
    if args.tag:
        arguments["tags"] = args.tag
    if args.limit:
        arguments["limit"] = args.limit
    return _finish(args, server.call("recall", arguments), _show_recall)


def cmd_papers(server: Server, args: argparse.Namespace) -> int:
    arguments = {"tags": args.tag} if args.tag else {}
    return _finish(args, server.call("list_documents", arguments), _show_papers)


def cmd_search(server: Server, args: argparse.Namespace) -> int:
    arguments: dict[str, Any] = {"query": " ".join(args.query)}
    if args.documents:
        arguments["document_ids"] = args.documents
    if args.tag:
        arguments["tags"] = args.tag
    if args.limit:
        arguments["limit"] = args.limit

    def show(payload: dict[str, Any]) -> None:
        if not payload["matches"]:
            print(f"No passage matches “{payload['query']}”.")
        for match in payload["matches"]:
            _show_passage(match)

    return _finish(args, server.call("search_documents", arguments), show)


def cmd_pages(server: Server, args: argparse.Namespace) -> int:
    numbers = parse_pages(args.pages)
    if not numbers:
        raise ClientError("Which pages? For example: 3  4-6  9,12")
    payload: dict[str, Any] = {}
    for start in range(0, len(numbers), PAGES_PER_CALL):
        part = server.call(
            "read_pages",
            {"document_id": args.document, "pages": numbers[start : start + PAGES_PER_CALL]},
        )
        if part.get("ok") is False:
            return _finish(args, part, _show_pages)
        if payload:
            payload["pages"].extend(part["pages"])
        else:
            payload = part
    payload["truncated"] = False
    return _finish(args, payload, _show_pages)


def cmd_summary(server: Server, args: argparse.Namespace) -> int:
    def show(payload: dict[str, Any]) -> None:
        if not payload.get("exists"):
            print(f"{payload['document_id']} has no summary yet.", file=sys.stderr)
            return
        _print_text(payload["text"])
        print(f"summary of {payload['document_id']} · revision {payload['revision']}", file=sys.stderr)

    return _finish(args, server.call("read_summary", {"document_id": args.document}), show)


def cmd_notes(server: Server, args: argparse.Namespace) -> int:
    def show(payload: dict[str, Any]) -> None:
        notes = payload["notes"]
        if not notes:
            print("No notes yet.")
        width = max((len(note["note_id"]) for note in notes), default=0)
        for note in notes:
            print(f"{note['note_id']:<{width}}  {note['title']}")

    return _finish(args, server.call("list_notes"), show)


def cmd_note(server: Server, args: argparse.Namespace) -> int:
    def show(payload: dict[str, Any]) -> None:
        _print_text(payload["text"])
        # Beside the text, not in it: `litmark note x > x.md` is the note.
        print(f"note {payload['note_id']} · revision {payload['revision']}", file=sys.stderr)

    return _finish(args, server.call("read_note", {"note_id": args.note}), show)


def cmd_append(server: Server, args: argparse.Namespace) -> int:
    text = " ".join(args.text) if args.text and args.text != ["-"] else _read_stdin()
    return _finish(
        args, server.call("append_note", {"note_id": args.note, "text": text}), _show_saved
    )


def cmd_write(server: Server, args: argparse.Namespace) -> int:
    text = args.file.read_text(encoding="utf-8") if args.file else _read_stdin()
    arguments: dict[str, Any] = {"note_id": args.note, "text": text}
    if args.revision:
        arguments["expected_revision"] = args.revision
    saved = server.call("write_note", arguments)
    if saved.get("error") == "revision_conflict" and not args.revision:
        # Nothing was read, so "it changed since you read it" would mislead.
        saved["message"] = (
            f"There is already a note {args.note!r}, and replacing it needs the "
            f"revision you read: `litmark note {args.note}` reports it, to pass as "
            "--revision. To add to the note instead, use `litmark append`."
        )
    return _finish(args, saved, _show_saved)


def cmd_edit(server: Server, args: argparse.Namespace) -> int:
    current = server.call("read_note", {"note_id": args.note})
    if current.get("ok") is False and current.get("error") != "not_found":
        return _finish(args, current, _show_saved)
    before = current.get("text") or ""
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR") or "vi"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", prefix=f"litmark-{args.note}-", suffix=".md", delete=False
    ) as handle:
        handle.write(before)
        draft = Path(handle.name)
    try:
        code = subprocess.call([*shlex.split(editor), str(draft)])
    except OSError as exc:
        draft.unlink(missing_ok=True)
        raise ClientError(f"Could not start the editor {editor!r} ({exc}). Set $EDITOR.") from exc
    after = draft.read_text(encoding="utf-8")
    if code != 0 or after == before or not after.strip():
        draft.unlink(missing_ok=True)
        print("Nothing saved.", file=sys.stderr)
        return 0 if code == 0 else 1
    arguments: dict[str, Any] = {"note_id": args.note, "text": after}
    if current.get("revision"):
        arguments["expected_revision"] = current["revision"]
    saved = server.call("write_note", arguments)
    if saved.get("ok") is False:
        # What was typed is not thrown away with the refusal.
        print(f"Your text is kept in {draft}", file=sys.stderr)
    else:
        draft.unlink(missing_ok=True)
    return _finish(args, saved, _show_saved)


def cmd_add(server: Server, args: argparse.Namespace) -> int:
    failed = 0
    answers: list[dict[str, Any]] = []
    for path in args.files:
        answer = _send_paper(server, path, args)
        answers.append({"file": str(path), **answer})
        if args.json:
            pass
        elif answer.get("ok"):
            _show_added(answer)
        else:
            print(f"error: {path}: {answer.get('message')}", file=sys.stderr)
        failed += not answer.get("ok")
    if args.json:
        print(json.dumps(answers if len(answers) > 1 else answers[0], ensure_ascii=False, indent=2))
    return 1 if failed else 0


def _send_paper(server: Server, path: Path, args: argparse.Namespace) -> dict[str, Any]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        return {"ok": False, "message": f"could not be read ({exc.strerror or exc})"}
    arguments: dict[str, Any] = {"filename": path.name, "summarize": not args.no_summary}
    if args.tag:
        arguments["tags"] = args.tag
    ticket = server.call("add_paper", arguments)
    if ticket.get("ok") is False or "upload_url" not in ticket:
        return {"ok": False, "message": ticket.get("message") or "no upload address was given"}
    status, answer = server.upload(ticket["upload_url"], data, args.wait)
    if status not in (200, 201) or not answer.get("ok"):
        error = answer.get("error")
        message = error.get("message") if isinstance(error, dict) else None
        return {"ok": False, "message": message or f"the upload was answered with {status}"}
    return answer


def cmd_tag(server: Server, args: argparse.Namespace) -> int:
    if not args.add and not args.remove:
        raise ClientError("Nothing to change: give --add TAG or --remove TAG.")

    def show(payload: dict[str, Any]) -> None:
        for document in payload["documents"]:
            print(f"{document['document_id']}  {document['title']}{_tag_list(document['tags'])}")

    return _finish(
        args,
        server.call(
            "tag_documents",
            {"document_ids": args.documents, "add": args.add, "remove": args.remove},
        ),
        show,
    )


def cmd_cite(server: Server, args: argparse.Namespace) -> int:
    arguments: dict[str, Any] = {"document_id": args.document, "page_number": args.page}
    for key, value in (("quote", args.quote), ("prefix", args.prefix), ("suffix", args.suffix)):
        if value:
            arguments[key] = value
    if args.page_only:
        arguments["allow_page_only"] = True
    payload = server.call("resolve_source", arguments)
    # A quotation that was not found is an answer to the tool, and a failure here.
    if "ok" not in payload and "reference_id" not in payload:
        payload["ok"] = False

    def show(payload: dict[str, Any]) -> None:
        reference = payload["reference_id"]
        print(payload.get("markdown_example") or f"[p. {args.page}](source:{reference})")
        if payload.get("status") != "resolved":
            print(payload.get("message", ""), file=sys.stderr)

    code = _finish(args, payload, show)
    if code and not args.json:
        for candidate in payload.get("candidates") or []:
            print(f"  candidate: {json.dumps(candidate, ensure_ascii=False)}", file=sys.stderr)
    return code


def cmd_tools(server: Server, args: argparse.Namespace) -> int:
    tools = server.tools()
    if args.json:
        print(json.dumps(tools, ensure_ascii=False, indent=2))
        return 0
    for tool in tools:
        schema = tool.get("inputSchema") or {}
        required = set(schema.get("required") or [])
        names = [
            name if name in required else f"[{name}]" for name in schema.get("properties") or {}
        ]
        print(f"{tool['name']}  {' '.join(names)}".rstrip())
        print(_wrapped(tool.get("description") or "", indent=4))
    return 0


def cmd_call(server: Server, args: argparse.Namespace) -> int:
    payload = server.call(args.tool, parse_arguments(args.arguments))
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    _caution(payload)
    return 1 if payload.get("ok") is False else 0


COMMANDS = {
    "recall": cmd_recall,
    "papers": cmd_papers,
    "search": cmd_search,
    "pages": cmd_pages,
    "summary": cmd_summary,
    "notes": cmd_notes,
    "note": cmd_note,
    "append": cmd_append,
    "write": cmd_write,
    "edit": cmd_edit,
    "add": cmd_add,
    "tag": cmd_tag,
    "cite": cmd_cite,
    "tools": cmd_tools,
    "call": cmd_call,
}


# ------------------------------------------------------------------- reading


def parse_pages(specs: list[str]) -> list[int]:
    """`3`, `4-6`, `9,12` — in the order asked, each page once."""
    numbers: list[int] = []
    for spec in specs:
        for part in spec.split(","):
            part = part.strip()
            if not part:
                continue
            first, dash, last = part.partition("-")
            try:
                low = int(first)
                high = int(last) if dash else low
            except ValueError:
                raise ClientError(f"{part!r} is not a page or a range of pages (3, 4-6).") from None
            if low < 1 or high < low:
                raise ClientError(f"{part!r} is not a range of pages: pages count from 1.")
            numbers.extend(range(low, high + 1))
    return list(dict.fromkeys(numbers))


def parse_arguments(items: list[str]) -> dict[str, Any]:
    """A tool's arguments from the command line: JSON, or key=value pairs."""
    if items == ["-"]:
        items = [sys.stdin.read()]
    if len(items) == 1 and items[0].lstrip().startswith("{"):
        try:
            arguments = json.loads(items[0])
        except ValueError as exc:
            raise ClientError(f"The arguments are not valid JSON: {exc}") from None
        if not isinstance(arguments, dict):
            raise ClientError("The arguments must be a JSON object.")
        return arguments
    arguments = {}
    for item in items:
        key, equals, value = item.partition("=")
        if not equals or not key:
            raise ClientError(f"{item!r} is not key=value; or give one JSON object.")
        if value.startswith("@"):
            try:
                arguments[key] = Path(value[1:]).expanduser().read_text(encoding="utf-8")
            except OSError as exc:
                raise ClientError(f"{value[1:]} could not be read ({exc.strerror or exc}).") from None
            continue
        try:
            arguments[key] = json.loads(value)
        except ValueError:
            arguments[key] = value
    return arguments


def _read_stdin() -> str:
    if sys.stdin.isatty():
        print("Reading from the terminal; finish with Ctrl-D.", file=sys.stderr)
    return sys.stdin.read()


# ------------------------------------------------------------------- showing


def _width() -> int:
    return max(40, min(shutil.get_terminal_size((100, 24)).columns, 100))


def _wrapped(text: str, *, indent: int) -> str:
    pad = " " * indent
    return textwrap.fill(
        " ".join(text.split()), width=_width(), initial_indent=pad, subsequent_indent=pad
    )


def _tag_list(tags: list[str]) -> str:
    return f"  [{', '.join(tags)}]" if tags else ""


def _page_count(count: int | None) -> str | None:
    return f"{count} {'page' if count == 1 else 'pages'}" if count else None


def _print_text(text: str) -> None:
    print(text, end="" if text.endswith("\n") else "\n")


def _show_passage(match: dict[str, Any]) -> None:
    print(f"{match['document_id']} p. {match['page_number']}  {match['document_title']}")
    print(_wrapped(match.get("snippet") or match.get("quote") or "", indent=4))


def _show_recall(payload: dict[str, Any]) -> None:
    if not payload["count"]:
        print(f"Nothing is held on “{payload['query']}”.")
        return
    sections = 0

    def heading(title: str) -> None:
        nonlocal sections
        print(("\n" if sections else "") + title)
        sections += 1

    if payload["notes"]:
        heading("Notes")
        for note in payload["notes"]:
            print(f"{note['note_id']}  {note['title']}")
            for excerpt in note["excerpts"]:
                print(_wrapped(excerpt, indent=4))
    if payload["summaries"]:
        heading("Summaries")
        for summary in payload["summaries"]:
            print(f"{summary['document_id']}  {summary['title']}{_tag_list(summary['tags'])}")
            for excerpt in summary["excerpts"]:
                print(_wrapped(excerpt, indent=4))
    if payload["passages"]:
        heading("Passages")
        for match in payload["passages"]:
            _show_passage(match)


def _show_papers(payload: dict[str, Any]) -> None:
    documents = payload["documents"]
    if not documents:
        print("No papers." if not payload["tags_in_use"] else "No papers carry those tags.")
    width = max((len(document["document_id"]) for document in documents), default=0)
    for document in documents:
        print(f"{document['document_id']:<{width}}  {document['title']}")
        facts = [document.get("authors"), document.get("year")]
        facts.append(_page_count(document.get("page_count")))
        facts.append(", ".join(document["tags"]))
        if document.get("extraction_status") != "ok":
            facts.append(f"text: {document.get('extraction_status') or 'pending'}")
        elif not document.get("searchable"):
            facts.append("no text could be extracted")
        if not document.get("has_summary"):
            facts.append("no summary")
        line = " · ".join(str(fact) for fact in facts if fact)
        if line:
            print(f"{'':<{width}}  {line}")
    if payload["tags_in_use"]:
        in_use = ", ".join(f"{entry['tag']} ({entry['count']})" for entry in payload["tags_in_use"])
        print(f"\nTags in use: {in_use}")


def _show_pages(payload: dict[str, Any]) -> None:
    for page in payload["pages"]:
        number = page["page_number"]
        label = page.get("page_label")
        labelled = f" (labelled {label})" if label and str(label) != str(number) else ""
        print(
            f"=== {payload['document_id']} · {payload['document_title']} · "
            f"page {number} of {payload['page_count']}{labelled} ==="
        )
        if page.get("error"):
            print(page["error"])
            continue
        for warning in page.get("warnings") or []:
            print(f"warning: {warning}")
        _print_text(page["text"])
        print()


def _show_saved(payload: dict[str, Any]) -> None:
    what = "Created" if payload.get("created") else "Saved"
    print(f"{what} note {payload['note_id']}")


def _show_added(answer: dict[str, Any]) -> None:
    pages = _page_count(answer.get("page_count"))
    state = {
        "ok": "text extracted",
        "failed": "text could not be extracted",
    }.get(answer.get("extraction_status") or "", "text still being extracted")
    facts = [
        "already in the library" if answer.get("duplicate") else None,
        pages,
        state,
        ", ".join(answer.get("tags") or []),
    ]
    print(f"{answer['document_id']}  {answer.get('title') or ''}".rstrip())
    print("    " + " · ".join(fact for fact in facts if fact))
    for warning in answer.get("extraction_warnings") or []:
        print(f"    warning: {warning}")
