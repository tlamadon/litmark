"""Reaching the server through a reverse proxy or port-forward.

The default is loopback-only, which is what protects a local server from DNS
rebinding. Behind a proxy the `Host` and `Origin` headers carry the proxy's
name instead, so the same checks reject every legitimate request — these tests
pin both the strict default and the widened behaviour.
"""

from __future__ import annotations

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
            assert refused.headers["www-authenticate"].startswith("Basic")
        assert client.get("/api/state", headers=basic("wrong")).status_code == 401
        assert client.get("/api/state", headers={"authorization": "Basic !!!"}).status_code == 401
        # The password alone is not the session credential…
        assert client.get("/api/state", headers=basic("correct horse")).status_code == 401
        # …and with both, the API answers.
        both = {**basic("correct horse"), TOKEN_HEADER: services.session_token}
        assert client.get("/api/state", headers=both).status_code == 200


def test_without_a_password_none_is_asked_for(client):
    assert client.get("/api/state").status_code == 200
