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

import logging
from collections.abc import Awaitable, Callable
from importlib import resources
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..errors import WorkspaceError
from ..services import Services
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
) -> FastAPI:
    """Build the application.

    ``password``, when set, is asked for by the browser before anything is
    served — the page included, since the page carries the session credential.
    It is for a server reachable by more than its owner (a container on a
    host); it protects nothing in transit, so it belongs behind TLS.

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

    @app.on_event("startup")
    async def _startup() -> None:
        import asyncio

        services.bind_loop(asyncio.get_running_loop())
        recovered = services.recover()
        services.runner.start()
        services.start_sync()
        log.info(
            "Opened project %s (requeued %s jobs, marked %s interrupted runs)",
            services.workspace.root,
            recovered["jobs"],
            recovered["runs"],
        )

    @app.on_event("shutdown")
    async def _shutdown() -> None:
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
        if password and not _password_given(request, password):
            return PlainTextResponse(
                "This Litmark server asks for a password.\n",
                status_code=401,
                headers={"www-authenticate": 'Basic realm="Litmark", charset="UTF-8"'},
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

        path = request.url.path
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
