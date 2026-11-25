"""Run scheduling, persistence, and cancellation.

Runs are serialized per conversation and conversations run side by side, up to
a limit: a long question in one does not hold up a quick one in another. Edits
stay safe because every write is version-checked, whoever makes it. Automatic
summaries are background work with a conversation of their own, so they take
one lane between them, and an explicit user request is started ahead of queued
summary work whenever lanes are scarce.

Every run's events are persisted with durable sequence IDs before they are
broadcast, so a reconnecting browser can replay without duplicating messages or
edits — and the same events, read back, are how an earlier conversation is
drawn again. Only the partial text of a reply as it streams is not written
down: the finished block replaces it.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import logging
import uuid
from collections import deque
from collections.abc import AsyncIterator
from typing import Any

from ..db import Database
from ..documents import QUEUED, READY, UNAVAILABLE, DocumentStore
from ..errors import AgentUnavailable, InvalidInput, NotFound
from ..events import (
    CONVERSATION_UPDATED,
    DONE,
    ERROR,
    MESSAGE_ADDED,
    NOTICE,
    RUN_QUEUED,
    RUN_STARTED,
    TEXT_DELTA,
    EventBus,
)
from ..workspace import Workspace, utcnow
from .base import AgentBackend, AgentEvent, RunContext, RunRequest
from ..skills import read_skill
from .prompts import summary_prompt

log = logging.getLogger(__name__)

QUEUED_STATUS = "queued"
RUNNING = "running"
SUCCEEDED = "succeeded"
FAILED = "failed"
CANCELLED = "cancelled"
INTERRUPTED = "interrupted"
FINISHED = (SUCCEEDED, FAILED, CANCELLED, INTERRUPTED)

CHAT = "chat"
SYSTEM = "system"
SYSTEM_TITLE = "Background work"
UNTITLED = "New conversation"
# Titles a conversation is created with before anything has been asked in it.
# The first message replaces them; a title the user typed is never replaced.
PLACEHOLDER_TITLES = {"", "Conversation", "Research chat", UNTITLED}
MAX_TITLE = 80
# A view is a handful of IDs and a page number; this is room to spare.
MAX_VIEW_CHARS = 8000


def _view_of(encoded: str | None) -> dict[str, Any] | None:
    """A saved view, or nothing where there is none or it cannot be read."""
    if not encoded:
        return None
    try:
        view = json.loads(encoded)
    except ValueError:
        return None
    return view if isinstance(view, dict) else None
DEFAULT_PARALLEL_RUNS = 3
# How much of a saved transcript a new backend session is told, when the one
# the conversation was held in can no longer be reopened.
MAX_RECALLED_CHARS = 24_000


class AgentRunner:
    def __init__(
        self,
        *,
        db: Database,
        bus: EventBus,
        workspace: Workspace,
        documents: DocumentStore,
        backend: AgentBackend,
        max_parallel: int = DEFAULT_PARALLEL_RUNS,
    ) -> None:
        self._db = db
        self._bus = bus
        self._workspace = workspace
        self._documents = documents
        self._backend = backend
        self._max_parallel = max(1, int(max_parallel))
        self._user_queue: deque[str] = deque()
        self._summary_queue: deque[str] = deque()
        # run id -> (prompt, context, conversation id), until the run starts.
        self._pending: dict[str, tuple[str, RunContext, str]] = {}
        # run id -> (conversation id, task), while the run is going.
        self._running: dict[str, tuple[str, asyncio.Task[None]]] = {}
        self._wake = asyncio.Event()
        self._worker: asyncio.Task[None] | None = None
        self._loop_ref: asyncio.AbstractEventLoop | None = None
        self._stopping = False

    @property
    def backend(self) -> AgentBackend:
        return self._backend

    # ------------------------------------------------------------ lifecycle

    def start(self) -> None:
        """Start the worker if a loop is running.

        Submitting outside a running loop is legitimate — a job thread can
        queue a summary — so the run simply stays queued until the serving
        loop starts and picks it up.
        """
        if self._worker is not None and not self._worker.done():
            return
        try:
            self._loop_ref = asyncio.get_running_loop()
        except RuntimeError:
            return
        # Started again after a stop, possibly on another loop: the wake-up
        # belongs to the loop that waits on it.
        self._stopping = False
        self._wake = asyncio.Event()
        self._worker = asyncio.ensure_future(self._loop())

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        for _, task in list(self._running.values()):
            task.cancel()
        for _, task in list(self._running.values()):
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if self._worker is not None:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None

    def recover(self) -> int:
        """Mark runs that were in flight when the process stopped."""
        rows = self._db.query(
            "SELECT id, conversation_id FROM runs WHERE status IN (?, ?)",
            (RUNNING, QUEUED_STATUS),
        )
        for row in rows:
            self._db.execute(
                "UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?",
                (
                    INTERRUPTED,
                    utcnow(),
                    "The server restarted while this run was in progress.",
                    row["id"],
                ),
            )
            self._bus.publish(
                DONE,
                {
                    "terminal_reason": INTERRUPTED,
                    "status": INTERRUPTED,
                    "message": "This run was interrupted by a server restart.",
                },
                conversation_id=row["conversation_id"],
                run_id=row["id"],
            )
        return len(rows)

    # --------------------------------------------------------- conversation

    def create_conversation(self, title: str | None = "Conversation", *, kind: str = CHAT) -> str:
        conversation_id = f"conv-{uuid.uuid4().hex[:12]}"
        now = utcnow()
        self._db.execute(
            "INSERT INTO conversations(id, title, kind, created_at, updated_at) "
            "VALUES(?, ?, ?, ?, ?)",
            (conversation_id, (title or "").strip(), kind, now, now),
        )
        self._announce(conversation_id, "created")
        return conversation_id

    def default_conversation(self) -> str:
        """The oldest chat, or a new one. Never the background conversation."""
        row = self._db.query_one(
            "SELECT id FROM conversations WHERE kind = ? ORDER BY created_at, rowid LIMIT 1",
            (CHAT,),
        )
        return row["id"] if row else self.create_conversation()

    def system_conversation(self) -> str:
        """Where background work runs, out of the way of the user's chats."""
        row = self._db.query_one(
            "SELECT id FROM conversations WHERE kind = ? ORDER BY created_at, rowid LIMIT 1",
            (SYSTEM,),
        )
        return row["id"] if row else self.create_conversation(SYSTEM_TITLE, kind=SYSTEM)

    def rename_conversation(self, conversation_id: str, title: str) -> dict[str, Any]:
        title = " ".join(title.split())
        if not title:
            raise InvalidInput("A conversation needs a name.")
        row = self._require(conversation_id)
        if row["kind"] != CHAT:
            raise InvalidInput("The background conversation cannot be renamed.")
        self._db.execute(
            "UPDATE conversations SET title = ? WHERE id = ?",
            (title[:200], conversation_id),
        )
        self._announce(conversation_id, "renamed")
        return self._summary_of(self._require(conversation_id))

    def save_view(self, conversation_id: str, view: dict[str, Any]) -> None:
        """Remember what was on screen with a conversation.

        The view is the window's business — which note, which paper, which
        page — and is kept as it was given. Nobody is told: it changes with
        every click, and each window knows its own.
        """
        row = self._require(conversation_id)
        if row["kind"] != CHAT:
            raise InvalidInput("Background work has no view to come back to.")
        encoded = json.dumps(view, ensure_ascii=False, separators=(",", ":"))
        if len(encoded) > MAX_VIEW_CHARS:
            raise InvalidInput("That is more than the view of one session holds.")
        self._db.execute(
            "UPDATE conversations SET view_json = ? WHERE id = ?", (encoded, conversation_id)
        )

    def set_closed(self, conversation_id: str, closed: bool) -> dict[str, Any]:
        """Put a session away, or bring it back. Nothing of it is deleted."""
        row = self._require(conversation_id)
        if row["kind"] != CHAT:
            raise InvalidInput("Background work is not a session to put away.")
        self._db.execute(
            "UPDATE conversations SET closed_at = ? WHERE id = ?",
            (utcnow() if closed else None, conversation_id),
        )
        self._announce(conversation_id, "closed" if closed else "reopened")
        return self._summary_of(self._require(conversation_id))

    def delete_conversation(self, conversation_id: str) -> dict[str, Any]:
        """Forget a conversation. Notes and summaries it edited are files; they stay."""
        row = self._require(conversation_id)
        if row["kind"] != CHAT:
            raise InvalidInput("The background conversation cannot be deleted.")
        if self._active_runs(conversation_id):
            raise InvalidInput("Stop the run in this conversation before deleting it.")
        with self._db.tx() as conn:
            conn.execute("DELETE FROM events WHERE conversation_id = ?", (conversation_id,))
            conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
        self._announce(conversation_id, "deleted")
        return {"conversation_id": conversation_id, "deleted": True}

    def conversation(self, conversation_id: str) -> dict[str, Any]:
        row = self._require(conversation_id)
        # Read before the events, so anything later than this is either in the
        # events below or still to come on the stream — never lost between.
        latest_seq = self._db.latest_seq()
        messages = self._db.query(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid",
            (conversation_id,),
        )
        runs = self._db.query(
            "SELECT * FROM runs WHERE conversation_id = ? ORDER BY started_at, rowid",
            (conversation_id,),
        )
        events: dict[str, list[dict[str, Any]]] = {}
        for event in self._db.events_of_conversation(conversation_id):
            if event.get("run_id"):
                events.setdefault(event["run_id"], []).append(event)

        asked = {m["run_id"]: m for m in messages if m["role"] == "user" and m["run_id"]}
        replied: dict[str, list[str]] = {}
        for message in messages:
            if message["role"] == "assistant" and message["run_id"]:
                replied.setdefault(message["run_id"], []).append(message["content"])

        turns = []
        for run in runs:
            run_id = run["id"]
            turn = _run_json(run)
            turn["message"] = _message_json(asked[run_id]) if run_id in asked else None
            turn["reply"] = "\n\n".join(replied[run_id]) if run_id in replied else None
            turn["events"] = events.get(run_id, [])
            turns.append(turn)

        return {
            **self._summary_of(row),
            "backend_session_id": row["backend_session_id"],
            "messages": [_message_json(m) for m in messages],
            # Newest first, as it has always been; `turns` is the ordered view.
            "runs": [_run_json(r) for r in reversed(runs[-20:])],
            "turns": turns,
            "latest_seq": latest_seq,
        }

    def list_conversations(self) -> list[dict[str, Any]]:
        """The user's chats, most recently used first, then background work.

        The background conversation is listed only once it has done something.
        """
        rows = self._db.query("SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC")
        chats = [self._summary_of(row) for row in rows if row["kind"] == CHAT]
        background = [
            summary
            for summary in (self._summary_of(row) for row in rows if row["kind"] != CHAT)
            if summary["turn_count"]
        ]
        return chats + background

    def kind_of(self, conversation_id: str) -> str:
        return str(self._require(conversation_id)["kind"])

    def _require(self, conversation_id: str) -> Any:
        row = self._db.query_one("SELECT * FROM conversations WHERE id = ?", (conversation_id,))
        if row is None:
            raise NotFound(f"No conversation {conversation_id!r}.")
        return row

    def _active_runs(self, conversation_id: str) -> list[str]:
        rows = self._db.query(
            "SELECT id FROM runs WHERE conversation_id = ? AND status IN (?, ?)",
            (conversation_id, RUNNING, QUEUED_STATUS),
        )
        return [row["id"] for row in rows]

    def _summary_of(self, row: Any) -> dict[str, Any]:
        """One line of a conversation list: what it is and what it is doing."""
        conversation_id = row["id"]
        counts = self._db.query(
            "SELECT status, COUNT(*) AS n FROM runs WHERE conversation_id = ? GROUP BY status",
            (conversation_id,),
        )
        by_status = {count["status"]: int(count["n"]) for count in counts}
        if by_status.get(RUNNING):
            status = RUNNING
        elif by_status.get(QUEUED_STATUS):
            status = QUEUED_STATUS
        else:
            status = "idle"
        last = self._db.query_one(
            "SELECT status FROM runs WHERE conversation_id = ? "
            "ORDER BY started_at DESC, rowid DESC LIMIT 1",
            (conversation_id,),
        )
        return {
            "conversation_id": conversation_id,
            "title": row["title"] or UNTITLED,
            # Not yet named for anything asked in it.
            "untitled": not row["title"],
            "kind": row["kind"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "turn_count": sum(by_status.values()),
            "status": status,
            "last_run_status": last["status"] if last else None,
            # Whether the backend can pick the thread up where it stopped.
            "resumable": bool(row["backend_session_id"]),
            # What was on screen with it, as the window last left it.
            "view": _view_of(row["view_json"]),
            "closed": bool(row["closed_at"]),
        }

    def _announce(self, conversation_id: str, change: str) -> None:
        """Tell every open window the list of conversations is no longer current."""
        self._bus.publish(CONVERSATION_UPDATED, {"change": change}, conversation_id=conversation_id)

    def transcript_markdown(self, conversation_id: str) -> str:
        data = self.conversation(conversation_id)
        lines = [f"# {data['title']}", ""]
        for message in data["messages"]:
            who = "You" if message["role"] == "user" else "Assistant"
            lines.append(f"## {who} · {message['created_at']}")
            lines.append("")
            lines.append(message["content"].strip() or "_(no text)_")
            lines.append("")
        return "\n".join(lines)

    # ------------------------------------------------------------- submitting

    def submit(
        self,
        *,
        conversation_id: str,
        prompt: str,
        context: RunContext | None = None,
        kind: str = "chat",
        label: str | None = None,
    ) -> dict[str, Any]:
        availability = self._backend.availability()
        if not availability.ready:
            details = availability.to_json()
            details.pop("message", None)
            raise AgentUnavailable(availability.message, **details)
        if not prompt.strip():
            raise InvalidInput("An empty message cannot be sent.")

        context = context or RunContext()
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        now = utcnow()

        # The run exists before anything refers to it, so a browser that hears
        # about the message can already find the run it belongs to.
        self._db.execute(
            "INSERT INTO runs(id, conversation_id, status, kind, label, started_at) "
            "VALUES(?, ?, ?, ?, ?, ?)",
            (run_id, conversation_id, QUEUED_STATUS, kind, label, now),
        )
        if kind == "chat":
            self._title_from_first_message(conversation_id, prompt)
            message_id = f"msg-{uuid.uuid4().hex[:12]}"
            self._db.execute(
                "INSERT INTO messages(id, conversation_id, run_id, role, content, "
                "context_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    message_id,
                    conversation_id,
                    run_id,
                    "user",
                    prompt,
                    json.dumps(context.to_json()),
                    now,
                ),
            )
            self._bus.publish(
                MESSAGE_ADDED,
                {
                    "message_id": message_id,
                    "role": "user",
                    "content": prompt,
                    "context": context.to_json(),
                    "created_at": now,
                },
                conversation_id=conversation_id,
                run_id=run_id,
            )
        else:
            self._bus.publish(
                RUN_QUEUED,
                {"kind": kind, "label": label, "started_at": now},
                conversation_id=conversation_id,
                run_id=run_id,
            )

        self._db.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id)
        )
        self._pending[run_id] = (prompt, context, conversation_id)
        loop = self._loop_ref
        if loop is not None and _running_loop() is not loop and not loop.is_closed():
            # Queued from a job thread: the queues belong to the serving loop.
            loop.call_soon_threadsafe(self._enqueue, run_id, kind)
        else:
            self._enqueue(run_id, kind)
            self.start()
        return {"run_id": run_id, "conversation_id": conversation_id, "status": QUEUED_STATUS}

    def _enqueue(self, run_id: str, kind: str) -> None:
        (self._user_queue if kind == "chat" else self._summary_queue).append(run_id)
        self._wake.set()

    def _title_from_first_message(self, conversation_id: str, prompt: str) -> None:
        """A conversation is named for the first thing asked in it."""
        row = self._db.query_one(
            "SELECT title, kind FROM conversations WHERE id = ?", (conversation_id,)
        )
        if row is None or row["kind"] != CHAT or row["title"] not in PLACEHOLDER_TITLES:
            return
        asked = self._db.query_one(
            "SELECT 1 AS present FROM messages WHERE conversation_id = ? AND role = 'user' LIMIT 1",
            (conversation_id,),
        )
        if asked is not None:
            return  # An older conversation that was never named keeps its name.
        title = " ".join(prompt.split())
        if len(title) > MAX_TITLE:
            title = title[: MAX_TITLE - 1].rstrip() + "…"
        self._db.execute(
            "UPDATE conversations SET title = ? WHERE id = ?", (title, conversation_id)
        )
        self._announce(conversation_id, "renamed")

    def queue_summary(self, document_id: str) -> str | None:
        """Queue an automatic summary if extraction and the agent permit it."""
        document = self._documents.get(document_id)
        if document.extraction.get("status") != "ok":
            return None
        if document.extraction.get("quality") == "none":
            self._documents.set_summary_status(
                document_id,
                UNAVAILABLE,
                error="No text could be extracted, so no summary can be written.",
            )
            return None
        if not self._backend.availability().ready:
            self._documents.set_summary_status(
                document_id,
                UNAVAILABLE,
                error="Connect an agent backend to generate summaries.",
            )
            return None

        prompt = summary_prompt(
            document_id=document_id,
            title=document.display_title,
            quality=document.extraction.get("quality"),
            warnings=document.extraction.get("warnings") or [],
            authors=document.authors,
            year=document.year,
            details_confirmed=document.details_by is not None,
            # As the reader wants it, as of now: what they said in conversation
            # since the last summary is in the next one.
            skill=str(read_skill(self._workspace)["text"]),
        )
        self._documents.set_summary_status(document_id, QUEUED)
        result = self.submit(
            # Background work has a conversation of its own, so a summary never
            # lands in the middle of what the user is discussing.
            conversation_id=self.system_conversation(),
            prompt=prompt,
            context=RunContext(document_ids=[document_id]),
            kind="summary",
            label=f"Summary of {document.display_title}",
        )
        return str(result["run_id"])

    async def cancel(self, run_id: str) -> dict[str, Any]:
        """Stop a run, cancelling backend work rather than hiding its output."""
        if run_id in self._user_queue:
            self._user_queue.remove(run_id)
        if run_id in self._summary_queue:
            self._summary_queue.remove(run_id)
        pending = self._pending.pop(run_id, None)

        await self._backend.cancel_run(run_id)
        running = self._running.get(run_id)
        if running is not None:
            running[1].cancel()
        row = self._db.query_one(
            "SELECT status, conversation_id FROM runs WHERE id = ?", (run_id,)
        )
        if row is not None and row["status"] == QUEUED_STATUS and running is None:
            # Never started: there is no backend to say it is over, so say it here.
            self._finish(run_id, CANCELLED)
            self._bus.publish(
                DONE,
                {"terminal_reason": "cancelled", "status": CANCELLED},
                conversation_id=row["conversation_id"],
                run_id=run_id,
            )
            if pending is not None:
                self._settle_summary_if_any(run_id, pending[1], "The summary was cancelled.")
        return {"run_id": run_id, "status": CANCELLED}

    # ------------------------------------------------------------- the loop

    async def _loop(self) -> None:
        while not self._stopping:
            self._dispatch()
            self._wake.clear()
            await self._wake.wait()

    def _dispatch(self) -> None:
        """Start whatever can start: one run per conversation, chats first."""
        busy = {conversation_id for conversation_id, _ in self._running.values()}
        for queue in (self._user_queue, self._summary_queue):
            for run_id in list(queue):
                if len(self._running) >= self._max_parallel:
                    return
                entry = self._pending.get(run_id)
                if entry is None:
                    queue.remove(run_id)
                    continue
                conversation_id = entry[2]
                if conversation_id in busy:
                    continue  # Its turn comes when the one ahead of it is done.
                queue.remove(run_id)
                busy.add(conversation_id)
                task = asyncio.ensure_future(self._guarded(run_id))
                self._running[run_id] = (conversation_id, task)

    async def _guarded(self, run_id: str) -> None:
        """One run, start to finish; whatever happens, the lane is freed."""
        try:
            await self._execute(run_id)
        except asyncio.CancelledError:
            self._finish(run_id, CANCELLED)
        except Exception:  # noqa: BLE001 - one bad run must not take the others down
            log.exception("Run %s crashed", run_id)
            message = "The run crashed unexpectedly."
            self._finish(run_id, FAILED, error=message)
            row = self._db.query_one("SELECT conversation_id FROM runs WHERE id = ?", (run_id,))
            conversation_id = row["conversation_id"] if row else None
            self._bus.publish(
                ERROR, {"message": message}, conversation_id=conversation_id, run_id=run_id
            )
            self._bus.publish(
                DONE,
                {"terminal_reason": "error", "status": FAILED},
                conversation_id=conversation_id,
                run_id=run_id,
            )
        finally:
            self._running.pop(run_id, None)
            self._wake.set()

    async def _execute(self, run_id: str) -> None:
        entry = self._pending.pop(run_id, None)
        row = self._db.query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
        if entry is None or row is None:
            return
        prompt, context, _ = entry
        conversation_id = row["conversation_id"]
        kind = row["kind"]

        conversation = self._db.query_one(
            "SELECT backend_session_id, kind FROM conversations WHERE id = ?", (conversation_id,)
        )
        # A chat carries on where the backend left it. Background work does not:
        # each summary starts clean, with nothing of the last paper in mind.
        session_id = (
            conversation["backend_session_id"]
            if conversation and conversation["kind"] == CHAT
            else None
        )

        self._db.execute(
            "UPDATE runs SET status = ? WHERE id = ?", (RUNNING, run_id)
        )
        self._bus.publish(
            RUN_STARTED,
            {"kind": kind, "backend": self._backend.name, "label": row["label"]},
            conversation_id=conversation_id,
            run_id=run_id,
        )

        request = RunRequest(
            run_id=run_id,
            conversation_id=conversation_id,
            prompt=prompt,
            context=context,
            backend_session_id=session_id,
            kind=kind,
        )

        text_parts: list[str] = []
        # The block being streamed: fragments the finished block will replace.
        streaming: list[str] = []
        errored: str | None = None
        terminal = "endTurn"
        done_seen = False

        def flush_streaming() -> None:
            """Keep a block that never arrived whole: the run stopped mid-sentence."""
            text = "".join(streaming)
            streaming.clear()
            if text.strip():
                text_parts.append(text)
                self._bus.publish(
                    TEXT_DELTA,
                    {"text": text, "final": True, "unfinished": True},
                    conversation_id=conversation_id,
                    run_id=run_id,
                )

        try:
            async for event in self._events(request):
                payload = dict(event.data)
                if event.type == TEXT_DELTA and payload.get("partial"):
                    # Live only, with where it belongs in the block, so a
                    # browser that missed a fragment knows not to guess.
                    payload["offset"] = sum(len(part) for part in streaming)
                    streaming.append(str(payload.get("text", "")))
                    self._bus.publish_transient(
                        event.type, payload, conversation_id=conversation_id, run_id=run_id
                    )
                    continue
                if event.type == TEXT_DELTA:
                    if payload.get("final"):
                        streaming.clear()
                    text_parts.append(str(payload.get("text", "")))
                elif event.type != DONE:
                    flush_streaming()
                if event.type == ERROR:
                    errored = str(payload.get("message", "The run failed."))
                if event.type == DONE:
                    flush_streaming()
                    done_seen = True
                    terminal = str(payload.get("terminal_reason", "endTurn"))
                    new_session = payload.get("backend_session_id")
                    if new_session and conversation and conversation["kind"] == CHAT:
                        self._db.execute(
                            "UPDATE conversations SET backend_session_id = ? WHERE id = ?",
                            (new_session, conversation_id),
                        )
                    usage = payload.get("usage")
                    if isinstance(usage, dict) and usage:
                        usage = self._turn_usage(conversation_id, run_id, new_session, usage)
                        payload["usage"] = usage
                        self._db.execute(
                            "UPDATE runs SET usage_json = ?, backend_session_id = ? WHERE id = ?",
                            (json.dumps(usage), new_session, run_id),
                        )
                    if errored or terminal == "error":
                        payload["status"] = FAILED
                    elif terminal == "cancelled":
                        payload["status"] = CANCELLED
                    else:
                        payload["status"] = SUCCEEDED
                self._bus.publish(
                    event.type, payload, conversation_id=conversation_id, run_id=run_id
                )
        except asyncio.CancelledError:
            flush_streaming()
            if not done_seen:
                self._bus.publish(
                    DONE,
                    {"terminal_reason": "cancelled", "status": CANCELLED},
                    conversation_id=conversation_id,
                    run_id=run_id,
                )
            self._persist_assistant(conversation_id, run_id, text_parts, kind)
            self._finish(run_id, CANCELLED)
            self._settle_summary_if_any(run_id, context, "The summary was cancelled.", kind=kind)
            raise

        flush_streaming()
        if not done_seen:
            self._bus.publish(
                DONE,
                {"terminal_reason": terminal, "status": FAILED if errored else SUCCEEDED},
                conversation_id=conversation_id,
                run_id=run_id,
            )
        self._persist_assistant(conversation_id, run_id, text_parts, kind)
        if kind == "summary":
            self._settle_summary(context, errored)
        if errored or terminal == "error":
            self._finish(run_id, FAILED, error=errored or "The run failed.")
        elif terminal == "cancelled":
            self._finish(run_id, CANCELLED)
        else:
            self._finish(run_id, SUCCEEDED)

    def _turn_usage(
        self,
        conversation_id: str,
        run_id: str,
        session_id: Any,
        usage: dict[str, Any],
    ) -> dict[str, Any]:
        """What this turn cost, when the backend reports the session's total.

        A resumed session's cost keeps counting from where it stood, so the
        figure a run ends with is everything spent in that session so far. The
        turn's own cost is what was added since the run before it.
        """
        total = usage.get("cost_usd")
        if not isinstance(total, (int, float)):
            return usage
        usage = {**usage, "session_cost_usd": total}
        if not session_id:
            return usage
        earlier = self._db.query_one(
            "SELECT usage_json FROM runs WHERE conversation_id = ? AND backend_session_id = ? "
            "AND id != ? AND usage_json IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
            (conversation_id, str(session_id), run_id),
        )
        if earlier is None:
            return usage
        before = json.loads(earlier["usage_json"]).get("session_cost_usd")
        if isinstance(before, (int, float)) and total >= before:
            usage["cost_usd"] = round(total - before, 6)
        return usage

    async def _events(self, request: RunRequest) -> AsyncIterator[AgentEvent]:
        """The backend's events, carrying on in a new session if the old one is gone.

        A conversation outlives the session it was held in: the project
        directory moves, another machine opens it, the backend clears its
        store. When resuming fails before anything has happened, the run starts
        a new session, tells it what was said before, and says so in the reply.
        """
        if not request.backend_session_id:
            async for event in self._backend.start_run(request):
                yield event
            return

        held: list[AgentEvent] = []
        progressed = False
        async for event in self._backend.start_run(request):
            if not progressed and event.type in (ERROR, DONE):
                held.append(event)
                continue
            progressed = True
            for earlier in held:
                yield earlier
            held.clear()
            yield event
        refused = any(event.type == ERROR for event in held)
        cancelled = any(
            event.type == DONE and event.data.get("terminal_reason") == "cancelled"
            for event in held
        )
        if progressed or not refused or cancelled:
            for event in held:
                yield event
            return

        log.info(
            "Session %s of %s could not be resumed; starting a new one",
            request.backend_session_id,
            request.conversation_id,
        )
        yield AgentEvent(
            NOTICE,
            {
                "message": (
                    "The agent's saved session could not be reopened, so this reply "
                    "starts a new one from the transcript kept here."
                ),
                "kind": "session_recovered",
            },
        )
        fresh = dataclasses.replace(
            request,
            backend_session_id=None,
            prompt=self._with_transcript(request.conversation_id, request.run_id, request.prompt),
        )
        async for event in self._backend.start_run(fresh):
            yield event

    def _with_transcript(self, conversation_id: str, run_id: str, prompt: str) -> str:
        """The prompt, preceded by what was said in the conversation before it."""
        rows = self._db.query(
            "SELECT role, content FROM messages WHERE conversation_id = ? AND "
            "(run_id IS NULL OR run_id != ?) ORDER BY created_at, rowid",
            (conversation_id, run_id),
        )
        said: list[str] = []
        budget = MAX_RECALLED_CHARS
        for row in reversed(rows):  # The most recent exchanges matter most.
            text = (row["content"] or "").strip()
            if not text:
                continue
            line = f"{'User' if row['role'] == 'user' else 'Assistant'}: {text}"
            if len(line) > budget:
                break
            budget -= len(line)
            said.append(line)
        if not said:
            return prompt
        earlier = "\n\n".join(reversed(said))
        return (
            "This conversation was started in an earlier session that can no longer be "
            "reopened. What was said in it:\n\n<earlier_conversation>\n"
            f"{earlier}\n</earlier_conversation>\n\n"
            "Files may have changed since; read them again rather than relying on the "
            f"above.\n\nThe user's new message:\n\n{prompt}"
        )

    def _settle_summary_if_any(
        self, run_id: str, context: RunContext, message: str, *, kind: str | None = None
    ) -> None:
        """A summary that will not be written says so, rather than staying queued."""
        if kind is None:
            row = self._db.query_one("SELECT kind FROM runs WHERE id = ?", (run_id,))
            kind = row["kind"] if row else None
        if kind != "summary":
            return
        for document_id in context.document_ids:
            with contextlib.suppress(NotFound):
                if not self._documents.summary_text(document_id):
                    self._documents.set_summary_status(document_id, "failed", error=message)

    def _persist_assistant(
        self, conversation_id: str, run_id: str, parts: list[str], kind: str
    ) -> None:
        text = "".join(parts).strip()
        if not text:
            return
        message_id = f"msg-{uuid.uuid4().hex[:12]}"
        now = utcnow()
        self._db.execute(
            "INSERT INTO messages(id, conversation_id, run_id, role, content, created_at) "
            "VALUES(?, ?, ?, ?, ?, ?)",
            (message_id, conversation_id, run_id, "assistant", text, now),
        )
        self._db.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id)
        )
        self._bus.publish(
            MESSAGE_ADDED,
            {
                "message_id": message_id,
                "role": "assistant",
                "content": text,
                "kind": kind,
                "created_at": now,
            },
            conversation_id=conversation_id,
            run_id=run_id,
        )

    def _settle_summary(self, context: RunContext, errored: str | None) -> None:
        for document_id in context.document_ids:
            try:
                document = self._documents.get(document_id)
            except NotFound:
                continue
            if errored:
                self._documents.set_summary_status(document_id, "failed", error=errored)
            elif self._documents.summary_text(document_id):
                if document.summary.get("status") != READY:
                    self._documents.set_summary_status(document_id, READY)
            else:
                self._documents.set_summary_status(
                    document_id,
                    "failed",
                    error="The run finished without writing a summary.",
                )

    def _finish(self, run_id: str, status: str, *, error: str | None = None) -> None:
        self._db.execute(
            "UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?",
            (status, utcnow(), error, run_id),
        )


def _message_json(row: Any) -> dict[str, Any]:
    return {
        "message_id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "run_id": row["run_id"],
        "context": json.loads(row["context_json"]) if row["context_json"] else None,
        "created_at": row["created_at"],
    }


def _run_json(row: Any) -> dict[str, Any]:
    return {
        "run_id": row["id"],
        "status": row["status"],
        "kind": row["kind"],
        "label": row["label"],
        "error": row["error"],
        "usage": json.loads(row["usage_json"]) if row["usage_json"] else None,
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
    }


def _running_loop() -> asyncio.AbstractEventLoop | None:
    with contextlib.suppress(RuntimeError):
        return asyncio.get_running_loop()
    return None
