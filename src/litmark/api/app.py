"""The FastAPI application: local boundaries, static assets, and routes.

Boundaries enforced here (see spec §10): host/origin validation and the
per-process session credential, so an unrelated website cannot command the
server.

Host validation exists to stop DNS rebinding against a loopback server: a
malicious page resolves its own name to 127.0.0.1 and talks to this process
from the browser. Checking that the `Host` header is a loopback name defeats
that. Behind a reverse proxy or a port-forward the header is the *proxy's*
hostname instead, so the same check would reject every legitimate request —
which is why non-loopback deployments widen it explicitly. The session
credential remains the real boundary in both cases.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Awaitable, Callable
from importlib import resources
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..errors import InvalidInput, WorkspaceError
from ..mcpserver import MCP_PATH, TOKEN_ENV, UPLOAD_PATH, UploadTickets
from ..services import Services
from ..updates import UpdateCheck
from . import login
from .routes import build_router

log = logging.getLogger(__name__)

TOKEN_HEADER = "x-litmark-token"
TOKEN_QUERY = "token"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"}
# Backwards-compatible alias; the effective set is now per-app.
ALLOWED_HOSTS = LOOPBACK_HOSTS
ANY_HOST = "*"


def static_root() -> Path | None:
    """Locate bundled assets through package resources, not the cwd."""
    try:
        root = resources.files("litmark") / "static"
    except ModuleNotFoundError:  # pragma: no cover - package always importable here
        return None
    path = Path(str(root))
    return path if (path / "index.html").is_file() else None


def create_app(
    services: Services,
    *,
    dev_origin: str | None = None,
    allowed_hosts: set[str] | None = None,
    password: str | None = None,
    mcp_token: str | None = None,
    update_check: UpdateCheck | None = None,
) -> FastAPI:
    """Build the application.

    ``password``, when set, is asked for before anything is served — the page
    included, since the page carries the session credential. A browser is sent
    to a sign-in page and remembered by a cookie (see :mod:`login`); a script
    may send it as HTTP Basic instead. It is for a server reachable by more
    than its owner (a container on a host); it protects nothing in transit, so
    it belongs behind TLS.

    ``mcp_token``, when set, opens the project to sessions elsewhere: the MCP
    endpoint at ``/mcp``, which asks for that token as a bearer credential, and
    the one-time upload addresses it hands out. Unset, neither is served.

    ``update_check``, when given, is asked whether a later version has been
    released, which the page shows beside the version running. Left out, the
    page shows the version and nothing more, and nothing is asked of anyone.

    ``allowed_hosts`` widens host and origin validation for a reverse proxy or
    port-forward. Pass ``{"*"}`` to accept any hostname, which is what a proxy
    whose public name is unknown needs; the session credential still gates the
    API.
    """
    effective_hosts = set(LOOPBACK_HOSTS) | (allowed_hosts or set())
    accept_any_host = ANY_HOST in effective_hosts
    app = FastAPI(
        title="Litmark",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.services = services
    app.state.dev_origin = dev_origin
    app.state.password_enabled = bool(password)
    app.state.update_check = update_check
    tickets = UploadTickets()
    mcp_endpoint: object | None = None
    mcp_sessions: object | None = None
    mcp_running = contextlib.AsyncExitStack()
    if mcp_token:
        from ..mcpserver import asgi_endpoint, build_server

        mcp_endpoint, mcp_sessions = asgi_endpoint(build_server(services, tickets))

    @app.on_event("startup")
    async def _startup() -> None:
        import asyncio

        services.bind_loop(asyncio.get_running_loop())
        recovered = services.recover()
        services.runner.start()
        services.start_sync()
        if mcp_sessions is not None:
            await mcp_running.enter_async_context(mcp_sessions.run())  # type: ignore[attr-defined]
        log.info(
            "Opened project %s (requeued %s jobs, marked %s interrupted runs)",
            services.workspace.root,
            recovered["jobs"],
            recovered["runs"],
        )

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        await mcp_running.aclose()
        await services.shutdown()

    @app.middleware("http")
    async def guard(
        request: Request, call_next: Callable[[Request], Awaitable[object]]
    ):  # type: ignore[no-untyped-def]
        host = _hostname_of(request.headers.get("host") or "")
        if host and not accept_any_host and host not in effective_hosts:
            return JSONResponse(
                {
                    "error": {
                        "code": "bad_host",
                        "message": (
                            f"Unexpected Host header: {host!r}. This server only "
                            "accepts loopback hostnames by default. Behind a proxy "
                            "or port-forward, start it with "
                            f"`--allow-host {host}` (or `--allow-host '*'`)."
                        ),
                    }
                },
                status_code=400,
            )
        path = request.url.path
        outside = _outside_route(path, request.method, enabled=bool(mcp_token))
        if outside == "mcp":
            # Its own credential, for a program rather than a person: a bearer
            # token, which cannot share a header with the browser's password.
            if not mcp_token:
                return JSONResponse(
                    {
                        "error": {
                            "code": "mcp_disabled",
                            "message": (
                                "This server does not accept MCP connections. Start "
                                f"it with {TOKEN_ENV} set to a long random token."
                            ),
                        }
                    },
                    status_code=404,
                )
            if not _bearer_given(request, mcp_token):
                return JSONResponse(
                    {
                        "error": {
                            "code": "unauthorized",
                            "message": "Send the access token as `Authorization: Bearer <token>`.",
                        }
                    },
                    status_code=401,
                    headers={"www-authenticate": 'Bearer realm="Litmark MCP"'},
                )
        # An upload address is its own credential, checked where it is used.
        # The sign-in page is where the password is given, so it is not asked
        # for the password itself.
        # Nor are the home-screen icon and the manifest, which a phone fetches
        # without the cookie and which say nothing a visitor to the sign-in
        # page is not shown.
        unasked = path in login.OPEN_PATHS
        if password and not outside and not unasked and not _signed_in(request, password):
            if _is_navigation(request, path):
                # Someone opening the application: to the form, and back after.
                return RedirectResponse(
                    login.login_address(path, request.url.query), status_code=303
                )
            # No `WWW-Authenticate: Basic` here: on a request made by the page
            # it would bring up the browser's own dialog, which is what the
            # sign-in page is there to replace. The page goes to the form.
            return JSONResponse(
                {
                    "error": {
                        "code": "login_required",
                        "message": (
                            "This Litmark server asks for a password. Sign in at "
                            f"{login.LOGIN_PATH}, or send it as HTTP Basic."
                        ),
                    }
                },
                status_code=401,
            )
        origin = request.headers.get("origin")
        if origin and not _origin_allowed(origin, dev_origin, effective_hosts):
            return JSONResponse(
                {
                    "error": {
                        "code": "bad_origin",
                        "message": "Cross-origin requests are not accepted.",
                    }
                },
                status_code=403,
            )

        if path.startswith("/api/") and not _authorized(request, services.session_token):
            return JSONResponse(
                {
                    "error": {
                        "code": "unauthorized",
                        "message": (
                            "Missing or invalid session credential. Reload the page "
                            "served by this server."
                        ),
                    }
                },
                status_code=401,
            )
        response = await call_next(request)
        if origin and _origin_allowed(origin, dev_origin, effective_hosts):
            response.headers["access-control-allow-origin"] = origin  # type: ignore[attr-defined]
            response.headers["access-control-allow-headers"] = TOKEN_HEADER  # type: ignore[attr-defined]
            response.headers["vary"] = "origin"  # type: ignore[attr-defined]
        return response

    @app.exception_handler(WorkspaceError)
    async def _domain_error(_request: Request, exc: WorkspaceError) -> JSONResponse:
        return JSONResponse(exc.to_payload(), status_code=exc.status_code)

    app.include_router(build_router(), prefix="/api")

    if mcp_endpoint is not None:
        from starlette.routing import Route

        app.router.routes.append(Route(MCP_PATH, endpoint=mcp_endpoint))

        @app.api_route(UPLOAD_PATH + "/{ticket_id}", methods=["PUT", "POST"])
        async def upload_paper(request: Request, ticket_id: str, wait: float = 60.0) -> JSONResponse:
            return await _receive_paper(request, services, tickets, ticket_id, wait)

    if password:
        _add_sign_in(app, password)

    icon = login.touch_icon()

    async def touch_icon() -> Response:
        return Response(
            icon, media_type="image/png", headers={"cache-control": "public, max-age=86400"}
        )

    for icon_path in login.TOUCH_ICON_PATHS:
        app.add_api_route(icon_path, touch_icon, methods=["GET"], include_in_schema=False)

    @app.get(login.MANIFEST_PATH, include_in_schema=False)
    async def manifest() -> JSONResponse:
        return JSONResponse(
            login.MANIFEST,
            media_type="application/manifest+json",
            headers={"cache-control": "public, max-age=3600"},
        )

    assets = static_root()
    if assets is not None:
        app.mount("/assets", StaticFiles(directory=str(assets / "assets")), name="assets")

        @app.get("/", response_class=HTMLResponse)
        async def index() -> HTMLResponse:
            return HTMLResponse(_render_index(assets, services.session_token))

        @app.get("/{path:path}", response_class=HTMLResponse)
        async def spa(path: str) -> HTMLResponse:
            candidate = assets / path
            if path and candidate.is_file():
                return HTMLResponse(candidate.read_text("utf-8"))
            return HTMLResponse(_render_index(assets, services.session_token))

    else:

        @app.get("/", response_class=PlainTextResponse)
        async def missing_assets() -> PlainTextResponse:
            return PlainTextResponse(
                "The browser assets are not built.\n\n"
                "This happens in a source checkout. Build them once:\n"
                "  npm --prefix frontend install\n"
                "  npm --prefix frontend run build\n\n"
                "Published wheels already contain the built assets.\n",
                status_code=503,
            )

    return app


def _add_sign_in(app: FastAPI, password: str) -> None:
    """The sign-in page, what it posts to, and signing out."""
    attempts = login.Attempts()

    def page(next_path: str, problem: str | None = None, status_code: int = 200) -> HTMLResponse:
        return HTMLResponse(
            login.login_page(next_path=next_path, problem=problem),
            status_code=status_code,
            headers={
                "cache-control": "no-store",
                "x-frame-options": "DENY",
                "referrer-policy": "same-origin",
            },
        )

    @app.get(login.LOGIN_PATH, response_model=None)
    async def sign_in_page(request: Request, next: str = "/") -> HTMLResponse | RedirectResponse:  # noqa: A002
        wanted = login.safe_next(next)
        if _signed_in(request, password):
            return RedirectResponse(wanted, status_code=303)
        return page(wanted)

    @app.post(login.LOGIN_PATH, response_model=None)
    async def sign_in(request: Request) -> HTMLResponse | RedirectResponse:
        import asyncio

        form = await request.form()
        supplied = form.get("password")
        wanted = login.safe_next(str(form.get("next") or "/"))
        if attempts.blocked():
            return page(
                wanted,
                "Too many wrong passwords. Wait a few minutes, then try again.",
                status_code=429,
            )
        if not isinstance(supplied, str) or not login.password_matches(supplied, password):
            attempts.failed()
            # A guess costs a little time, whoever is making it.
            await asyncio.sleep(login.FAILURE_DELAY_SECONDS)
            return page(wanted, "That is not the password.", status_code=401)
        attempts.succeeded()
        response = RedirectResponse(wanted, status_code=303)
        response.set_cookie(
            login.COOKIE,
            login.issue_session(password),
            max_age=login.SESSION_SECONDS,
            path="/",
            httponly=True,
            samesite="lax",
            # Kept to TLS where the page itself came over it, directly or
            # through a proxy that says so.
            secure=_over_tls(request),
        )
        return response

    @app.post(login.LOGOUT_PATH)
    async def sign_out() -> RedirectResponse:
        response = RedirectResponse(login.LOGIN_PATH, status_code=303)
        response.delete_cookie(login.COOKIE, path="/")
        return response


def _signed_in(request: Request, password: str) -> bool:
    """Signed in at the form, or carrying the password as a script would."""
    return login.session_is_good(
        request.cookies.get(login.COOKIE), password
    ) or _password_given(request, password)


def _is_navigation(request: Request, path: str) -> bool:
    """Someone opening a page, as against the page or a script asking for data."""
    return (
        request.method == "GET"
        and "text/html" in (request.headers.get("accept") or "")
        and not path.startswith(("/api/", "/assets/"))
    )


def _over_tls(request: Request) -> bool:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or forwarded == "https"


async def _receive_paper(
    request: Request,
    services: Services,
    tickets: UploadTickets,
    ticket_id: str,
    wait: float,
) -> JSONResponse:
    """Take the PDF a session was given leave to send, and say what became of it.

    The answer waits a while for the text to be extracted, so that one request
    is enough to go from a file to a paper that can be read and cited.
    """
    import asyncio

    from fastapi.concurrency import run_in_threadpool

    ticket = tickets.get(ticket_id)
    if ticket is None:
        return JSONResponse(
            {
                "error": {
                    "code": "upload_expired",
                    "message": (
                        "This upload address is unknown, already used, or expired. "
                        "Ask for a new one with the add_paper tool."
                    ),
                }
            },
            status_code=404,
        )
    limit = services.documents.max_upload_bytes
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return JSONResponse(
                {
                    "error": {
                        "code": "too_large",
                        "message": f"The file is over this project's {limit / 1e6:.0f} MB limit.",
                    }
                },
                status_code=413,
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    try:
        imported = await run_in_threadpool(
            lambda: services.import_paper(
                data,
                ticket.filename,
                tags=ticket.tags,
                summarize=ticket.summarize,
                origin=ticket.origin,
            )
        )
    except InvalidInput as exc:
        message = exc.message
        if "multipart" in (request.headers.get("content-type") or ""):
            message += " Send the file itself as the request body (curl -T), not a form."
        return JSONResponse(
            {"error": {"code": exc.code, "message": message}}, status_code=exc.status_code
        )
    tickets.spend(ticket_id)

    document_id = imported["document_id"]
    deadline = asyncio.get_running_loop().time() + max(0.0, min(wait, 300.0))
    while True:
        document = services.documents.get(document_id)
        status = document.extraction.get("status")
        if status in ("ok", "failed") or asyncio.get_running_loop().time() >= deadline:
            break
        await asyncio.sleep(0.3)

    if status == "ok":
        message = (
            "The paper is in the library and its text is extracted: read it with "
            "read_pages, cite it with resolve_source."
        )
    elif status == "failed":
        message = (
            "The paper is stored, but its text could not be extracted: "
            f"{document.extraction.get('error') or 'no reason was recorded'}"
        )
    else:
        message = (
            "The paper is stored and its text is still being extracted. "
            "list_documents shows when it is ready (extraction_status: ok)."
        )
    if imported["duplicate"]:
        message = "This paper was already in the library; nothing was added. " + message
    return JSONResponse(
        {
            "ok": True,
            "document_id": document_id,
            "title": document.display_title,
            "duplicate": imported["duplicate"],
            "page_count": document.page_count,
            "tags": document.tags,
            "extraction_status": status,
            "extraction_quality": document.extraction.get("quality"),
            "extraction_warnings": document.extraction.get("warnings") or [],
            "message": message,
        },
        status_code=200 if imported["duplicate"] else 201,
    )


def _outside_route(path: str, method: str, *, enabled: bool) -> str | None:
    """Whether a request is one a session elsewhere makes, with its own credential.

    Drawn narrowly, because what it returns excuses the request from the
    browser's password: exactly the MCP endpoint, and exactly the sending of a
    file to an upload address. Anything else under those names — a GET, which
    would otherwise be answered with the page and the credential in it — is
    treated as the browser's.
    """
    if path.rstrip("/") == MCP_PATH:
        return "mcp"
    ticket = path.removeprefix(UPLOAD_PATH + "/")
    if (
        enabled
        and path.startswith(UPLOAD_PATH + "/")
        and ticket
        and "/" not in ticket
        and method in ("PUT", "POST")
    ):
        return "upload"
    return None


def _bearer_given(request: Request, token: str) -> bool:
    import hmac

    scheme, _, supplied = (request.headers.get("authorization") or "").partition(" ")
    if scheme.lower() != "bearer" or not supplied.strip():
        return False
    return hmac.compare_digest(supplied.strip().encode("utf-8"), token.encode("utf-8"))


def _render_index(assets: Path, token: str) -> str:
    """Inject the session credential into the served page.

    An unrelated website cannot read this HTML, so it cannot obtain the token.
    """
    html = (assets / "index.html").read_text("utf-8")
    marker = '<meta name="litmark-token" content="">'
    replacement = f'<meta name="litmark-token" content="{token}">'
    if marker in html:
        return html.replace(marker, replacement)
    return html.replace("<head>", f"<head>\n    {replacement}", 1)


def _password_given(request: Request, password: str) -> bool:
    """HTTP Basic, any user name: one person, one password."""
    import base64
    import binascii
    import hmac

    scheme, _, encoded = (request.headers.get("authorization") or "").partition(" ")
    if scheme.lower() != "basic" or not encoded:
        return False
    try:
        decoded = base64.b64decode(encoded.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return False
    _, _, supplied = decoded.partition(":")
    return hmac.compare_digest(supplied.encode("utf-8"), password.encode("utf-8"))


def _authorized(request: Request, token: str) -> bool:
    supplied = request.headers.get(TOKEN_HEADER) or request.query_params.get(TOKEN_QUERY)
    if not supplied:
        return False
    import hmac

    return hmac.compare_digest(supplied, token)


def _hostname_of(header: str) -> str:
    """The hostname from a Host header, without its port.

    IPv6 literals are bracketed (`[::1]:8765`), so a naive split on the last
    colon would mangle them.
    """
    value = header.strip()
    if value.startswith("["):
        closing = value.find("]")
        return value[: closing + 1] if closing != -1 else value
    return value.rsplit(":", 1)[0] if ":" in value else value


def _origin_allowed(origin: str, dev_origin: str | None, hosts: set[str]) -> bool:
    if dev_origin and origin == dev_origin:
        return True
    if ANY_HOST in hosts:
        return True
    from urllib.parse import urlparse

    parsed = urlparse(origin)
    hostname = parsed.hostname or ""
    # `urlparse` strips the brackets from an IPv6 literal; `hosts` keeps them.
    return hostname in hosts or f"[{hostname}]" in hosts
