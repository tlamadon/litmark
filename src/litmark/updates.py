"""Which version this is, and whether a later one has been released.

A release is a tag on GitHub (see the container workflow), so the latest
release there is the latest there is. The server asks, not the page — nothing
in the browser reaches outside — and asks rarely: once when first wanted, then
a few times a day. The question carries nothing about the project or its
owner; it is the public address of the latest release, fetched.

It is only ever a courtesy. Asking happens on a thread of its own, so nothing
waits on it; an answer that does not come (no network, a rate limit) leaves
the last one standing and is tried again later. Set ``LITMARK_UPDATE_CHECK=off``
and the server never asks at all.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.request
from collections.abc import Callable
from typing import Any

from . import __version__

log = logging.getLogger(__name__)

CHECK_ENV = "LITMARK_UPDATE_CHECK"
REPOSITORY = "tlamadon/litmark"
LATEST_RELEASE = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
RELEASES_PAGE = f"https://github.com/{REPOSITORY}/releases"
CHECK_EVERY_SECONDS = 6 * 3600
# After an answer that did not come: sooner than the usual wait, not at once.
RETRY_AFTER_SECONDS = 15 * 60


def check_enabled() -> bool:
    """Whether the environment leaves the check on. It is on unless turned off."""
    return os.environ.get(CHECK_ENV, "").strip().lower() not in ("off", "0", "false", "no")


def parse_version(text: str) -> tuple[int, int, int] | None:
    """`0.3.1` or `v0.3.1` as numbers to compare; None for anything else."""
    parts = text.strip().removeprefix("v").split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        return None
    return (int(parts[0]), int(parts[1]), int(parts[2]))


def fetch_latest_release(timeout: float = 10.0) -> dict[str, str]:
    """The latest release: its version, and the page that describes it."""
    request = urllib.request.Request(
        LATEST_RELEASE,
        headers={
            "accept": "application/vnd.github+json",
            "user-agent": f"litmark/{__version__}",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return {
        "version": str(payload.get("tag_name") or "").removeprefix("v"),
        "url": str(payload.get("html_url") or RELEASES_PAGE),
    }


class UpdateCheck:
    """Remembers the latest release, and asks again when what it knows is old."""

    def __init__(
        self,
        current: str = __version__,
        *,
        fetch: Callable[[], dict[str, str]] = fetch_latest_release,
        every: float = CHECK_EVERY_SECONDS,
        retry_after: float = RETRY_AFTER_SECONDS,
    ) -> None:
        self.current = current
        self._fetch = fetch
        self._every = every
        self._retry_after = retry_after
        self._lock = threading.Lock()
        self._latest: dict[str, str] | None = None
        self._next_check = 0.0
        self._checking: threading.Thread | None = None

    def latest(self) -> dict[str, str] | None:
        """What is known now. Never waits: asking, when due, starts on the side."""
        with self._lock:
            if time.monotonic() >= self._next_check and self._checking is None:
                self._checking = threading.Thread(
                    target=self._check, name="litmark-update-check", daemon=True
                )
                self._checking.start()
            return self._latest

    def wait(self, timeout: float = 5.0) -> None:
        """Let a check under way finish. For tests."""
        with self._lock:
            checking = self._checking
        if checking is not None:
            checking.join(timeout)

    def _check(self) -> None:
        found: dict[str, str] | None = None
        try:
            release = self._fetch()
            if parse_version(release.get("version", "")) is not None:
                found = release
            else:
                log.info("Update check: no usable version in %r", release)
        except Exception as exc:  # noqa: BLE001 - a courtesy must not break anything
            log.info("Update check did not get an answer: %s", exc)
        with self._lock:
            if found is not None:
                self._latest = found
            self._next_check = time.monotonic() + (
                self._every if found is not None else self._retry_after
            )
            self._checking = None


def version_status(check: UpdateCheck | None, current: str = __version__) -> dict[str, Any]:
    """What the page shows: the version running, and a later one if there is one."""
    status: dict[str, Any] = {
        "version": current,
        "checks_for_updates": check is not None,
        "latest": None,
        "update_available": False,
        "release_url": None,
    }
    latest = check.latest() if check is not None else None
    if latest is None:
        return status
    status["latest"] = latest["version"]
    ours, theirs = parse_version(current), parse_version(latest["version"])
    if ours is not None and theirs is not None and theirs > ours:
        status["update_available"] = True
        status["release_url"] = latest["url"]
    return status
