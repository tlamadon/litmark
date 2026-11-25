"""The version the page shows, and whether a later one has been released."""

from __future__ import annotations

import pytest

from litmark import __version__
from litmark.updates import (
    CHECK_ENV,
    UpdateCheck,
    check_enabled,
    parse_version,
    version_status,
)


def release(version: str) -> dict[str, str]:
    return {"version": version, "url": f"https://example.test/releases/v{version}"}


def test_versions_compare_as_numbers_not_as_text() -> None:
    assert parse_version("v0.10.0") > parse_version("0.9.3")
    assert parse_version("1.2") is None
    assert parse_version("1.2.3-rc1") is None


def test_a_later_release_is_reported_with_where_to_read_about_it() -> None:
    check = UpdateCheck("0.3.1", fetch=lambda: release("0.4.0"))
    # Asking never waits for the answer: the first reply has only the version.
    first = version_status(check, "0.3.1")
    assert first["version"] == "0.3.1"
    assert first["checks_for_updates"] is True
    check.wait()
    status = version_status(check, "0.3.1")
    assert status["latest"] == "0.4.0"
    assert status["update_available"] is True
    assert status["release_url"] == "https://example.test/releases/v0.4.0"


@pytest.mark.parametrize("latest", ["0.3.1", "0.3.0"])
def test_the_same_or_an_earlier_release_is_not_an_update(latest: str) -> None:
    check = UpdateCheck("0.3.1", fetch=lambda: release(latest))
    check.latest()
    check.wait()
    status = version_status(check, "0.3.1")
    assert status["latest"] == latest
    assert status["update_available"] is False
    assert status["release_url"] is None


def test_an_answer_is_kept_and_not_asked_for_again_at_once() -> None:
    asked = []

    def fetch() -> dict[str, str]:
        asked.append(1)
        return release("0.4.0")

    check = UpdateCheck("0.3.1", fetch=fetch)
    for _ in range(3):
        check.latest()
        check.wait()
    assert len(asked) == 1


def test_no_answer_breaks_nothing_and_is_asked_for_again_later() -> None:
    answers = iter([OSError("no network"), release("0.4.0")])

    def fetch() -> dict[str, str]:
        answer = next(answers)
        if isinstance(answer, Exception):
            raise answer
        return answer

    check = UpdateCheck("0.3.1", fetch=fetch, retry_after=0)
    check.latest()
    check.wait()
    assert version_status(check, "0.3.1")["update_available"] is False
    check.wait()
    assert version_status(check, "0.3.1")["update_available"] is True


def test_the_check_is_on_unless_the_environment_turns_it_off(monkeypatch) -> None:
    monkeypatch.delenv(CHECK_ENV, raising=False)
    assert check_enabled()
    monkeypatch.setenv(CHECK_ENV, "off")
    assert not check_enabled()


def test_the_server_says_its_version_and_asks_no_one_unless_told_to(client) -> None:
    assert client.get("/api/version").json() == {
        "version": __version__,
        "checks_for_updates": False,
        "latest": None,
        "update_available": False,
        "release_url": None,
    }

    # What `litmark serve` passes to `create_app`, unless the check is off.
    check = UpdateCheck(fetch=lambda: release("999.0.0"))
    client.app.state.update_check = check
    client.get("/api/version")
    check.wait()
    told = client.get("/api/version").json()
    assert told["update_available"] is True
    assert told["latest"] == "999.0.0"
