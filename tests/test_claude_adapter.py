"""Wiring checks for the live Claude Agent SDK adapter.

These run without contacting a provider. They verify that the adapter matches
the SDK's actual API surface, that the tool schemas it registers are the ones
the project implements, and that an unconfigured backend reports the fact
instead of failing obscurely. An actual provider-backed run is a separate,
billable release step.
"""

from __future__ import annotations

import pytest

from litmark.agent import claude_sdk
from litmark.agent.claude_sdk import (
    ALLOWED_TOOLS,
    DISALLOWED_TOOLS,
    MCP_SERVER_NAME,
    ClaudeAgentBackend,
    _safe_input,
    _session_id_of,
    _short_tool_name,
)
from litmark.agent.tools import TOOL_SCHEMAS, ProjectTools

sdk_installed = claude_sdk.sdk_available()[0]
requires_sdk = pytest.mark.skipif(not sdk_installed, reason="claude-agent-sdk is not installed")


def backend(services) -> ClaudeAgentBackend:
    return ClaudeAgentBackend(services.tools, cwd=str(services.workspace.root))


def test_every_project_tool_is_allowed(services):
    """A tool the agent cannot call is a tool that may as well not exist."""
    implemented = {schema["name"] for schema in TOOL_SCHEMAS}
    allowed = {name.rsplit("__", 1)[-1] for name in ALLOWED_TOOLS}
    assert allowed == implemented
    assert all(name.startswith(f"mcp__{MCP_SERVER_NAME}__") for name in ALLOWED_TOOLS)


def test_tool_schemas_match_the_implementations(services):
    """Each declared tool exists on ProjectTools with the parameters declared."""
    import inspect

    for schema in TOOL_SCHEMAS:
        handler = getattr(ProjectTools, schema["name"], None)
        assert callable(handler), f"{schema['name']} is declared but not implemented"
        signature = inspect.signature(handler)
        parameters = set(signature.parameters) - {"self"}
        declared = set(schema["input_schema"].get("properties", {}))
        unknown = declared - parameters
        assert not unknown, f"{schema['name']} declares unknown parameters: {unknown}"
        required = set(schema["input_schema"].get("required", []))
        assert required <= parameters, f"{schema['name']} requires unknown parameters"
        # Every required parameter must genuinely lack a default.
        for name in required:
            assert signature.parameters[name].default is inspect.Parameter.empty


def test_built_in_file_and_shell_tools_are_disabled(services, monkeypatch):
    """Edits must go through the version-checked tools, not Write/Edit/Bash."""
    captured: dict[str, object] = {}

    class FakeOptions:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(claude_sdk, "sdk_available", lambda: (True, None))
    module = pytest.importorskip("claude_agent_sdk")
    monkeypatch.setattr(module, "ClaudeAgentOptions", FakeOptions, raising=False)

    # Constructing the options is enough; the run itself is not started.
    instance = backend(services)
    from litmark.agent.base import RunContext, RunRequest

    request = RunRequest(
        run_id="run-1",
        conversation_id="conv-1",
        prompt="hello",
        context=RunContext(),
    )
    import asyncio

    async def collect() -> list[str]:
        seen: list[str] = []
        async for event in instance.start_run(request):
            seen.append(event.type)
            if len(seen) > 4:
                break
        return seen

    # Connecting fails because the options object is a stub; the adapter must
    # report that as an error event rather than raising into the runner.
    events = asyncio.run(asyncio.wait_for(collect(), timeout=15))
    assert events[0] == "error", events
    assert events[-1] == "done", events

    assert captured, "ClaudeAgentOptions was never constructed"
    # `tools` is the explicit allowlist: only the project tools are loaded.
    assert set(captured.get("tools") or []) == set(ALLOWED_TOOLS)
    disallowed = set(captured.get("disallowed_tools") or [])
    assert {"Bash", "Write", "Edit", "Read", "Glob", "Grep", "WebFetch"} <= disallowed
    assert disallowed == set(DISALLOWED_TOOLS)
    assert not (set(ALLOWED_TOOLS) & disallowed), "a tool cannot be both allowed and blocked"
    assert captured.get("cwd") == str(services.workspace.root)
    assert captured.get("include_partial_messages") is True
    assert MCP_SERVER_NAME in (captured.get("mcp_servers") or {})
    # Hermetic: none of the user's own MCP servers, settings, hooks or skills.
    # A PDF is untrusted text, and this agent runs with permission checks off.
    assert list((captured.get("mcp_servers") or {})) == [MCP_SERVER_NAME]
    assert captured.get("strict_mcp_config") is True
    assert captured.get("setting_sources") == []
    assert captured.get("skills") == []


def _options_for(services, monkeypatch, instance: ClaudeAgentBackend, **choice: str) -> dict:
    """The options the adapter builds for one run with the given choice."""
    import asyncio

    from litmark.agent.base import RunContext, RunRequest

    captured: dict[str, object] = {}

    class FakeOptions:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(claude_sdk, "sdk_available", lambda: (True, None))
    module = pytest.importorskip("claude_agent_sdk")
    monkeypatch.setattr(module, "ClaudeAgentOptions", FakeOptions, raising=False)
    request = RunRequest(
        run_id="run-1", conversation_id="conv-1", prompt="hello", context=RunContext(), **choice
    )

    async def collect() -> None:
        async for event in instance.start_run(request):
            if event.type == "done":
                break

    asyncio.run(asyncio.wait_for(collect(), timeout=15))
    return captured


def test_a_session_chooses_its_model_and_effort(services, monkeypatch):
    """What a run asks for is what the runtime is started with."""
    instance = ClaudeAgentBackend(
        services.tools, cwd=str(services.workspace.root), model="claude-sonnet-5", effort="medium"
    )
    assert instance.defaults() == ("claude-sonnet-5", "medium")

    chosen = _options_for(services, monkeypatch, instance, model="haiku", effort="low")
    assert (chosen["model"], chosen["effort"]) == ("haiku", "low")

    # One of the two chosen: the other is still the project's.
    half = _options_for(services, monkeypatch, instance, effort="max")
    assert (half["model"], half["effort"]) == ("claude-sonnet-5", "max")

    # Nothing chosen: the project's settings stand.
    plain = _options_for(services, monkeypatch, instance)
    assert (plain["model"], plain["effort"]) == ("claude-sonnet-5", "medium")


def test_effort_is_left_to_the_runtime_when_nobody_set_it(services, monkeypatch):
    options = _options_for(services, monkeypatch, backend(services))
    assert options["model"] == claude_sdk.DEFAULT_MODEL
    assert "effort" not in options
    assert set(claude_sdk.EFFORT_LEVELS) == {"low", "medium", "high", "xhigh", "max"}


@requires_sdk
def test_adapter_uses_options_the_installed_sdk_accepts():
    """Guards against drift between the adapter and the installed SDK."""
    from claude_agent_sdk import ClaudeAgentOptions

    fields = set(ClaudeAgentOptions.__dataclass_fields__)
    used = {
        "system_prompt",
        "model",
        "cwd",
        "mcp_servers",
        "allowed_tools",
        "disallowed_tools",
        "permission_mode",
        "include_partial_messages",
        "resume",
        "max_turns",
        "tools",
        "strict_mcp_config",
        "setting_sources",
        "skills",
        "effort",
    }
    assert used <= fields, f"the installed SDK lacks: {sorted(used - fields)}"


@requires_sdk
def test_message_types_the_translator_switches_on_exist():
    """`_translate` dispatches on class names; they must be real SDK types."""
    import claude_agent_sdk as sdk

    for name in (
        "AssistantMessage",
        "ResultMessage",
        "SystemMessage",
        "StreamEvent",
        "TextBlock",
        "ToolUseBlock",
        "ToolResultBlock",
    ):
        assert hasattr(sdk, name), f"the installed SDK has no {name}"


def test_missing_sdk_is_reported_as_unavailable(services, monkeypatch):
    monkeypatch.setattr(claude_sdk, "sdk_available", lambda: (False, "No module named x"))
    availability = backend(services).availability()
    assert availability.ready is False
    assert availability.installed is False
    assert "pip install" in availability.message


def test_missing_runtime_is_reported_as_unavailable(services, monkeypatch):
    monkeypatch.setattr(claude_sdk, "sdk_available", lambda: (True, None))
    monkeypatch.setattr(claude_sdk, "_runtime_path", lambda: None)
    availability = backend(services).availability()
    assert availability.installed is True
    assert availability.authenticated is False
    assert "runtime" in availability.message


def test_missing_credentials_are_reported_without_printing_them(
    services, monkeypatch, tmp_path
):
    monkeypatch.setattr(claude_sdk, "sdk_available", lambda: (True, None))
    monkeypatch.setattr(claude_sdk, "_runtime_path", lambda: "/usr/bin/claude")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.setattr(claude_sdk.os.path, "isdir", lambda _path: False)

    availability = backend(services).availability()
    assert availability.authenticated is False
    assert "credentials" in availability.message
    assert "separate from this application" in availability.message


def test_configured_credentials_are_never_echoed(services, monkeypatch):
    monkeypatch.setattr(claude_sdk, "sdk_available", lambda: (True, None))
    monkeypatch.setattr(claude_sdk, "_runtime_path", lambda: "/usr/bin/claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret-value-do-not-print")

    availability = backend(services).availability()
    assert availability.ready is True
    serialized = str(availability.to_json())
    assert "sk-ant-secret-value-do-not-print" not in serialized


def test_tool_names_are_shortened_for_display():
    assert _short_tool_name("mcp__research__read_pages") == "read_pages"
    assert _short_tool_name("Read") == "Read"


def test_long_tool_inputs_are_trimmed_for_the_activity_view():
    trimmed = _safe_input({"text": "x" * 900, "n": 3})
    assert len(str(trimmed["text"])) < 900
    assert trimmed["n"] == 3
    assert _safe_input("not a dict")["value"] == "not a dict"


def test_session_id_is_found_wherever_the_sdk_reports_it():
    class Direct:
        session_id = "abc"

    class Nested:
        data = {"session_id": "def"}

    class Neither:
        pass

    assert _session_id_of(Direct()) == "abc"
    assert _session_id_of(Nested()) == "def"
    assert _session_id_of(Neither()) is None


# ------------------------------------------------- what the SDK sends, translated


@requires_sdk
def test_a_reply_streams_from_the_sdks_raw_events(services):
    """The text of a reply arrives as the provider's own `content_block_delta`."""
    from claude_agent_sdk import StreamEvent

    adapter = backend(services)

    def stream(event: dict, **extra: object) -> list:
        return adapter._translate(StreamEvent(uuid="u", session_id="s", event=event, **extra))

    (delta,) = stream(
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello"}}
    )
    assert delta.type == "text_delta"
    assert delta.data == {"text": "Hello", "partial": True}

    # Tool arguments being written, thinking, and bookkeeping are not prose.
    assert stream({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{"}}) == []
    assert stream({"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "hm"}}) == []
    assert stream({"type": "message_start"}) == []
    # Nor is anything a sub-agent says part of this reply.
    assert stream(
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "aside"}},
        parent_tool_use_id="toolu_1",
    ) == []


@requires_sdk
def test_a_tool_result_is_matched_to_its_call_and_trimmed(services):
    """The record of a run says what came back, not all of it."""
    import json

    from claude_agent_sdk import AssistantMessage, ToolResultBlock, ToolUseBlock, UserMessage

    adapter = backend(services)
    state: dict = {"tools": {}, "usage": None}
    (started,) = adapter._translate(
        AssistantMessage(
            content=[
                ToolUseBlock(
                    id="toolu_1",
                    name="mcp__research__read_pages",
                    input={"document_id": "doc-001", "pages": [1]},
                )
            ],
            model="m",
        ),
        state,
    )
    assert started.type == "tool_started"
    assert started.data["tool"] == "read_pages" and started.data["tool_use_id"] == "toolu_1"

    page = {"document_id": "doc-001", "pages": [{"page_number": 1, "text": "x" * 5000}]}
    (finished,) = adapter._translate(
        UserMessage(
            content=[
                ToolResultBlock(
                    tool_use_id="toolu_1",
                    content=[{"type": "text", "text": json.dumps(page)}],
                    is_error=False,
                )
            ]
        ),
        state,
    )
    assert finished.type == "tool_finished"
    assert finished.data["tool"] == "read_pages"
    assert finished.data["tool_use_id"] == "toolu_1"
    assert finished.data["is_error"] is False
    kept = finished.data["result"]
    assert kept["document_id"] == "doc-001"
    assert kept["pages"][0]["page_number"] == 1
    assert len(kept["pages"][0]["text"]) < 400

    # The user's own message is a string, not a list of blocks; it is no event.
    assert adapter._translate(UserMessage(content="hello"), state) == []


@requires_sdk
def test_the_result_reports_usage_and_an_error_only_when_there_is_one(services):
    from claude_agent_sdk import ResultMessage

    adapter = backend(services)

    def result(**fields: object) -> ResultMessage:
        base: dict = {
            "subtype": "success",
            "duration_ms": 5600,
            "duration_api_ms": 5000,
            "is_error": False,
            "num_turns": 3,
            "session_id": "s",
            "total_cost_usd": 0.0425,
        }
        return ResultMessage(**{**base, **fields})

    state: dict = {"tools": {}, "usage": None}
    assert adapter._translate(result(), state) == []
    assert state["usage"] == {"duration_ms": 5600, "num_turns": 3, "cost_usd": 0.0425}

    (limit,) = adapter._translate(result(subtype="error_max_turns", is_error=True))
    assert limit.type == "error" and "limit of steps" in limit.data["message"]

    (failed,) = adapter._translate(
        result(subtype="error_during_execution", is_error=True, errors=["Overloaded"])
    )
    assert failed.data["message"] == "Overloaded"


def test_a_subscription_token_counts_as_a_credential(services, monkeypatch):
    """What `claude setup-token` issues is how a container signs in."""
    monkeypatch.setattr(claude_sdk, "sdk_available", lambda: (True, None))
    monkeypatch.setattr(claude_sdk, "_runtime_path", lambda: "/usr/bin/claude")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(claude_sdk.os.path, "isdir", lambda _path: False)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-do-not-print")

    availability = backend(services).availability()
    assert availability.ready is True
    assert "sk-ant-oat-do-not-print" not in str(availability.to_json())


@requires_sdk
def test_the_runtime_shipped_with_the_sdk_is_enough(monkeypatch):
    """A container that installs the package has a runtime without a second install."""
    monkeypatch.setattr(claude_sdk.shutil, "which", lambda _name: None)
    found = claude_sdk._runtime_path()
    assert found is not None and found.endswith("claude")


# ------------------------------------------- a tool call the runtime cannot read


UNREAD = "The model's tool call could not be parsed (retry also failed)."


def _run_with_replies(services, monkeypatch, replies: list[list]) -> tuple[list, list[str]]:
    """Run the adapter against a client that answers each prompt with the next reply."""
    import asyncio

    from litmark.agent.base import RunContext, RunRequest

    asked: list[str] = []
    pending = list(replies)

    class FakeClient:
        def __init__(self, options: object) -> None:
            pass

        async def connect(self) -> None:
            pass

        async def query(self, prompt: str) -> None:
            asked.append(prompt)

        async def receive_response(self):
            for message in pending.pop(0):
                yield message

        async def disconnect(self) -> None:
            pass

    module = pytest.importorskip("claude_agent_sdk")
    monkeypatch.setattr(module, "ClaudeSDKClient", FakeClient)
    request = RunRequest(
        run_id="run-1",
        conversation_id="conv-1",
        prompt="Summarize it.",
        context=RunContext(),
        backend_session_id=None,
        kind="summary",
    )

    async def collect() -> list:
        return [event async for event in backend(services).start_run(request)]

    return asyncio.run(collect()), asked


def _unread_reply() -> list:
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

    return [
        AssistantMessage(content=[TextBlock(text=UNREAD)], model="m"),
        ResultMessage(
            subtype="success",
            duration_ms=1000,
            duration_api_ms=900,
            is_error=True,
            num_turns=4,
            session_id="s",
            total_cost_usd=0.5,
            result=UNREAD,
        ),
    ]


@requires_sdk
def test_a_tool_call_that_cannot_be_read_is_asked_for_again(services, monkeypatch):
    """The model slipping on one call does not cost the run what it had read."""
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

    good = [
        AssistantMessage(content=[TextBlock(text="Done.")], model="m"),
        ResultMessage(
            subtype="success",
            duration_ms=2000,
            duration_api_ms=1800,
            is_error=False,
            num_turns=2,
            session_id="s",
            total_cost_usd=0.75,
        ),
    ]
    events, asked = _run_with_replies(services, monkeypatch, [_unread_reply(), good])

    assert len(asked) == 2 and "make the call" in asked[1]
    kinds = [event.type for event in events]
    assert "error" not in kinds
    assert kinds.count("notice") == 1
    # The runtime's notice is not passed off as something the agent said.
    said = [event.data["text"] for event in events if event.type == "text_delta"]
    assert said == ["Done."]
    done = events[-1]
    assert done.type == "done" and done.data["terminal_reason"] == "endTurn"
    assert done.data["usage"] == {"duration_ms": 3000, "num_turns": 6, "cost_usd": 0.75}


@requires_sdk
def test_asking_again_stops_and_says_so(services, monkeypatch):
    replies = [_unread_reply() for _ in range(claude_sdk.UNREAD_TOOL_CALL_RETRIES + 1)]
    events, asked = _run_with_replies(services, monkeypatch, replies)

    assert len(asked) == claude_sdk.UNREAD_TOOL_CALL_RETRIES + 1
    errors = [event.data["message"] for event in events if event.type == "error"]
    assert len(errors) == 1 and "could not be read" in errors[0]
    assert not [event for event in events if event.type == "text_delta"]
