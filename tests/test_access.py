"""Cloudflare Access in front of the MCP endpoint.

A connector on the web signs in to Access with OAuth, and Access forwards what
it let through with an assertion it signed. These tests sign their own with a
key made here and hand the verifier that key, so nothing is fetched.
"""

from __future__ import annotations

import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from litmark.api.access import (
    ASSERTION_HEADER,
    AUD_ENV,
    TEAM_ENV,
    AccessVerifier,
    access_from_environment,
)
from litmark.api.app import TOKEN_HEADER, create_app
from litmark.errors import WorkspaceError

TEAM = "example.cloudflareaccess.com"
AUD = "a" * 64
TOKEN = "t0ken-for-tests-" + "x" * 24
BASE = "http://127.0.0.1:8765"

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def assertion(key: Any = KEY, **claims: Any) -> str:
    """An assertion as Access signs it; a claim given as None is left out."""
    now = int(time.time())
    payload: dict[str, Any] = {
        "aud": [AUD],
        "iss": f"https://{TEAM}",
        "iat": now,
        "nbf": now,
        "exp": now + 300,
        "email": "someone@example.com",
        "sub": "a-user",
        "type": "app",
    }
    payload.update(claims)
    payload = {name: value for name, value in payload.items() if value is not None}
    return jwt.encode(payload, key, algorithm="RS256", headers={"kid": "test-key"})


def verifier() -> AccessVerifier:
    return AccessVerifier(TEAM, AUD, key_for=lambda _token: KEY.public_key())


def tools_list(client: TestClient, **headers: str):
    return client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        headers={"accept": "application/json, text/event-stream", **headers},
    )


def through_access(client: TestClient, token: str):
    return tools_list(client, **{ASSERTION_HEADER: token})


@pytest.fixture
def behind_access(services):
    with TestClient(create_app(services, access=verifier()), base_url=BASE) as client:
        yield client


def test_access_alone_opens_the_endpoint(behind_access):
    listed = through_access(behind_access, assertion())
    assert listed.status_code == 200, listed.text
    names = {tool["name"] for tool in listed.json()["result"]["tools"]}
    assert {"recall", "append_note", "add_paper"} <= names


def test_without_an_assertion_nothing_is_served(behind_access):
    assert tools_list(behind_access).status_code == 401
    # A bearer credential is not a way in when no token is configured, whatever it says.
    assert tools_list(behind_access, authorization=f"Bearer {TOKEN}").status_code == 401


@pytest.mark.parametrize(
    "token",
    [
        pytest.param(assertion(aud=["another-application"]), id="another audience"),
        pytest.param(assertion(iss="https://elsewhere.cloudflareaccess.com"), id="another team"),
        pytest.param(assertion(exp=int(time.time()) - 600), id="expired"),
        pytest.param(assertion(key=OTHER_KEY), id="signed with another key"),
        pytest.param(assertion(exp=None), id="no expiry"),
        pytest.param("not-a-jwt", id="garbage"),
    ],
)
def test_an_assertion_that_does_not_check_out_is_refused(behind_access, token):
    assert through_access(behind_access, token).status_code == 401


def test_the_other_access_headers_are_not_trusted(behind_access):
    # Anything that reaches the server without passing through Access could set
    # these; only the signed assertion counts.
    response = tools_list(
        behind_access,
        **{
            "cf-access-authenticated-user-email": "someone@example.com",
            "cf-access-client-id": "an-id",
        },
    )
    assert response.status_code == 401


def test_the_token_and_access_each_work_alongside_the_other(services):
    app = create_app(services, mcp_token=TOKEN, access=verifier())
    with TestClient(app, base_url=BASE) as client:
        assert tools_list(client, authorization=f"Bearer {TOKEN}").status_code == 200
        assert through_access(client, assertion()).status_code == 200
        assert tools_list(client).status_code == 401
        assert through_access(client, assertion(key=OTHER_KEY)).status_code == 401


def test_an_assertion_means_nothing_when_access_is_not_configured(services):
    with TestClient(create_app(services, mcp_token=TOKEN), base_url=BASE) as client:
        assert through_access(client, assertion()).status_code == 401


def test_an_assertion_opens_only_the_mcp_endpoint(services):
    app = create_app(services, access=verifier(), password="a-password-for-tests")
    with TestClient(app, base_url=BASE) as client:
        headers = {ASSERTION_HEADER: assertion(), TOKEN_HEADER: services.session_token}
        # The browser's API still asks for the password.
        response = client.get("/api/state", headers=headers, follow_redirects=False)
        assert response.status_code in (401, 303)
        assert through_access(client, assertion()).status_code == 200


def test_the_host_is_still_checked(behind_access):
    response = behind_access.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        headers={
            "accept": "application/json, text/event-stream",
            "host": "research.example.com",
            ASSERTION_HEADER: assertion(),
        },
    )
    assert response.status_code == 400


def test_configuration_from_the_environment():
    assert access_from_environment({}) is None
    with pytest.raises(WorkspaceError, match=AUD_ENV):
        access_from_environment({TEAM_ENV: TEAM})
    with pytest.raises(WorkspaceError, match=TEAM_ENV):
        access_from_environment({AUD_ENV: AUD})
    with pytest.raises(WorkspaceError, match="team domain"):
        access_from_environment({TEAM_ENV: "not a domain", AUD_ENV: AUD})
    configured = access_from_environment({TEAM_ENV: f"https://{TEAM}/", AUD_ENV: f" {AUD} "})
    assert configured is not None
    assert configured.team_domain == TEAM
    assert configured.issuer == f"https://{TEAM}"
    assert configured.audience == AUD
