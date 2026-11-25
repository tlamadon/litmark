"""Reaching the server through a reverse proxy or port-forward.

The default is loopback-only, which is what protects a local server from DNS
rebinding. Behind a proxy the `Host` and `Origin` headers carry the proxy's
name instead, so the same checks reject every legitimate request — these tests
pin both the strict default and the widened behaviour.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from litmark.api.app import TOKEN_HEADER, _hostname_of, create_app
from litmark.cli import build_parser


def client_for(services, **kwargs) -> TestClient:
    app = create_app(services, **kwargs)
    return TestClient(app, base_url="http://127.0.0.1:8765")


def test_default_still_rejects_a_foreign_host(services):
    with client_for(services) as client:
        client.headers.update({TOKEN_HEADER: services.session_token})
        response = client.get("/api/state", headers={"host": "research.example.com"})
        assert response.status_code == 400
        # The error says how to fix it rather than just refusing.
        assert "--allow-host" in response.json()["error"]["message"]


def test_a_named_proxy_host_can_be_allowed(services):
    with client_for(services, allowed_hosts={"research.example.com"}) as client:
        client.headers.update({TOKEN_HEADER: services.session_token})
        assert (
            client.get("/api/state", headers={"host": "research.example.com"}).status_code
            == 200
        )
        # A host that was not named is still refused.
        assert client.get("/api/state", headers={"host": "other.example"}).status_code == 400
        # Loopback keeps working alongside it.
        assert client.get("/api/state", headers={"host": "localhost"}).status_code == 200


def test_wildcard_accepts_any_host_but_still_requires_the_token(services):
    with client_for(services, allowed_hosts={"*"}) as client:
        assert client.get("/api/state", headers={"host": "anything.example"}).status_code == 401
        client.headers.update({TOKEN_HEADER: services.session_token})
        assert client.get("/api/state", headers={"host": "anything.example"}).status_code == 200
        assert (
            client.get(
                "/api/state",
                headers={"host": "anything.example", "origin": "http://anything.example"},
            ).status_code
            == 200
        )


def test_proxy_origin_is_accepted_when_its_host_is(services):
    with client_for(services, allowed_hosts={"research.example.com"}) as client:
        client.headers.update({TOKEN_HEADER: services.session_token})
        allowed = client.get(
            "/api/state",
            headers={"host": "research.example.com", "origin": "https://research.example.com"},
        )
        assert allowed.status_code == 200
        refused = client.get(
            "/api/state",
            headers={"host": "research.example.com", "origin": "https://evil.example"},
        )
        assert refused.status_code == 403


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("127.0.0.1:8765", "127.0.0.1"),
        ("localhost", "localhost"),
        ("research.example.com:443", "research.example.com"),
        ("[::1]:8765", "[::1]"),
        ("[::1]", "[::1]"),
    ],
)
def test_hostname_parsing_handles_ipv6_and_ports(header, expected):
    assert _hostname_of(header) == expected


def test_ipv6_loopback_is_accepted(services):
    with client_for(services) as client:
        client.headers.update({TOKEN_HEADER: services.session_token})
        assert client.get("/api/state", headers={"host": "[::1]:8765"}).status_code == 200


def test_binding_beyond_loopback_widens_host_checking_by_default():
    """`--host 0.0.0.0` without `--allow-host` must not reject every request."""
    parser = build_parser()
    args = parser.parse_args(["serve", "/tmp/x", "--host", "0.0.0.0"])
    assert args.host == "0.0.0.0"
    assert args.allow_host == []

    # This mirrors the decision made in cmd_serve.
    loopback = args.host in {"127.0.0.1", "localhost", "::1"}
    allowed = set(args.allow_host) or ({"*"} if not loopback else set())
    assert allowed == {"*"}

    named = parser.parse_args(
        ["serve", "/tmp/x", "--host", "0.0.0.0", "--allow-host", "papers.internal"]
    )
    assert set(named.allow_host) == {"papers.internal"}


def test_default_serve_arguments_stay_loopback():
    args = build_parser().parse_args(["serve", "/tmp/x"])
    assert args.host == "127.0.0.1"
    assert args.allow_host == []


# ------------------------------------------------------------- a password


def test_a_password_is_asked_for_before_anything_is_served(services):
    """The page carries the session credential, so the page is protected too."""
    import base64

    from fastapi.testclient import TestClient

    from litmark.api.app import TOKEN_HEADER, create_app

    app = create_app(services, password="correct horse")
    basic = lambda secret: {  # noqa: E731
        "authorization": "Basic " + base64.b64encode(f"me:{secret}".encode()).decode()
    }
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        for path in ("/", "/api/state", "/assets/nothing.js"):
            refused = client.get(path)
            assert refused.status_code == 401, path
            assert refused.json()["error"]["code"] == "login_required"
            # Not a challenge the browser answers with a dialog of its own:
            # asked by the page, that dialog is what the form replaces.
            assert "www-authenticate" not in refused.headers
        assert client.get("/api/state", headers=basic("wrong")).status_code == 401
        assert client.get("/api/state", headers={"authorization": "Basic !!!"}).status_code == 401
        # The password alone is not the session credential…
        assert client.get("/api/state", headers=basic("correct horse")).status_code == 401
        # …and with both, the API answers. A script may still send it this way.
        both = {**basic("correct horse"), TOKEN_HEADER: services.session_token}
        assert client.get("/api/state", headers=both).status_code == 200
        assert client.get("/api/state", headers=both).json()["auth"] == {"password": True}


# ------------------------------------------------------------- signing in

PASSWORD = "correct horse"
HTML = {"accept": "text/html,application/xhtml+xml"}


@pytest.fixture
def guarded(services, monkeypatch):
    """A server that asks for its password, as a browser meets it."""
    from fastapi.testclient import TestClient

    from litmark.api import login
    from litmark.api.app import create_app

    monkeypatch.setattr(login, "FAILURE_DELAY_SECONDS", 0)
    app = create_app(services, password=PASSWORD)
    with TestClient(app, base_url="http://127.0.0.1:8765", follow_redirects=False) as client:
        yield client


def test_a_browser_is_sent_to_a_form_a_password_manager_can_fill(guarded):
    opened = guarded.get("/notes/plan?x=1", headers=HTML)
    assert opened.status_code == 303
    assert opened.headers["location"] == "/login?next=/notes/plan%3Fx%3D1"
    assert guarded.get("/", headers=HTML).headers["location"] == "/login"

    page = guarded.get(opened.headers["location"], headers=HTML)
    assert page.status_code == 200 and page.headers["cache-control"] == "no-store"
    form = page.text
    assert '<form method="post" action="/login">' in form
    # Marked for what they are: that is all a password manager goes by.
    assert 'type="password" name="password" autocomplete="current-password"' in form
    assert 'name="username"' in form and 'autocomplete="username"' in form
    assert 'name="next" value="/notes/plan?x=1"' in form
    # Nothing of the project is on a page anyone can open.
    assert "litmark-token" not in form and "project" not in form.lower().replace("litmark", "")


def test_the_right_password_is_remembered_by_a_cookie(guarded, services):
    from litmark.api.app import TOKEN_HEADER

    wrong = guarded.post("/login", data={"password": "battery staple", "next": "/notes/plan"})
    assert wrong.status_code == 401 and "That is not the password." in wrong.text
    assert 'name="next" value="/notes/plan"' in wrong.text  # Where one was going is kept.
    assert "set-cookie" not in wrong.headers

    signed = guarded.post(
        "/login", data={"username": "anyone", "password": PASSWORD, "next": "/notes/plan"}
    )
    assert signed.status_code == 303 and signed.headers["location"] == "/notes/plan"
    cookie = signed.headers["set-cookie"]
    assert cookie.startswith("litmark_session=v1.")
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Max-Age=2592000" in cookie
    assert "Secure" not in cookie  # Plain HTTP here; see the next test.

    # With it, the page is served and the form is not shown again…
    assert guarded.get("/", headers=HTML).status_code in (200, 503)
    assert guarded.get("/login", headers=HTML).headers["location"] == "/"
    # …and the API still wants the page's own credential besides.
    assert guarded.get("/api/state").status_code == 401
    assert guarded.get("/api/state").json()["error"]["code"] == "unauthorized"
    assert guarded.get("/api/state", headers={TOKEN_HEADER: services.session_token}).status_code == 200

    # Signing out forgets it.
    out = guarded.post("/logout")
    assert out.status_code == 303 and out.headers["location"] == "/login"
    assert guarded.get("/", headers=HTML).headers["location"] == "/login"


def test_the_cookie_is_kept_to_tls_where_the_page_came_over_it(guarded):
    signed = guarded.post(
        "/login", data={"password": PASSWORD}, headers={"x-forwarded-proto": "https"}
    )
    assert "Secure" in signed.headers["set-cookie"]


def test_a_session_outlives_a_restart_and_ends_with_the_password():
    from litmark.api.login import SESSION_SECONDS, issue_session, session_is_good

    issued = issue_session(PASSWORD, now=1_000_000)
    # No store of sessions: the same password, in another process, knows it.
    assert session_is_good(issued, PASSWORD, now=1_000_000 + SESSION_SECONDS - 1)
    assert not session_is_good(issued, PASSWORD, now=1_000_000 + SESSION_SECONDS + 1)
    assert not session_is_good(issued, "a new password", now=1_000_001)
    version, expires, signature = issued.split(".")
    later = f"{version}.{int(expires) + 10**6}.{signature}"
    for forged in (later, f"v1.{expires}.", "v1..x", "", None, "nonsense", f"v2.{expires}.{signature}"):
        assert not session_is_good(forged, PASSWORD, now=1_000_001), forged


def test_signing_in_does_not_send_anyone_elsewhere(guarded):
    from litmark.api.login import safe_next

    for target in ("//evil.example/x", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "", "/login"):
        assert safe_next(target) == "/", target
    assert safe_next("/notes/plan?x=1#top") == "/notes/plan?x=1#top"
    signed = guarded.post("/login", data={"password": PASSWORD, "next": "//evil.example/"})
    assert signed.headers["location"] == "/"


def test_guessing_is_stopped_after_a_handful_of_wrong_passwords(guarded):
    from litmark.api.login import MAX_FAILURES

    for _ in range(MAX_FAILURES):
        assert guarded.post("/login", data={"password": "guess"}).status_code == 401
    stopped = guarded.post("/login", data={"password": PASSWORD})
    assert stopped.status_code == 429 and "Wait a few minutes" in stopped.text
    assert "set-cookie" not in stopped.headers


def test_without_a_password_there_is_nothing_to_sign_in_to(client):
    assert client.get("/api/state").json()["auth"] == {"password": False}
    assert client.post("/login", data={"password": "x"}).status_code in (404, 405)


def test_without_a_password_none_is_asked_for(client):
    assert client.get("/api/state").status_code == 200


def test_the_sign_in_page_carries_the_same_icon_as_the_application() -> None:
    """The form is served before the assets may be, so it holds its own copy."""
    from urllib.parse import quote

    from litmark.api import login

    source = Path(__file__).resolve().parents[1] / "frontend" / "src" / "favicon.svg"
    assert login.FAVICON_SVG == source.read_text("utf-8").strip()
    assert f'href="data:image/svg+xml,{quote(login.FAVICON_SVG)}"' in login.login_page()
