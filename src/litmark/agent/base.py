"""The provider-neutral agent interface.

One live backend is implemented (the Claude Agent SDK) plus a deterministic
fake used by tests. Everything above this module sees only normalized events.
"""

from __future__ import annotations

import abc
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

# Normalized event names, shared with events.py and the browser.
TEXT_DELTA = "text_delta"
TOOL_STARTED = "tool_started"
TOOL_FINISHED = "tool_finished"
FILE_PROPOSED = "file_proposed"
FILE_CHANGED = "file_changed"
ERROR = "error"
DONE = "done"


@dataclass
class AgentEvent:
    type: str
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def text(cls, text: str) -> AgentEvent:
        return cls(TEXT_DELTA, {"text": text})

    @classmethod
    def error(cls, message: str, *, kind: str = "backend_error") -> AgentEvent:
        return cls(ERROR, {"message": message, "kind": kind})


@dataclass
class RunContext:
    """The explicit context attached to a chat message.

    This is *starting* context — it does not assert that the agent has read
    every attached paper. The agent is expected to search and read pages.
    """

    note_id: str | None = None
    note_revision: str | None = None
    selection: str | None = None
    document_ids: list[str] = field(default_factory=list)
    reference_id: str | None = None
    page_number: int | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "note_id": self.note_id,
            "note_revision": self.note_revision,
            "selection": self.selection,
            "document_ids": self.document_ids,
            "reference_id": self.reference_id,
            "page_number": self.page_number,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any] | None) -> RunContext:
        data = data or {}
        return cls(
            note_id=data.get("note_id"),
            note_revision=data.get("note_revision"),
            selection=data.get("selection"),
            document_ids=list(data.get("document_ids") or []),
            reference_id=data.get("reference_id"),
            page_number=data.get("page_number"),
        )

    def describe(self) -> str:
        """A short plain-text description injected ahead of the user's message."""
        lines: list[str] = []
        if self.note_id:
            lines.append(f"- Active note: {self.note_id} (revision {self.note_revision})")
        if self.document_ids:
            lines.append(f"- Attached documents: {', '.join(self.document_ids)}")
        if self.reference_id:
            lines.append(f"- Currently open source: {self.reference_id}")
        if self.page_number:
            lines.append(f"- Currently open page: {self.page_number}")
        if self.selection:
            snippet = self.selection if len(self.selection) < 2000 else self.selection[:2000] + "…"
            lines.append(f"- Selected text:\n<selection>\n{snippet}\n</selection>")
        if not lines:
            return ""
        header = (
            "Context for this message (starting points, not a claim that every "
            "attached paper has been read):"
        )
        return header + "\n" + "\n".join(lines)


@dataclass
class RunRequest:
    run_id: str
    conversation_id: str
    prompt: str
    context: RunContext
    backend_session_id: str | None = None
    kind: str = "chat"  # "chat" or "summary"
    # What the session chose to be answered by; None is the backend's default.
    model: str | None = None
    effort: str | None = None


@dataclass
class Availability:
    """What `doctor` and the interface need to know about the backend."""

    backend: str
    installed: bool
    authenticated: bool
    message: str
    detail: str | None = None

    @property
    def ready(self) -> bool:
        return self.installed and self.authenticated

    def to_json(self) -> dict[str, Any]:
        return {
            "backend": self.backend,
            "installed": self.installed,
            "authenticated": self.authenticated,
            "ready": self.ready,
            "message": self.message,
            "detail": self.detail,
        }


class AgentBackend(abc.ABC):
    """A chat backend that can read the project and propose file edits."""

    name: str = "unknown"
    # What a session may choose from. A model outside `models` can still be
    # named; an effort outside `efforts` cannot.
    models: tuple[str, ...] = ()
    efforts: tuple[str, ...] = ()

    def defaults(self) -> tuple[str | None, str | None]:
        """The model and effort a run gets when its session chose neither."""
        return None, None

    @abc.abstractmethod
    def availability(self) -> Availability:
        """Report installation and authentication without printing secrets."""

    @abc.abstractmethod
    def start_run(self, request: RunRequest) -> AsyncIterator[AgentEvent]:
        """Run one turn, yielding normalized events until ``done``."""

    @abc.abstractmethod
    async def cancel_run(self, run_id: str) -> None:
        """Cancel backend work. Hiding the output is not cancellation."""

    def supports_resume(self) -> bool:
        return False
