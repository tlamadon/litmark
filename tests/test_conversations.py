"""Several conversations at once, and coming back to an earlier one.

Runs are serialized per conversation and conversations run side by side. A
conversation read back is rebuilt from the same durable events the browser
followed live, so what an earlier turn did is still there after a reload.
"""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import AsyncIterator
from typing import Any

import pytest
from conftest import upload, wait_for_extraction

from litmark.agent.base import (
    DONE,
    AgentBackend,
    AgentEvent,
    Availability,
    RunContext,
    RunRequest,
)
from litmark.db import Database
from litmark.errors import InvalidInput
from litmark.services import Services


def settle(services: Services, timeout: float = 10.0) -> None:
    """Run the scheduler on a loop of our own until nothing is queued or running."""

    async def wait() -> None:
        services.runner.start()
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if not services.db.query(
                "SELECT id FROM runs WHERE status IN ('queued', 'running')"
            ):
                await services.runner.stop()
                return
            await asyncio.sleep(0.01)
        raise AssertionError("Agent runs did not settle")

    asyncio.run(wait())


def events_of(services: Services, *types: str) -> list[dict[str, Any]]:
    return [event for event in services.db.events_since(0) if event["type"] in types]


# ------------------------------------------------------------ side by side


def test_two_conversations_run_at_the_same_time(services):
    """A long question in one conversation does not hold up another."""
    services.backend.delay = 0.05
    services.backend.script = [("text", "one"), ("text", "two"), ("text", "three")]
    first = services.runner.create_conversation(None)
    second = services.runner.create_conversation(None)
    a = services.runner.submit(conversation_id=first, prompt="A long question")
    b = services.runner.submit(conversation_id=second, prompt="A quick question")
    settle(services)

    order = [
        (event["type"], event["run_id"]) for event in events_of(services, "run_started", "done")
    ]
    assert order.index(("run_started", b["run_id"])) < order.index(("done", a["run_id"])), order
    for conversation_id in (first, second):
        turns = services.runner.conversation(conversation_id)["turns"]
        assert [turn["status"] for turn in turns] == ["succeeded"]


def test_one_conversation_takes_its_messages_in_turn(services):
    """A second message in the same conversation waits for the first to finish."""
    services.backend.delay = 0.03
    conversation_id = services.runner.create_conversation(None)
    a = services.runner.submit(conversation_id=conversation_id, prompt="First")
    b = services.runner.submit(conversation_id=conversation_id, prompt="Second")
    settle(services)

    order = [
        (event["type"], event["run_id"]) for event in events_of(services, "run_started", "done")
    ]
    assert order == [
        ("run_started", a["run_id"]),
        ("done", a["run_id"]),
        ("run_started", b["run_id"]),
        ("done", b["run_id"]),
    ]


def test_the_parallel_limit_is_respected(project):
    services = Services(project, backend_name="fake")
    try:
        services.runner._max_parallel = 1
        services.backend.delay = 0.03
        first = services.runner.create_conversation(None)
        second = services.runner.create_conversation(None)
        a = services.runner.submit(conversation_id=first, prompt="One")
        b = services.runner.submit(conversation_id=second, prompt="Two")
        settle(services)
        order = [
            (event["type"], event["run_id"])
            for event in events_of(services, "run_started", "done")
        ]
        assert order.index(("done", a["run_id"])) < order.index(("run_started", b["run_id"]))
    finally:
        services.db.close()


def test_an_edit_is_announced_by_the_run_that_made_it(services):
    """Two runs editing at once each report their own change, not the other's."""
    note_a = services.workspace.create_note(title="Alpha")
    note_b = services.workspace.create_note(title="Beta")
    first = services.runner.create_conversation(None)
    second = services.runner.create_conversation(None)

    class Scripted(type(services.backend)):
        async def start_run(self, request: RunRequest) -> AsyncIterator[AgentEvent]:
            note = note_a if request.conversation_id == first else note_b
            self.script = [
                ("text", "Editing."),
                (
                    "tool",
                    "write_note",
                    {
                        "note_id": note.note_id,
                        "text": f"# {note.title}\n\nEdited.\n",
                        "expected_revision": note.revision,
                    },
                ),
            ]
            async for event in super().start_run(request):
                await asyncio.sleep(0.01)
                yield event

    services.backend.__class__ = Scripted
    a = services.runner.submit(conversation_id=first, prompt="Edit alpha")
    b = services.runner.submit(conversation_id=second, prompt="Edit beta")
    settle(services)

    changed = {event["run_id"]: event["target_id"] for event in events_of(services, "file_changed")}
    assert changed == {a["run_id"]: note_a.note_id, b["run_id"]: note_b.note_id}


# --------------------------------------------------------- reading it back


def test_an_earlier_turn_is_read_back_with_what_it_did(services):
    """The tools a turn used are part of the conversation after a reload."""
    note = services.workspace.create_note(title="Findings")
    services.backend.script = [
        ("text", "Reading the note first."),
        ("tool", "read_note", {"note_id": note.note_id}),
        ("text", "It is nearly empty."),
    ]
    conversation_id = services.runner.create_conversation(None)
    services.runner.submit(conversation_id=conversation_id, prompt="What is in my note?")
    settle(services)

    conversation = services.runner.conversation(conversation_id)
    (turn,) = conversation["turns"]
    assert turn["message"]["content"] == "What is in my note?"
    assert turn["status"] == "succeeded"
    kinds = [event["type"] for event in turn["events"]]
    assert kinds == [
        "message_added",
        "run_started",
        "text_delta",
        "tool_started",
        "tool_finished",
        "text_delta",
        "done",
        "message_added",
    ]
    started = next(event for event in turn["events"] if event["type"] == "tool_started")
    finished = next(event for event in turn["events"] if event["type"] == "tool_finished")
    assert started["tool"] == "read_note"
    assert started["tool_use_id"] == finished["tool_use_id"]
    assert finished["result"]["note_id"] == note.note_id
    assert turn["reply"] == "Reading the note first.It is nearly empty."
    assert conversation["latest_seq"] >= turn["events"][-1]["seq"]


def test_fragments_of_a_streaming_reply_are_not_written_down(services):
    """Only the finished block is durable; its fragments were live."""
    services.backend.script = [("text", "A reply long enough to arrive in several fragments.")]
    conversation_id = services.runner.create_conversation(None)
    services.runner.submit(conversation_id=conversation_id, prompt="Say something")
    settle(services)

    deltas = events_of(services, "text_delta")
    assert [event.get("final") for event in deltas] == [True]
    assert deltas[0]["text"] == "A reply long enough to arrive in several fragments."


def test_fragments_reach_a_connected_browser_with_their_place(services):
    """Live fragments say where they belong, so a gap is noticed, not guessed."""
    services.backend.script = [("text", "x" * 60)]
    conversation_id = services.runner.create_conversation(None)
    seen: list[dict[str, Any]] = []

    async def follow() -> None:
        services.bus.bind_loop(asyncio.get_running_loop())

        async def listen() -> None:
            async for event in services.bus.stream(since=services.db.latest_seq()):
                seen.append(event)
                if event["type"] == "done":
                    return

        listener = asyncio.ensure_future(listen())
        await asyncio.sleep(0)
        services.runner.submit(conversation_id=conversation_id, prompt="Stream")
        await asyncio.wait_for(listener, timeout=10)
        await services.runner.stop()

    asyncio.run(follow())
    partial = [event for event in seen if event.get("partial")]
    assert len(partial) > 1
    assert all(event.get("transient") and "seq" not in event for event in partial)
    assert [event["offset"] for event in partial] == [0, 24, 48]


def test_a_reply_cut_short_keeps_what_was_written(services):
    """Stopping mid-sentence keeps the sentence so far, marked unfinished."""

    class Stalls(type(services.backend)):
        async def start_run(self, request: RunRequest) -> AsyncIterator[AgentEvent]:
            yield AgentEvent("text_delta", {"text": "Half a sent", "partial": True})
            await asyncio.sleep(30)

    services.backend.__class__ = Stalls
    conversation_id = services.runner.create_conversation(None)
    submitted = services.runner.submit(conversation_id=conversation_id, prompt="Go on")

    async def stop_soon() -> None:
        services.runner.start()
        await asyncio.sleep(0.05)
        await services.runner.cancel(submitted["run_id"])
        await asyncio.sleep(0.05)
        await services.runner.stop()

    asyncio.run(stop_soon())
    (turn,) = services.runner.conversation(conversation_id)["turns"]
    assert turn["status"] == "cancelled"
    assert turn["reply"] == "Half a sent"
    final = [event for event in turn["events"] if event["type"] == "text_delta"]
    assert final[0]["unfinished"] is True
    assert turn["events"][-2]["type"] == "done"
    assert turn["events"][-2]["status"] == "cancelled"


def test_cancelling_a_queued_run_says_so(services):
    """A run stopped before it started still ends, for whoever is watching."""
    services.backend.delay = 0.05
    conversation_id = services.runner.create_conversation(None)
    services.runner.submit(conversation_id=conversation_id, prompt="First")
    waiting = services.runner.submit(conversation_id=conversation_id, prompt="Second")

    async def cancel_the_second() -> None:
        services.runner.start()
        await asyncio.sleep(0.01)
        await services.runner.cancel(waiting["run_id"])
        while services.db.query("SELECT id FROM runs WHERE status IN ('queued', 'running')"):
            await asyncio.sleep(0.01)
        await services.runner.stop()

    asyncio.run(cancel_the_second())
    turns = services.runner.conversation(conversation_id)["turns"]
    assert [turn["status"] for turn in turns] == ["succeeded", "cancelled"]
    assert turns[1]["events"][-1]["type"] == "done"


# ----------------------------------------------------- names and the list


def test_a_conversation_is_named_for_its_first_message(services):
    conversation_id = services.runner.create_conversation(None)
    assert services.runner.conversation(conversation_id)["title"] == "New conversation"
    services.runner.submit(
        conversation_id=conversation_id, prompt="  How do the two papers\ndiffer on mobility?  "
    )
    services.runner.submit(conversation_id=conversation_id, prompt="And on wages?")
    assert (
        services.runner.conversation(conversation_id)["title"]
        == "How do the two papers differ on mobility?"
    )


def test_a_name_the_user_gave_is_kept(services):
    conversation_id = services.runner.create_conversation(None)
    services.runner.rename_conversation(conversation_id, "Identification")
    services.runner.submit(conversation_id=conversation_id, prompt="A first question")
    assert services.runner.conversation(conversation_id)["title"] == "Identification"
    with pytest.raises(InvalidInput):
        services.runner.rename_conversation(conversation_id, "   ")


def test_the_list_says_what_each_conversation_is_doing(client, services):
    services.backend.delay = 0.3
    quiet = services.runner.create_conversation(None)
    busy = services.runner.create_conversation(None)
    services.runner.submit(conversation_id=busy, prompt="Working on it")
    listed = {c["conversation_id"]: c for c in client.get("/api/conversations").json()["conversations"]}
    assert listed[quiet]["status"] == "idle" and listed[quiet]["turn_count"] == 0
    assert listed[busy]["status"] in {"queued", "running"} and listed[busy]["turn_count"] == 1
    # Most recently used first.
    order = [c["conversation_id"] for c in client.get("/api/conversations").json()["conversations"]]
    assert order.index(busy) < order.index(quiet)


def test_conversations_are_renamed_and_deleted_over_the_api(client, services):
    created = client.post("/api/conversations", json={}).json()
    conversation_id = created["conversation_id"]
    assert created["title"] == "New conversation"
    assert created["turns"] == []

    renamed = client.patch(f"/api/conversations/{conversation_id}", json={"title": "Wages"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["title"] == "Wages"

    services.backend.delay = 0.3
    services.runner.submit(conversation_id=conversation_id, prompt="Hello")
    refused = client.delete(f"/api/conversations/{conversation_id}")
    assert refused.status_code == 422, refused.text

    from test_acceptance import run_until_idle

    run_until_idle(services)
    assert client.delete(f"/api/conversations/{conversation_id}").status_code == 200
    assert client.get(f"/api/conversations/{conversation_id}").status_code == 404
    assert not [
        event for event in services.db.events_since(0)
        if event["conversation_id"] == conversation_id and event["type"] != "conversation_updated"
    ]


# ------------------------------------------------------- background work


def test_summaries_stay_out_of_the_users_conversations(client, services, paper_one):
    """An automatic summary runs in the background conversation, not a chat."""
    from test_acceptance import run_until_idle

    chat = services.runner.default_conversation()
    document = upload(client, "paper.pdf", paper_one)["imported"][0]["document"]
    wait_for_extraction(client, document["document_id"])
    run_until_idle(services)

    assert services.runner.conversation(chat)["turns"] == []
    listed = client.get("/api/conversations").json()["conversations"]
    (background,) = [c for c in listed if c["kind"] == "system"]
    assert listed[-1] == background  # After the user's own conversations.
    (turn,) = client.get(f"/api/conversations/{background['conversation_id']}").json()["turns"]
    assert turn["kind"] == "summary"
    assert turn["label"].startswith("Summary of ")
    assert turn["message"] is None
    assert turn["status"] == "succeeded"

    refused = client.post(
        f"/api/conversations/{background['conversation_id']}/messages", json={"prompt": "Hi"}
    )
    assert refused.status_code == 422, refused.text
    assert client.delete(f"/api/conversations/{background['conversation_id']}").status_code == 422


def test_background_work_is_not_listed_until_there_is_some(client, services):
    services.runner.system_conversation()
    services.runner.default_conversation()
    kinds = [c["kind"] for c in client.get("/api/conversations").json()["conversations"]]
    assert kinds == ["chat"]


# ------------------------------------------------- a session that is gone


class ForgetfulBackend(AgentBackend):
    """Refuses to resume, as a backend does once its saved session is gone."""

    name = "forgetful"

    def __init__(self) -> None:
        self.requests: list[RunRequest] = []

    def availability(self) -> Availability:
        return Availability(backend=self.name, installed=True, authenticated=True, message="ok")

    def supports_resume(self) -> bool:
        return True

    async def start_run(self, request: RunRequest) -> AsyncIterator[AgentEvent]:
        self.requests.append(request)
        if request.backend_session_id == "gone":
            yield AgentEvent.error("No conversation found with session ID: gone")
            yield AgentEvent(DONE, {"terminal_reason": "error", "backend_session_id": "gone"})
            return
        yield AgentEvent("text_delta", {"text": "Carrying on.", "final": True})
        yield AgentEvent(DONE, {"terminal_reason": "endTurn", "backend_session_id": "fresh"})

    async def cancel_run(self, run_id: str) -> None:
        return None


def test_a_conversation_carries_on_when_its_session_is_gone(services):
    """The transcript kept here stands in for a session that cannot be reopened."""
    backend = ForgetfulBackend()
    services.runner._backend = backend
    conversation_id = services.runner.create_conversation(None)
    services.runner.submit(conversation_id=conversation_id, prompt="What does paper one assume?")
    settle(services)
    services.db.execute(
        "UPDATE conversations SET backend_session_id = 'gone' WHERE id = ?", (conversation_id,)
    )

    services.runner.submit(conversation_id=conversation_id, prompt="And paper two?")
    settle(services)

    first, refused, fresh = backend.requests
    assert first.backend_session_id is None
    assert refused.backend_session_id == "gone"
    assert fresh.backend_session_id is None
    assert "What does paper one assume?" in fresh.prompt
    assert "Carrying on." in fresh.prompt
    assert fresh.prompt.rstrip().endswith("And paper two?")

    conversation = services.runner.conversation(conversation_id)
    turn = conversation["turns"][-1]
    assert turn["status"] == "succeeded" and turn["error"] is None
    kinds = [event["type"] for event in turn["events"]]
    assert "notice" in kinds and "error" not in kinds
    assert conversation["backend_session_id"] == "fresh"


def test_a_failure_that_is_not_about_resuming_is_reported_once(services):
    """With no saved session there is nothing to fall back from."""

    class Broken(ForgetfulBackend):
        async def start_run(self, request: RunRequest) -> AsyncIterator[AgentEvent]:
            self.requests.append(request)
            yield AgentEvent.error("Rate limited.")
            yield AgentEvent(DONE, {"terminal_reason": "error"})

    backend = Broken()
    services.runner._backend = backend
    conversation_id = services.runner.create_conversation(None)
    services.runner.submit(conversation_id=conversation_id, prompt="Hello")
    settle(services)
    assert len(backend.requests) == 1
    (turn,) = services.runner.conversation(conversation_id)["turns"]
    assert turn["status"] == "failed"
    assert turn["error"] == "Rate limited."


# ------------------------------------------------------- an older project


def test_a_project_from_an_older_version_still_opens(tmp_path):
    """Columns added since are added to a database that predates them."""
    path = tmp_path / "state.sqlite"
    old = sqlite3.connect(path)
    old.executescript(
        """
        CREATE TABLE conversations (
            id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Conversation',
            backend_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE runs (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'chat', backend_session_id TEXT, error TEXT,
            started_at TEXT NOT NULL, ended_at TEXT
        );
        INSERT INTO conversations VALUES ('conv-old', 'Research chat', 'abc', '2026-01-01', '2026-01-01');
        INSERT INTO runs VALUES ('run-old', 'conv-old', 'succeeded', 'chat', NULL, NULL, '2026-01-01', NULL);
        """
    )
    old.commit()
    old.close()

    db = Database(path)
    try:
        row = db.query_one("SELECT * FROM conversations WHERE id = 'conv-old'")
        assert row["kind"] == "chat" and row["backend_session_id"] == "abc"
        # Nothing was on screen with it yet, and it is not put away.
        assert row["view_json"] is None and row["closed_at"] is None
        run = db.query_one("SELECT * FROM runs WHERE id = 'run-old'")
        assert run["label"] is None and run["usage_json"] is None
    finally:
        db.close()


# ------------------------------------------------------------------- cost


def test_a_turns_cost_is_what_it_added_to_the_sessions_total(services):
    """A resumed session reports its running total; each turn shows its own share."""

    class Metered(ForgetfulBackend):
        totals = iter([0.84, 0.89, 0.95])

        async def start_run(self, request: RunRequest) -> AsyncIterator[AgentEvent]:
            self.requests.append(request)
            yield AgentEvent("text_delta", {"text": "Done.", "final": True})
            yield AgentEvent(
                DONE,
                {
                    "terminal_reason": "endTurn",
                    "backend_session_id": "one-session",
                    "usage": {"cost_usd": next(self.totals), "num_turns": 1},
                },
            )

    services.runner._backend = Metered()
    conversation_id = services.runner.create_conversation(None)
    for prompt in ("First", "Second", "Third"):
        services.runner.submit(conversation_id=conversation_id, prompt=prompt)
        settle(services)

    usage = [turn["usage"] for turn in services.runner.conversation(conversation_id)["turns"]]
    assert [u["cost_usd"] for u in usage] == pytest.approx([0.84, 0.05, 0.06])
    assert [u["session_cost_usd"] for u in usage] == pytest.approx([0.84, 0.89, 0.95])
    # The browser is told the same figure it will read back later.
    done = [event for event in events_of(services, "done")]
    assert [event["usage"]["cost_usd"] for event in done] == pytest.approx([0.84, 0.05, 0.06])


# ------------------------------------------------------------------ sessions


def test_a_conversation_remembers_what_was_on_screen_with_it(client, services):
    """A session is a conversation and its view: coming back to one is coming back to the work."""
    first = client.post("/api/conversations", json={}).json()["conversation_id"]
    second = client.post("/api/conversations", json={}).json()["conversation_id"]
    assert client.get(f"/api/conversations/{first}").json()["view"] is None

    view = {
        "target": {"kind": "summary", "documentId": "doc-002"},
        "documentId": "doc-002",
        "page": 14,
        "attached": ["doc-002", "doc-005"],
        "library": False,
    }
    assert client.put(f"/api/conversations/{first}/view", json={"view": view}).status_code == 204
    listed = {c["conversation_id"]: c for c in client.get("/api/conversations").json()["conversations"]}
    # Kept as it was given, and each conversation's is its own.
    assert listed[first]["view"] == view
    assert listed[second]["view"] is None
    assert client.get(f"/api/conversations/{first}").json()["view"] == view

    # Saving a view is not something every window needs telling about, and it
    # is not activity: the conversation is no more recently used for it.
    before = listed[first]["updated_at"]
    events = services.db.query("SELECT seq FROM events WHERE type = 'conversation_updated'")
    client.put(f"/api/conversations/{first}/view", json={"view": {**view, "page": 15}})
    assert services.db.query("SELECT seq FROM events WHERE type = 'conversation_updated'") == events
    assert client.get(f"/api/conversations/{first}").json()["updated_at"] == before

    too_much = {"attached": ["doc-001"] * 2000}
    assert client.put(f"/api/conversations/{first}/view", json={"view": too_much}).status_code == 422
    assert client.put("/api/conversations/conv-absent/view", json={"view": view}).status_code == 404
    background = services.runner.system_conversation()
    assert client.put(f"/api/conversations/{background}/view", json={"view": view}).status_code == 422


def test_a_session_is_put_away_and_brought_back_with_nothing_lost(client, services):
    conversation_id = client.post("/api/conversations", json={}).json()["conversation_id"]
    client.put(f"/api/conversations/{conversation_id}/view", json={"view": {"library": True}})
    assert client.get(f"/api/conversations/{conversation_id}").json()["closed"] is False

    closed = client.patch(f"/api/conversations/{conversation_id}", json={"closed": True})
    assert closed.status_code == 200 and closed.json()["closed"] is True
    # Still there, still listed, with its view: only out of the row of sessions.
    kept = client.get(f"/api/conversations/{conversation_id}").json()
    assert kept["closed"] is True and kept["view"] == {"library": True}

    renamed = client.patch(
        f"/api/conversations/{conversation_id}", json={"title": "Markups", "closed": False}
    ).json()
    assert (renamed["title"], renamed["closed"]) == ("Markups", False)
    assert client.patch(f"/api/conversations/{conversation_id}", json={}).status_code == 422
