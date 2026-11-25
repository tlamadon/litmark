"""A deterministic in-process backend for reproducible UI and event tests.

This exists so tests can exercise streaming, reconnection, cancellation, and
conflict handling without a provider. It is never substituted for a failed live
run: the server reports provider failures honestly and only uses this backend
when it is selected explicitly.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from .base import (
    DONE,
    FILE_CHANGED,
    TEXT_DELTA,
    TOOL_FINISHED,
    TOOL_STARTED,
    AgentBackend,
    AgentEvent,
    Availability,
    RunRequest,
)
from .tools import RUN_TOOLS, ProjectTools, dispatch, trim_result

# Set by tests: a list of scripted steps per run, consumed in order.
# Each step is ("text", "...") or ("tool", name, arguments).
Step = tuple[Any, ...]

# A pseudo-tool the default summary script expands once a reference exists.
WRITE_SUMMARY_STEP = "__write_summary_with_citation"


class FakeBackend(AgentBackend):
    name = "fake"

    def __init__(self, tools: ProjectTools, script: list[Step] | None = None) -> None:
        self._tools = tools
        self.script: list[Step] = script or [("text", "This is a fake agent reply.")]
        # When unset, summary runs get a scripted read → cite → write sequence
        # derived from the document itself, so the summary pipeline is exercised
        # end to end rather than reporting "finished without writing".
        self.summary_script: list[Step] | None = None
        self._cancelled: set[str] = set()
        self.delay = 0.0
        # Between the fragments of a text step, to watch a reply stream.
        self.chunk_delay = 0.0

    def _default_summary_steps(self, request: RunRequest) -> list[Step]:
        document_id = request.context.document_ids[0] if request.context.document_ids else None
        if document_id is None:
            return [("text", "No document was attached, so no summary was written.")]

        quote: str | None = None
        title = document_id
        try:
            document = self._tools.documents.get(document_id)
            title = document.display_title
            page = self._tools.documents.page(document_id, 1)
            first_body = next(
                (line.text for line in page.lines if len(line.text) > 25),
                None,
            )
            quote = first_body
        except Exception:  # noqa: BLE001 - the fake must not raise into the runner
            quote = None

        steps: list[Step] = [
            ("text", f"Reading {title} to write its summary."),
            ("tool", "read_pages", {"document_id": document_id, "pages": [1]}),
        ]
        if quote:
            steps.append(
                (
                    "tool",
                    "resolve_source",
                    {"document_id": document_id, "page_number": 1, "quote": quote},
                )
            )
        steps.append(("tool", WRITE_SUMMARY_STEP, {"document_id": document_id}))
        steps.append(("text", "Summary written."))
        return steps

    def availability(self) -> Availability:
        return Availability(
            backend="fake",
            installed=True,
            authenticated=True,
            message="Fake backend for tests; no provider is contacted.",
        )

    def supports_resume(self) -> bool:
        return True

    async def start_run(self, request: RunRequest) -> AsyncIterator[AgentEvent]:
        self._cancelled.discard(request.run_id)
        script = self.script
        if request.kind == "summary" and self.summary_script is None:
            script = self._default_summary_steps(request)
        elif request.kind == "summary":
            script = self.summary_script or []

        last_reference: str | None = None
        for index, step in enumerate(list(script)):
            if request.run_id in self._cancelled:
                yield AgentEvent(DONE, {"terminal_reason": "cancelled"})
                return
            if self.delay:
                await asyncio.sleep(self.delay)
            if step[0] == "text":
                # As the live backend does it: fragments while the block is
                # being written, then the block whole.
                for chunk in _chunks(step[1]):
                    if self.chunk_delay:
                        await asyncio.sleep(self.chunk_delay)
                    yield AgentEvent(TEXT_DELTA, {"text": chunk, "partial": True})
                yield AgentEvent(TEXT_DELTA, {"text": step[1], "final": True})
            elif step[0] == "tool":
                name, arguments = step[1], dict(step[2])
                if name == WRITE_SUMMARY_STEP:
                    name = "write_summary"
                    arguments = self._summary_arguments(arguments["document_id"], last_reference)
                if name in RUN_TOOLS:
                    arguments.setdefault("run_id", request.run_id)
                tool_use_id = f"fake-{request.run_id}-{index}"
                yield AgentEvent(
                    TOOL_STARTED, {"tool": name, "tool_use_id": tool_use_id, "input": arguments}
                )
                # Off the loop, as the live backend runs them: a tool may wait
                # for the reader, who answers through this same loop.
                result = await asyncio.get_running_loop().run_in_executor(
                    None, dispatch, self._tools, name, arguments
                )
                if name == "resolve_source" and result.get("reference_id"):
                    last_reference = str(result["reference_id"])
                yield AgentEvent(
                    TOOL_FINISHED,
                    {
                        "tool": name,
                        "tool_use_id": tool_use_id,
                        "is_error": result.get("ok") is False,
                        "result": trim_result(result),
                    },
                )
                for change in self._tools.drain_changes(request.run_id):
                    yield AgentEvent(FILE_CHANGED, change)
        yield AgentEvent(
            DONE,
            {"terminal_reason": "endTurn", "backend_session_id": f"fake-{request.conversation_id}"},
        )

    def _summary_arguments(
        self, document_id: str, reference_id: str | None
    ) -> dict[str, Any]:
        """Build a version-checked summary write, citing what was resolved."""
        existing = self._tools.read_summary(document_id)
        citation = f" [p. 1](source:{reference_id})" if reference_id else ""
        text = (
            f"## Summary\n\n"
            f"**Research question.** Placeholder summary produced by the test backend"
            f"{citation}.\n\n"
            f"**Data and method.** Not assessed by the fake backend.\n\n"
            f"**Findings.** Not assessed by the fake backend.\n\n"
            f"**Limitations.** This text comes from a deterministic test backend, "
            f"not from a provider.\n"
        )
        return {
            "document_id": document_id,
            "text": text,
            "expected_revision": existing["revision"],
        }

    async def cancel_run(self, run_id: str) -> None:
        self._cancelled.add(run_id)


def _chunks(text: str, size: int = 24) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)] or [""]
