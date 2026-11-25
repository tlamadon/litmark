"""Cloudflare Access in front of the MCP endpoint.

A client on the web — a claude.ai or ChatGPT connector — cannot be handed the
bearer token: its connectors sign in with OAuth, and send only what that
sign-in gave them. Cloudflare Access can run the sign-in (its *Managed OAuth*:
Access becomes the OAuth server, and the person signs in to Access), and then
forwards each request it let through with a JWT that it signed, in the
`Cf-Access-Jwt-Assertion` header. This module checks that JWT: signed with one
of the team's published keys, issued by the team, for this application's
audience, and not expired.

Only that one header is trusted, and only when a team and an audience are
configured. The other headers Access adds (the user's email, say) are not:
anything that reached this process without passing through Access could have
set them, while it cannot sign an assertion.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from typing import Any

from ..errors import WorkspaceError

ASSERTION_HEADER = "cf-access-jwt-assertion"
TEAM_ENV = "LITMARK_ACCESS_TEAM_DOMAIN"
AUD_ENV = "LITMARK_ACCESS_AUD"

log = logging.getLogger(__name__)


class AccessVerifier:
    """Checks the assertion Cloudflare Access forwards with each request.

    ``team_domain`` is the Zero Trust team's domain (``<team>.cloudflareaccess.com``);
    ``audience`` is the application's AUD tag, from its overview page in the
    dashboard. Neither is a secret. The team's signing keys are fetched from
    ``https://<team_domain>/cdn-cgi/access/certs`` and cached; a key that is not
    in the cache (Cloudflare rotates them) makes it fetch the set again.

    ``key_for`` replaces that fetch, for tests: given the token, it returns the
    public key to check it with.
    """

    def __init__(
        self,
        team_domain: str,
        audience: str,
        *,
        key_for: Callable[[str], Any] | None = None,
        leeway: int = 30,
    ) -> None:
        team = team_domain.strip().removeprefix("https://").rstrip("/")
        if not team or "/" in team or "." not in team:
            raise ValueError(
                f"Not a Cloudflare Access team domain: {team_domain!r}. "
                "It looks like <team>.cloudflareaccess.com."
            )
        if not audience.strip():
            raise ValueError("The Access application's audience (its AUD tag) is empty.")
        self.team_domain = team
        self.issuer = f"https://{team}"
        self.audience = audience.strip()
        self.leeway = leeway
        if key_for is None:
            import jwt

            # PyJWKClient caches the set for `lifespan` seconds and refetches on
            # a key ID it does not know, which is what a rotation looks like.
            keys = jwt.PyJWKClient(
                f"{self.issuer}/cdn-cgi/access/certs", cache_keys=True, lifespan=3600, timeout=10
            )
            key_for = lambda token: keys.get_signing_key_from_jwt(token).key  # noqa: E731
        self._key_for = key_for

    def identity(self, token: str | None) -> dict[str, Any] | None:
        """The assertion's claims if it checks out, or None.

        Blocking: the first call, and the first after a rotation, fetches the
        team's keys. Call it off the event loop.
        """
        if not token:
            return None
        import jwt

        try:
            return jwt.decode(
                token,
                self._key_for(token),
                algorithms=["RS256"],
                audience=self.audience,
                issuer=self.issuer,
                leeway=self.leeway,
                options={"require": ["exp", "iat", "iss", "aud"]},
            )
        except (jwt.PyJWTError, ValueError, OSError) as exc:
            # Fail closed, and say why in the log: a wrong audience or team is a
            # configuration mistake someone will want to find.
            log.warning("Refused a Cloudflare Access assertion: %s", exc)
            return None


def access_from_environment(environ: dict[str, str] | None = None) -> AccessVerifier | None:
    """The verifier the environment asks for, or None when it asks for none.

    Both variables or neither: one alone is a mistake, and is refused rather
    than ignored, so that a server meant to be behind Access does not quietly
    come up without it.
    """
    environ = os.environ if environ is None else environ
    team = (environ.get(TEAM_ENV) or "").strip()
    audience = (environ.get(AUD_ENV) or "").strip()
    if not team and not audience:
        return None
    if not team or not audience:
        missing = TEAM_ENV if not team else AUD_ENV
        raise WorkspaceError(
            f"{missing} is not set: Cloudflare Access needs both {TEAM_ENV} and {AUD_ENV}."
        )
    try:
        return AccessVerifier(team, audience)
    except ImportError as exc:
        raise WorkspaceError(
            f"{TEAM_ENV} is set, but checking Access assertions needs PyJWT ({exc}). "
            "Install it with: pip install 'litmark[mcp]'"
        ) from exc
    except ValueError as exc:
        raise WorkspaceError(str(exc)) from exc
