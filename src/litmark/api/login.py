"""Signing in: a page with a form, and a cookie that remembers it was filled in.

The password used to be asked for by the browser's own dialog (HTTP Basic).
That dialog is not a form on a page, so a password manager has nothing to
recognise, fill, or offer to save. This is the ordinary thing instead: a page
with a password field marked as one, posted once, answered with a cookie.

The cookie holds no secret and needs no store. It is an expiry time and a
signature over it, made with a key derived from the password itself — so it
survives the server restarting (a deploy does not sign anyone out), and
changing the password ends every session at once. Signing out forgets the
cookie in that browser; there is one user, and nothing else to revoke.

HTTP Basic is still accepted, for `curl -u` and scripts.
"""

from __future__ import annotations

import hashlib
import hmac
import html
import threading
import time
from collections import deque
from urllib.parse import quote

COOKIE = "litmark_session"
LOGIN_PATH = "/login"
LOGOUT_PATH = "/logout"
SESSION_SECONDS = 30 * 24 * 3600
# A password is one person's, typed or filled: a handful of wrong ones in a
# few minutes is somebody guessing.
MAX_FAILURES = 8
FAILURE_WINDOW_SECONDS = 5 * 60
FAILURE_DELAY_SECONDS = 0.4


def _key(password: str) -> bytes:
    return hashlib.sha256(b"litmark-session-v1\0" + password.encode("utf-8")).digest()


def issue_session(password: str, *, now: float | None = None) -> str:
    """A cookie value good for a month: when it lapses, and proof it was issued here."""
    expires = str(int((time.time() if now is None else now) + SESSION_SECONDS))
    signature = hmac.new(_key(password), expires.encode("ascii"), hashlib.sha256).hexdigest()
    return f"v1.{expires}.{signature}"


def session_is_good(value: str | None, password: str, *, now: float | None = None) -> bool:
    if not value:
        return False
    version, _, rest = value.partition(".")
    expires, _, signature = rest.partition(".")
    if version != "v1" or not expires.isdigit() or not signature:
        return False
    expected = hmac.new(_key(password), expires.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature.encode("ascii", "replace"), expected.encode("ascii")):
        return False
    return int(expires) > (time.time() if now is None else now)


def password_matches(supplied: str, password: str) -> bool:
    return hmac.compare_digest(supplied.encode("utf-8"), password.encode("utf-8"))


def safe_next(target: str | None) -> str:
    """Where to go once signed in: a path of this site, and nothing else.

    What comes in the address of the sign-in page is not to be trusted with
    sending someone elsewhere afterwards.
    """
    target = (target or "").strip()
    if not target.startswith("/") or target.startswith("//") or "\\" in target:
        return "/"
    if any(ord(char) < 32 for char in target) or target.startswith(LOGIN_PATH):
        return "/"
    return target


def login_address(path: str, query: str = "") -> str:
    """The sign-in page, remembering where it was asked for from."""
    wanted = safe_next(path + (f"?{query}" if query else ""))
    return LOGIN_PATH if wanted == "/" else f"{LOGIN_PATH}?next={quote(wanted, safe='/')}"


class Attempts:
    """Wrong passwords of late, across everyone: there is one password to guess."""

    def __init__(self) -> None:
        self._failures: deque[float] = deque()
        self._lock = threading.Lock()

    def _recent(self, now: float) -> int:
        while self._failures and self._failures[0] <= now - FAILURE_WINDOW_SECONDS:
            self._failures.popleft()
        return len(self._failures)

    def blocked(self) -> bool:
        with self._lock:
            return self._recent(time.monotonic()) >= MAX_FAILURES

    def failed(self) -> None:
        with self._lock:
            self._failures.append(time.monotonic())

    def succeeded(self) -> None:
        with self._lock:
            self._failures.clear()


def login_page(*, next_path: str = "/", problem: str | None = None) -> str:
    """The sign-in page. Self-contained: it is served before anything else may be.

    The fields are marked for what they are, which is what lets a password
    manager fill them and offer to remember. There is one user, so the name is
    fixed and out of sight — but it is there, because a manager files a
    password under a name.
    """
    notice = (
        f'<p class="problem" role="alert" id="problem">{html.escape(problem)}</p>' if problem else ""
    )
    described = ' aria-describedby="problem" aria-invalid="true"' if problem else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>Sign in — Litmark</title>
<style>
  :root {{
    --bg: #fbfaf8; --panel: #ffffff; --ink: #23201c; --muted: #6b655d;
    --rule: #e3ded6; --accent: #8a5a2b; --accent-soft: #f2e7d9; --danger: #a33a2b;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --bg: #171614; --panel: #1e1d1a; --ink: #eae6df; --muted: #b0aaa1;
      --rule: #332f2a; --accent: #d9a86a; --accent-soft: #33291c; --danger: #e08874;
    }}
  }}
  * {{ box-sizing: border-box; }}
  html, body {{ height: 100%; margin: 0; }}
  body {{
    display: grid; place-items: center; padding: 1.5rem;
    background: var(--bg); color: var(--ink);
    font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }}
  form {{
    width: min(22rem, 100%); display: grid; gap: 0.9rem;
    padding: 1.6rem 1.5rem 1.5rem; background: var(--panel);
    border: 1px solid var(--rule); border-radius: 12px;
  }}
  h1 {{
    margin: 0; font: 600 1.35rem/1.2 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  }}
  p {{ margin: 0; color: var(--muted); font-size: 0.92rem; }}
  label {{ display: grid; gap: 0.3rem; font-size: 0.86rem; color: var(--muted); }}
  input[type='password'] {{
    width: 100%; padding: 0.6rem 0.7rem; font: inherit; color: var(--ink);
    background: var(--bg); border: 1px solid var(--rule); border-radius: 8px;
  }}
  input[type='password']:focus-visible, button:focus-visible {{
    outline: 2px solid var(--accent); outline-offset: 1px;
  }}
  button {{
    padding: 0.6rem 0.8rem; font: inherit; font-weight: 600; cursor: pointer;
    color: var(--ink); background: var(--accent-soft);
    border: 1px solid var(--accent); border-radius: 8px;
  }}
  .problem {{ color: var(--danger); }}
  /* Out of sight, not absent: a password manager files the password under it. */
  .name {{
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
  }}
</style>
</head>
<body>
<form method="post" action="{LOGIN_PATH}">
  <h1>Litmark</h1>
  <p>This library asks for its password.</p>
  <input class="name" type="text" name="username" value="litmark"
         autocomplete="username" tabindex="-1" aria-hidden="true">
  <label for="password">Password
    <input id="password" type="password" name="password" autocomplete="current-password"
           required autofocus{described}>
  </label>
  {notice}
  <input type="hidden" name="next" value="{html.escape(next_path, quote=True)}">
  <button type="submit">Sign in</button>
</form>
</body>
</html>
"""
