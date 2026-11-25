"""Fetching a paper from the web, when the reader allows it.

The agent may be given an address — an arXiv page, a working paper on an
author's site — and asked to put the paper in the library. Whether it may
fetch it is the reader's to say: ``always``, ``ask`` (the default: each
download waits for a yes in the conversation), or ``never``.

Fetching an address named by an agent that reads untrusted text is a way out
of the machine, so it is narrow. Only ``http`` and ``https``; only hosts on the
public internet, checked on the connection actually made, at every redirect —
never this machine, the local network, or a private one such as a tailnet; only
a PDF, up to the size an upload may be. No proxy is used and nothing is sent
but the request.
"""

from __future__ import annotations

import http.client
import ipaddress
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from email.message import Message
from typing import Any

from . import __version__
from .errors import InvalidInput

ALWAYS = "always"
ASK = "ask"
NEVER = "never"
MODES = (ALWAYS, ASK, NEVER)
DEFAULT_MODE = ASK

# What the reader can answer a request with, and what it can come to without them.
ALLOW = "allow"
ALLOW_ALWAYS = "always"
DENY = "deny"
EXPIRED = "expired"
STOPPED = "stopped"
ANSWERS = (ALLOW, ALLOW_ALWAYS, DENY)

# How long a request waits for the reader before the agent is told to move on.
ASK_SECONDS = 600.0
FETCH_SECONDS = 60.0
MAX_REDIRECTS = 5
CHUNK = 64 * 1024
USER_AGENT = f"litmark/{__version__}"

_ARXIV_ABS = re.compile(r"^/abs/(?P<id>[^?#]+?)(?:\.pdf)?/?$")


def mode_of(settings: dict[str, Any]) -> str:
    """The download setting of a project: ``[agent] downloads`` in project.toml."""
    agent = settings.get("agent")
    value = str(agent.get("downloads", DEFAULT_MODE)).lower() if isinstance(agent, dict) else DEFAULT_MODE
    return value if value in MODES else DEFAULT_MODE


def check_url(url: str) -> urllib.parse.SplitResult:
    """An address that could be fetched at all. Raises ``InvalidInput`` if not."""
    if not isinstance(url, str) or not url.strip():
        raise InvalidInput("Give the address of the PDF to download.")
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        raise InvalidInput("Only http and https addresses can be downloaded.")
    if not parts.hostname:
        raise InvalidInput(f"{url!r} is not a complete address.")
    if parts.username or parts.password:
        raise InvalidInput("An address with a user name or password in it is not fetched.")
    return parts


def normalize(url: str) -> str:
    """The address to fetch: as given, but an arXiv abstract page becomes its PDF."""
    parts = check_url(url)
    host = (parts.hostname or "").lower()
    if host in ("arxiv.org", "www.arxiv.org"):
        match = _ARXIV_ABS.match(parts.path)
        if match:
            return f"https://arxiv.org/pdf/{match.group('id')}"
    return urllib.parse.urlunsplit(parts)


def _is_public(address: str) -> bool:
    try:
        parsed = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    mapped = getattr(parsed, "ipv4_mapped", None)
    return (mapped or parsed).is_global


class _Refused(OSError):
    """The connection reached somewhere that is not the public internet."""


def _check_peer(connection: http.client.HTTPConnection) -> None:
    peer = connection.sock.getpeername()[0] if connection.sock else ""
    if not _is_public(str(peer)):
        connection.close()
        raise _Refused(
            f"{connection.host} is not on the public internet, so it is not fetched."
        )


class _PublicHTTPConnection(http.client.HTTPConnection):
    def connect(self) -> None:
        super().connect()
        _check_peer(self)


class _PublicHTTPSConnection(http.client.HTTPSConnection):
    def connect(self) -> None:
        super().connect()
        _check_peer(self)


class _PublicHTTP(urllib.request.HTTPHandler):
    def http_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_PublicHTTPConnection, req)


class _PublicHTTPS(urllib.request.HTTPSHandler):
    def https_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_PublicHTTPSConnection, req, context=self._context)


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    max_redirections = MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _opener() -> urllib.request.OpenerDirector:
    # Built by hand so that nothing else is in it: no proxy from the
    # environment, no file: or ftp: handler a redirect could reach.
    opener = urllib.request.OpenerDirector()
    for handler in (
        _PublicHTTP(),
        _PublicHTTPS(),
        _CheckedRedirects(),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.HTTPErrorProcessor(),
    ):
        opener.add_handler(handler)
    return opener


def _filename(final_url: str, headers: Message) -> str:
    name = headers.get_filename() or ""
    if not name:
        path = urllib.parse.urlsplit(final_url).path
        name = urllib.parse.unquote(path.rsplit("/", 1)[-1])
    name = re.sub(r"[^\w.\- ]+", "_", name).strip(" .") or "paper"
    return name if name.lower().endswith(".pdf") else f"{name}.pdf"


@dataclass
class Fetched:
    data: bytes
    filename: str
    url: str


def fetch_pdf(url: str, *, max_bytes: int, timeout: float = FETCH_SECONDS) -> Fetched:
    """Fetch the PDF at a public address. Raises ``InvalidInput`` with the reason."""
    target = normalize(url)
    request = urllib.request.Request(
        target, headers={"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*;q=0.5"}
    )
    try:
        with _opener().open(request, timeout=timeout) as response:
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise InvalidInput(
                    f"The file at {target} is larger than the {max_bytes // (1024 * 1024)} MB a paper may be."
                )
            chunks: list[bytes] = []
            size = 0
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise InvalidInput(
                        f"The file at {target} is larger than the {max_bytes // (1024 * 1024)} MB a paper may be."
                    )
                chunks.append(chunk)
            data = b"".join(chunks)
            final_url = response.geturl()
            headers = response.headers
            content_type = headers.get_content_type()
    except InvalidInput:
        raise
    except urllib.error.HTTPError as exc:
        raise InvalidInput(f"{target} answered {exc.code} {exc.reason}.") from exc
    except _Refused as exc:
        raise InvalidInput(str(exc)) from exc
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, _Refused):
            raise InvalidInput(str(reason)) from exc
        raise InvalidInput(f"{target} could not be reached: {reason}.") from exc
    except (OSError, http.client.HTTPException) as exc:
        raise InvalidInput(f"{target} could not be fetched: {exc}.") from exc

    if b"%PDF-" not in data[:1024]:
        raise InvalidInput(
            f"What {final_url} returned is not a PDF (it is {content_type}). "
            "Give the address of the PDF file itself, not of a page about the paper."
        )
    return Fetched(data=data, filename=_filename(final_url, headers), url=final_url)


@dataclass
class _Pending:
    run_id: str
    url: str
    answered: threading.Event = field(default_factory=threading.Event)
    answer: str = EXPIRED


class Permissions:
    """Requests waiting for the reader's yes or no. Held in memory.

    The tool that asked waits here, on its own thread, until the reader
    answers in the conversation, the run is stopped, or the wait runs out. A
    restart forgets them, as it ends the runs that were waiting.
    """

    def __init__(self, *, wait_seconds: float = ASK_SECONDS) -> None:
        self.wait_seconds = wait_seconds
        self._pending: dict[str, _Pending] = {}
        self._lock = threading.Lock()

    def open(self, run_id: str, url: str) -> str:
        request_id = f"ask-{uuid.uuid4().hex[:12]}"
        with self._lock:
            self._pending[request_id] = _Pending(run_id=run_id, url=url)
        return request_id

    def wait(self, request_id: str) -> str:
        """Block until the request is settled, and say how."""
        with self._lock:
            pending = self._pending.get(request_id)
        if pending is None:
            return EXPIRED
        pending.answered.wait(self.wait_seconds)
        with self._lock:
            self._pending.pop(request_id, None)
        return pending.answer

    def answer(self, request_id: str, answer: str) -> bool:
        """Settle a request. False when it is no longer waiting."""
        with self._lock:
            pending = self._pending.get(request_id)
            if pending is None or pending.answered.is_set():
                return False
            pending.answer = answer
            pending.answered.set()
        return True

    def stop_run(self, run_id: str) -> None:
        """A run that was stopped is not waiting for anything any more."""
        with self._lock:
            waiting = [key for key, item in self._pending.items() if item.run_id == run_id]
        for request_id in waiting:
            self.answer(request_id, STOPPED)
