"""Operational state: conversations, durable events, jobs, runs, change log.

The database never owns user material. Notes, PDFs, summaries, and the
reference registry stay on disk so the project remains usable without this app.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .workspace import utcnow

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id                 TEXT PRIMARY KEY,
    title              TEXT NOT NULL DEFAULT 'Conversation',
    -- 'chat' is a conversation the user holds; 'system' collects background
    -- work (automatic summaries) so it never clutters the list of chats.
    kind               TEXT NOT NULL DEFAULT 'chat',
    backend_session_id TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    run_id          TEXT,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    context_json    TEXT,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_conversation
    ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS runs (
    id                 TEXT PRIMARY KEY,
    conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status             TEXT NOT NULL,
    kind               TEXT NOT NULL DEFAULT 'chat',
    backend_session_id TEXT,
    error              TEXT,
    -- What a run without a user message is for ("Summary of <title>").
    label              TEXT,
    -- Duration, turns, and cost as the backend reported them.
    usage_json         TEXT,
    started_at         TEXT NOT NULL,
    ended_at           TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_status ON runs(status);

-- Durable, globally monotonic sequence IDs let a reconnecting client replay
-- from its last seen event without duplicating messages or edits.
CREATE TABLE IF NOT EXISTS events (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    run_id          TEXT,
    type            TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_conversation ON events(conversation_id, seq);

CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status       TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(status, created_at);

-- One row per committed edit, so a change can be reviewed and undone.
CREATE TABLE IF NOT EXISTS changes (
    id             TEXT PRIMARY KEY,
    target_kind    TEXT NOT NULL,
    target_id      TEXT NOT NULL,
    run_id         TEXT,
    origin         TEXT NOT NULL,
    summary        TEXT NOT NULL DEFAULT '',
    base_revision  TEXT,
    new_revision   TEXT,
    snapshot_path  TEXT,
    undone_at      TEXT,
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_by_target ON changes(target_kind, target_id, created_at);
"""

# Columns added after the first release. `CREATE TABLE IF NOT EXISTS` leaves an
# existing table as it was, so a project created by an older version gets them
# here, and its conversations and runs carry on.
ADDED_COLUMNS = (
    ("conversations", "kind", "TEXT NOT NULL DEFAULT 'chat'"),
    ("runs", "label", "TEXT"),
    ("runs", "usage_json", "TEXT"),
)


class Database:
    """Thin SQLite wrapper shared by the whole process.

    SQLite is used from both the event loop and worker threads, so the
    connection is created with ``check_same_thread=False`` and every statement
    runs under a single re-entrant lock.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        with self._lock:
            self._conn.executescript(SCHEMA)
            for table, column, declaration in ADDED_COLUMNS:
                present = {row["name"] for row in self._conn.execute(f"PRAGMA table_info({table})")}
                if column not in present:
                    self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self.tx() as conn:
            return conn.execute(sql, params)

    def query(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._conn.execute(sql, params))

    def query_one(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    # ---------------------------------------------------------------- meta

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self.query_one("SELECT value FROM meta WHERE key = ?", (key,))
        return row["value"] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    # -------------------------------------------------------------- events

    def append_event(
        self,
        *,
        type: str,
        payload: dict[str, Any],
        conversation_id: str | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Persist an event and return it with its assigned sequence ID."""
        created_at = utcnow()
        with self.tx() as conn:
            cursor = conn.execute(
                "INSERT INTO events(conversation_id, run_id, type, payload_json, created_at) "
                "VALUES(?, ?, ?, ?, ?)",
                (conversation_id, run_id, type, json.dumps(payload), created_at),
            )
            seq = int(cursor.lastrowid or 0)
        return {
            "seq": seq,
            "type": type,
            "conversation_id": conversation_id,
            "run_id": run_id,
            "created_at": created_at,
            **payload,
        }

    def events_since(
        self, seq: int, *, conversation_id: str | None = None, limit: int = 1000
    ) -> list[dict[str, Any]]:
        if conversation_id is None:
            rows = self.query(
                "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", (seq, limit)
            )
        else:
            rows = self.query(
                "SELECT * FROM events WHERE seq > ? AND "
                "(conversation_id = ? OR conversation_id IS NULL) ORDER BY seq LIMIT ?",
                (seq, conversation_id, limit),
            )
        return [_event_row_to_dict(row) for row in rows]

    def events_of_conversation(self, conversation_id: str) -> list[dict[str, Any]]:
        """Every durable event of one conversation, oldest first."""
        rows = self.query(
            "SELECT * FROM events WHERE conversation_id = ? ORDER BY seq", (conversation_id,)
        )
        return [_event_row_to_dict(row) for row in rows]

    def latest_seq(self) -> int:
        row = self.query_one("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")
        return int(row["seq"]) if row else 0


def _event_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    payload = json.loads(row["payload_json"])
    return {
        "seq": row["seq"],
        "type": row["type"],
        "conversation_id": row["conversation_id"],
        "run_id": row["run_id"],
        "created_at": row["created_at"],
        **payload,
    }
