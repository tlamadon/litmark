"""The live backend: the Claude Agent SDK for Python.

The project tools are exposed through an in-process SDK MCP server, so the
agent's tool loop drives them directly — no terminal screen scraping. Built-in
filesystem and shell tools are disabled: every edit must go through the
version-checked project tools.

Reference: https://code.claude.com/docs/en/agent-sdk/python
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from .. import __version__
from .base import (
    DONE,
    ERROR,
    FILE_CHANGED,
    TEXT_DELTA,
    TOOL_FINISHED,
    TOOL_STARTED,
    AgentBackend,
    AgentEvent,
    Availability,
    RunRequest,
)
from .prompts import SYSTEM_PROMPT
from .tools import TOOL_SCHEMAS, ProjectTools, as_text, dispatch, trim_result

log = logging.getLogger(__name__)

MCP_SERVER_NAME = "research"
DEFAULT_MODEL = "claude-opus-5"

# Tool names as the SDK exposes them once the MCP server is registered.
ALLOWED_TOOLS = [f"mcp__{MCP_SERVER_NAME}__{schema['name']}" for schema in TOOL_SCHEMAS]

# Host tools that must never be available in research mode. Editing goes
# through the version-checked project tools; a shell would bypass every
# conflict check, and the web tools are unrelated to reading the corpus.
DISALLOWED_TOOLS = [
    "Bash",
    "BashOutput",
    "KillShell",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "Task",
    "SlashCommand",
]


# Any of these in the environment is a credential the runtime will use. The
# last is what `claude setup-token` issues: the way to use a subscription
# somewhere a browser sign-in is not possible, such as a container.
CREDENTIAL_VARIABLES = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")


def _runtime_path() -> str | None:
    """The `claude` runtime the SDK will run: its own bundled copy, else PATH.

    The SDK's wheel ships the runtime, so a container that installs this
    package needs nothing else. An installed one on PATH serves otherwise.
    """
    try:
        import claude_agent_sdk

        bundled = Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"
        if bundled.is_file():
            return str(bundled)
    except ImportError:
        pass
    return shutil.which("claude")


def sdk_available() -> tuple[bool, str | None]:
    try:
        import claude_agent_sdk  # noqa: F401
    except ImportError as exc:
        return False, str(exc)
    return True, None


class ClaudeAgentBackend(AgentBackend):
    name = "claude"

    def __init__(
        self,
        tools: ProjectTools,
        *,
        cwd: str,
        model: str | None = None,
        effort: str | None = None,
    ) -> None:
        self._tools = tools
        self._cwd = cwd
        self._model = model or DEFAULT_MODEL
        self._effort = effort
        self._clients: dict[str, Any] = {}
        self._cancelled: set[str] = set()

    # --------------------------------------------------------- availability

    def availability(self) -> Availability:
        installed, error = sdk_available()
        if not installed:
            return Availability(
                backend=self.name,
                installed=False,
                authenticated=False,
                message=(
                    "The Claude Agent SDK is not installed. Install the agent extra: "
                    "pip install 'litmark[claude]'"
                ),
                detail=error,
            )

        runtime = _runtime_path()
        if runtime is None:
            return Availability(
                backend=self.name,
                installed=True,
                authenticated=False,
                message=(
                    "The Claude Agent SDK is installed but its `claude` runtime was "
                    "not found on PATH. Install Claude Code, or set cli_path."
                ),
            )

        # Credentials are checked by presence only; never read or printed.
        has_key = any(os.environ.get(name) for name in CREDENTIAL_VARIABLES)
        has_profile = any(
            os.path.isdir(os.path.expanduser(path))
            for path in ("~/.config/anthropic", "~/.claude")
        )
        if not (has_key or has_profile):
            return Availability(
                backend=self.name,
                installed=True,
                authenticated=False,
                message=(
                    "No provider credentials were found. Set ANTHROPIC_API_KEY, or "
                    "sign in with the Claude CLI. Provider access and billing are "
                    "separate from this application."
                ),
            )
        return Availability(
            backend=self.name,
            installed=True,
            authenticated=True,
            message="Claude Agent SDK is installed and credentials are configured.",
            detail=f"runtime: {runtime}",
        )

    def supports_resume(self) -> bool:
        return True

    # ------------------------------------------------------------- run loop

    async def start_run(self, request: RunRequest) -> AsyncIterator[AgentEvent]:
        installed, error = sdk_available()
        if not installed:
            yield AgentEvent.error(
                "The Claude Agent SDK is not installed; install the 'claude' extra.",
                kind="agent_unavailable",
            )
            yield AgentEvent(DONE, {"terminal_reason": "error"})
            return

        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

        self._cancelled.discard(request.run_id)
        options = ClaudeAgentOptions(
            system_prompt=SYSTEM_PROMPT,
            model=self._model,
            cwd=self._cwd,
            mcp_servers={MCP_SERVER_NAME: self._build_mcp_server(request)},
            # The research agent is hermetic. Left to its defaults the runtime
            # loads whatever the user has set up for their own coding sessions
            # — personal MCP servers (mail, calendar, a browser), plugins,
            # hooks, skills, memory. None of that belongs here: with permission
            # checks bypassed, text in a PDF could talk the agent into using
            # those tools, and their descriptions alone add tens of thousands
            # of tokens to every new conversation. Credentials are not
            # settings; signing in with the CLI still works.
            strict_mcp_config=True,
            setting_sources=[],
            skills=[],
            # `tools` is an explicit allowlist: the project tools are the only
            # ones loaded. That keeps the built-in file, shell, and web tools
            # out of research mode entirely — edits must be version-checked, and
            # running arbitrary analysis code is a separately scoped capability.
            tools=list(ALLOWED_TOOLS),
            allowed_tools=list(ALLOWED_TOOLS),
            # Belt and braces, in case a future runtime loads built-ins anyway.
            disallowed_tools=list(DISALLOWED_TOOLS),
            permission_mode="bypassPermissions",
            include_partial_messages=True,
            resume=request.backend_session_id,
            max_turns=40,
            **({"effort": self._effort} if self._effort else {}),
        )

        session_id: str | None = request.backend_session_id
        # What the translator learns along the way: which tool each result
        # answers, and the backend's own account of the run.
        state: dict[str, Any] = {"tools": {}, "usage": None}
        client = ClaudeSDKClient(options=options)
        self._clients[request.run_id] = client
        try:
            await client.connect()
            await client.query(self._compose_prompt(request))
            async for message in client.receive_response():
                found = _session_id_of(message)
                if found:
                    session_id = found
                for event in self._translate(message, state):
                    yield event
                for change in self._tools.drain_changes(request.run_id):
                    yield AgentEvent(FILE_CHANGED, change)
        except asyncio.CancelledError:
            await self._safe_interrupt(request.run_id)
            for change in self._tools.drain_changes(request.run_id):
                yield AgentEvent(FILE_CHANGED, change)
            yield AgentEvent(
                DONE, {"terminal_reason": "cancelled", "backend_session_id": session_id}
            )
            raise
        except Exception as exc:  # noqa: BLE001 - reported verbatim, never simulated
            log.exception("Claude Agent SDK run failed")
            for change in self._tools.drain_changes(request.run_id):
                yield AgentEvent(FILE_CHANGED, change)
            yield AgentEvent.error(f"{type(exc).__name__}: {exc}")
            yield AgentEvent(DONE, {"terminal_reason": "error", "backend_session_id": session_id})
            return
        finally:
            self._clients.pop(request.run_id, None)
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001 - disconnect is best-effort
                pass

        done: dict[str, Any] = {
            "terminal_reason": "cancelled" if request.run_id in self._cancelled else "endTurn",
            "backend_session_id": session_id,
        }
        if state["usage"]:
            done["usage"] = state["usage"]
        self._cancelled.discard(request.run_id)
        yield AgentEvent(DONE, done)

    async def cancel_run(self, run_id: str) -> None:
        """Interrupt the backend. Hiding output would not be cancellation."""
        self._cancelled.add(run_id)
        await self._safe_interrupt(run_id)

    async def _safe_interrupt(self, run_id: str) -> None:
        client = self._clients.get(run_id)
        if client is None:
            return
        try:
            await client.interrupt()
        except Exception as exc:  # noqa: BLE001 - surfaced as a run error upstream
            log.warning("Interrupting run %s failed: %s", run_id, exc)

    # -------------------------------------------------------------- helpers

    def _compose_prompt(self, request: RunRequest) -> str:
        described = request.context.describe()
        return f"{described}\n\n{request.prompt}" if described else request.prompt

    def _build_mcp_server(self, request: RunRequest) -> Any:
        """Wrap the project tools as an in-process SDK MCP server."""
        from claude_agent_sdk import create_sdk_mcp_server, tool

        handlers = []
        for schema in TOOL_SCHEMAS:
            handlers.append(self._make_tool(tool, schema, request.run_id))
        return create_sdk_mcp_server(
            name=MCP_SERVER_NAME, version=__version__, tools=handlers
        )

    def _make_tool(self, tool_decorator: Any, schema: dict[str, Any], run_id: str) -> Any:
        name = schema["name"]
        project_tools = self._tools

        @tool_decorator(name, schema["description"], schema["input_schema"])
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            arguments = dict(args or {})
            if name in {"write_note", "patch_note", "write_summary"}:
                arguments.setdefault("run_id", run_id)
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, lambda: dispatch(project_tools, name, arguments)
            )
            return {"content": [{"type": "text", "text": as_text(result)}]}

        return handler

    def _translate(
        self, message: Any, state: dict[str, Any] | None = None
    ) -> list[AgentEvent]:
        """Map SDK messages onto the normalized event vocabulary."""
        state = state if state is not None else {"tools": {}, "usage": None}
        events: list[AgentEvent] = []
        kind = type(message).__name__

        if kind == "StreamEvent":
            # The SDK hands over the provider's raw stream event; the text of a
            # reply arrives as `content_block_delta` fragments.
            raw = getattr(message, "event", None)
            if getattr(message, "parent_tool_use_id", None) or not isinstance(raw, dict):
                return events
            if raw.get("type") == "content_block_delta":
                delta = raw.get("delta") or {}
                text = delta.get("text") if delta.get("type") == "text_delta" else None
                if isinstance(text, str) and text:
                    events.append(AgentEvent(TEXT_DELTA, {"text": text, "partial": True}))
            return events

        if kind == "AssistantMessage":
            for block in getattr(message, "content", []) or []:
                block_kind = type(block).__name__
                if block_kind == "TextBlock":
                    # Partial deltas already streamed the text; mark the final
                    # block so the client can reconcile rather than duplicate.
                    events.append(
                        AgentEvent(TEXT_DELTA, {"text": block.text, "final": True})
                    )
                elif block_kind == "ToolUseBlock":
                    name = _short_tool_name(block.name)
                    state["tools"][block.id] = name
                    events.append(
                        AgentEvent(
                            TOOL_STARTED,
                            {
                                "tool": name,
                                "tool_use_id": block.id,
                                "input": _safe_input(block.input),
                            },
                        )
                    )
            return events

        if kind == "UserMessage":
            content = getattr(message, "content", None)
            for block in content if isinstance(content, list) else []:
                if type(block).__name__ == "ToolResultBlock":
                    events.append(
                        AgentEvent(
                            TOOL_FINISHED,
                            {
                                "tool": state["tools"].get(block.tool_use_id, "tool"),
                                "tool_use_id": block.tool_use_id,
                                "is_error": bool(getattr(block, "is_error", False)),
                                "result": _safe_result(getattr(block, "content", None)),
                            },
                        )
                    )
            return events

        if kind == "ResultMessage":
            state["usage"] = _usage_of(message)
            subtype = str(getattr(message, "subtype", "") or "")
            if getattr(message, "is_error", False) or subtype.startswith("error"):
                events.append(AgentEvent.error(_result_error(message, subtype)))
        return events


def _short_tool_name(name: str) -> str:
    """`mcp__research__read_pages` reads better as `read_pages` in the UI."""
    return name.rsplit("__", 1)[-1] if name.startswith("mcp__") else name


def _safe_input(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"value": str(value)[:500]}
    trimmed: dict[str, Any] = {}
    for key, item in value.items():
        if isinstance(item, str) and len(item) > 500:
            trimmed[key] = item[:500] + "…"
        else:
            trimmed[key] = item
    return trimmed


def _safe_result(content: Any) -> dict[str, Any]:
    """A tool result, trimmed: enough to say what came back, not all of it.

    A page read returns the page; the transcript wants its number, not its
    text. The project tools answer in JSON, so the structure survives.
    """
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                parts.append(str(block.get("text") or ""))
            else:
                parts.append(str(getattr(block, "text", "") or ""))
        content = "\n".join(part for part in parts if part)
    if not isinstance(content, str):
        return {}
    try:
        parsed = json.loads(content)
    except ValueError:
        return {"text": trim_result(content)}
    return trim_result(parsed) if isinstance(parsed, dict) else {"value": trim_result(parsed)}


def _usage_of(message: Any) -> dict[str, Any]:
    """The backend's own account of a run: how long, how many steps, what cost."""
    usage = {
        "duration_ms": getattr(message, "duration_ms", None),
        "num_turns": getattr(message, "num_turns", None),
        "cost_usd": getattr(message, "total_cost_usd", None),
    }
    return {key: value for key, value in usage.items() if value is not None}


def _result_error(message: Any, subtype: str) -> str:
    if subtype == "error_max_turns":
        return "The agent stopped at its limit of steps for one reply. Ask it to continue."
    errors = getattr(message, "errors", None)
    if errors:
        return "; ".join(str(error) for error in errors)
    result = getattr(message, "result", None)
    if result:
        return str(result)
    return f"The run failed ({subtype or 'error'})."


def _session_id_of(message: Any) -> str | None:
    """Find the backend session ID wherever this SDK version reports it."""
    direct = getattr(message, "session_id", None)
    if isinstance(direct, str) and direct:
        return direct
    data = getattr(message, "data", None)
    if isinstance(data, dict):
        candidate = data.get("session_id")
        if isinstance(candidate, str) and candidate:
            return candidate
    return None
