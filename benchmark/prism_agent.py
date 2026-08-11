"""Harbor adapter for the Prism agent runtime.

Structure follows Ante's `ante-harbor` adapter: a `BaseInstalledAgent` that
provisions the agent inside each task sandbox from a published release, then
runs it there. The difference is what "run it" means. Ante is a CLI, so its
adapter execs one command. Prism is a server, so a trial is start → health →
one synchronous chat turn → shut down, and `run-prism.sh` owns that sequence.

Why the runtime lives in the sandbox rather than on the runner: Prism's shell
tools (`shell_exec`, `shell_write_file`, …) spawn children of prism-server and
resolve paths against `SHELL_WORKSPACE_ROOT`. They do not go through Harbor's
`environment.exec`. A server on the runner would therefore edit the runner's
filesystem while the grader inspects the container's.

Two runtime settings are load-bearing for a valid measurement, and both are
passed as env rather than assumed:

* ``PRISM_DISABLED_TOOLS`` withholds ``claude_code``/``claude_code_status``.
  Left enabled, Prism can hand the whole task to a nested Claude Code agent and
  the score stops being attributable to Prism's own loop. This adapter disables
  them by default; pass ``--ak disabled_tools=`` to measure with them on.
* ``PRISM_REASONING_EFFORT`` sets the model's effort, and ``PRISM_THINKING``
  turns thinking on. Both reach the model only on the vendors that speak the
  Anthropic Messages API — ``bedrock-mantle`` and ``azure``. On native
  ``bedrock`` (Converse) they are silently ignored, which is why
  ``bedrock-mantle`` is this adapter's default provider.

  Thinking is sent explicitly because omitting it does not mean the same thing
  on every model: Opus 4.8 and 4.7 run with **no** thinking unless ``adaptive``
  is sent, while Fable 5 always thinks and Opus 5 thinks by default. On the
  Opus 4.x default here, leaving it out would benchmark a non-thinking model.

* ``PRISM_DISABLE_AUTONOMY`` stops the runtime starting work of its own —
  heartbeat timers, cron registration, goal resumption, session resets,
  background sweeps. A heartbeat firing mid-trial would edit the task tree under
  the grader, so a trial would no longer measure the one turn Harbor asked for.
"""

from __future__ import annotations

import json
import shlex
import tempfile
import uuid
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.result import AgentInfo, ModelInfo

_ADAPTER_DIR = Path(__file__).parent
_INSTALL_SCRIPT = _ADAPTER_DIR / "install-prism.sh"
_RUN_SCRIPT = _ADAPTER_DIR / "run-prism.sh"

_SANDBOX_INSTALL_SCRIPT = "/tmp/install-prism.sh"
_SANDBOX_RUN_SCRIPT = "/tmp/run-prism.sh"
_SANDBOX_CHAT_BODY = "/tmp/prism-chat-body.json"

PRISM_HOME = "/opt/prism"

# Tools withheld unless the caller opts back in. See the module docstring.
DEFAULT_DISABLED_TOOLS = "claude_code,claude_code_status"

# Bare Bedrock id — Mantle serves no cross-region inference profiles, so no
# `us.`/`eu.`/`global.` prefix. Overridden by Harbor's `-m`.
DEFAULT_MODEL_ID = "anthropic.claude-opus-4-8"

# One agent per container, so a per-trial owner id is enough to keep the
# conversation attributable; it never leaves the sandbox.
BENCHMARK_USER_ID = "00000000-0000-0000-0000-000000000001"

# Which env var carries the chat model, per LLM_PROVIDER. Prism selects one
# vendor per process and reads the model from that vendor's own variable, so
# writing the wrong one silently leaves the default model in place.
_MODEL_ENV_BY_PROVIDER = {
    "bedrock-mantle": "BEDROCK_MANTLE_MODEL_ID",
    "bedrock": "BEDROCK_MODEL_ID",
    "azure": "AZURE_MODEL_ID",
}

STEPS_METADATA_KEY = "n_steps"
EFFORT_METADATA_KEY = "reasoning_effort"
THINKING_METADATA_KEY = "thinking"
TOOL_CALLS_METADATA_KEY = "n_tool_calls"


def normalize_model_id(model_name: str, provider: str) -> str:
    """Strip a cross-region prefix Bedrock Mantle does not accept.

    Harbor model names are commonly written with the inference-profile prefix
    (``us.anthropic.claude-opus-4-8``). Mantle serves no cross-region profiles and
    the runtime strips the prefix itself, but normalizing here keeps the value
    reported in ``AgentInfo`` identical to the one the model actually ran under.
    """
    if provider != "bedrock-mantle":
        return model_name
    for prefix in ("us.", "eu.", "global."):
        if model_name.startswith(prefix):
            return model_name[len(prefix) :]
    return model_name


def chat_request_body(instruction: str, agent_id: str, user_id: str) -> str:
    """Serialize the POST /agents/chat body for one trial.

    Built here and uploaded as a file so the instruction never has to survive
    shell quoting: task instructions contain quotes, newlines, and backslashes,
    and `json.dumps` is the only escaping in the path.
    """
    return json.dumps(
        {"userId": user_id, "agentId": agent_id, "message": instruction},
        ensure_ascii=False,
    )


def parse_chat_response(stdout: str) -> dict[str, Any] | None:
    """Recover the chat response object from the driver's stdout.

    The driver prints it last, but prism-server's own logging shares the stream
    when a task image merges them, so scan upward for the final line that parses
    as a JSON object carrying a ``threadId``.
    """
    for line in reversed([line.strip() for line in stdout.splitlines() if line.strip()]):
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except ValueError:
            continue
        if isinstance(parsed, dict) and "threadId" in parsed:
            return parsed
    return None


def _metadata_dict(context: AgentContext) -> dict[str, Any] | None:
    metadata = getattr(context, "metadata", None)
    if isinstance(metadata, dict):
        return metadata
    try:
        context.metadata = {}
    except Exception:
        return None
    return context.metadata if isinstance(context.metadata, dict) else None


class PrismAgent(BaseInstalledAgent):
    def __init__(
        self,
        *args,
        provider: str = "bedrock-mantle",
        reasoning_effort: str | None = "high",
        thinking: str | None = "adaptive",
        disabled_tools: str | None = None,
        release_tag: str = "latest",
        turn_timeout: int = 5400,
        boot_timeout: int = 120,
        **kwargs,
    ) -> None:
        super().__init__(*args, **kwargs)
        if provider not in _MODEL_ENV_BY_PROVIDER:
            raise ValueError(
                f"Unsupported provider {provider!r}; expected one of "
                f"{', '.join(sorted(_MODEL_ENV_BY_PROVIDER))}"
            )
        self._provider = provider
        self._reasoning_effort = reasoning_effort or None
        self._thinking = thinking or None
        # `None` means "adapter default"; an explicitly empty string means the
        # caller wants nothing withheld, so it must not fall back to the default.
        self._disabled_tools = (
            DEFAULT_DISABLED_TOOLS if disabled_tools is None else disabled_tools
        )
        self._release_tag = release_tag
        self._turn_timeout = int(turn_timeout)
        self._boot_timeout = int(boot_timeout)
        # A fresh id per trial, so nothing carries across the 89 tasks: the
        # runtime bootstraps a new AgentWorkspace (and with it a new thread and
        # empty memory) for an id its database has never seen.
        self._agent_id = str(uuid.uuid4())
        self._model_id: str | None = None

    @staticmethod
    def name() -> str:
        return "prism"

    def version(self) -> str | None:
        return self._version or self._release_tag

    def to_agent_info(self) -> AgentInfo:
        return AgentInfo(
            name=self.name(),
            version=self.version() or "unknown",
            model_info=(
                ModelInfo(name=self._model_id or self.model_name, provider=self._provider)
                if (self._model_id or self.model_name)
                else None
            ),
        )

    # -- install ------------------------------------------------------------

    async def install(self, environment: BaseEnvironment) -> None:
        await environment.upload_file(
            source_path=_INSTALL_SCRIPT, target_path=_SANDBOX_INSTALL_SCRIPT
        )
        await environment.upload_file(source_path=_RUN_SCRIPT, target_path=_SANDBOX_RUN_SCRIPT)
        await self.exec_as_root(
            environment,
            command=(
                f"chmod +x {_SANDBOX_INSTALL_SCRIPT} {_SANDBOX_RUN_SCRIPT} && "
                f"PRISM_HOME={shlex.quote(PRISM_HOME)} "
                f"{_SANDBOX_INSTALL_SCRIPT} {shlex.quote(self._release_tag)}"
            ),
        )
        version_result = await environment.exec(
            command=f"cat {shlex.quote(PRISM_HOME)}/VERSION"
        )
        if version_result.return_code == 0 and (version_result.stdout or "").strip():
            self._version = version_result.stdout.strip()

    # -- run ----------------------------------------------------------------

    def _runtime_env(self) -> dict[str, str]:
        """Env for prism-server, beyond what Harbor already puts in the sandbox.

        Credentials are deliberately absent: they arrive through Harbor's
        ``--ae``/``--agent-env`` forwarding and are already in the container env
        that the driver script inherits, so this adapter never handles them.
        """
        model_id = normalize_model_id(
            self.model_name or DEFAULT_MODEL_ID, self._provider
        )
        self._model_id = model_id

        env = {
            "LLM_PROVIDER": self._provider,
            _MODEL_ENV_BY_PROVIDER[self._provider]: model_id,
            "AGENT_ID": self._agent_id,
            "OWNER_USER_ID": BENCHMARK_USER_ID,
            "PRISM_HOME": PRISM_HOME,
            "PRISM_CHAT_BODY": _SANDBOX_CHAT_BODY,
            "PRISM_BOOT_TIMEOUT": str(self._boot_timeout),
            "PRISM_TURN_TIMEOUT": str(self._turn_timeout),
            # No heartbeat, cron, goals, session resets, or background sweeps —
            # a trial must be exactly the one turn Harbor dispatched.
            "PRISM_DISABLE_AUTONOMY": "true",
            # Memory embeddings would need a second model and add nothing to a
            # single-turn trial, so leave that leg off.
            "BEDROCK_MANTLE_EMBEDDING_MODEL_ID": "",
            # Published images bake in a collector endpoint. A benchmark sweep is
            # not production traffic, so keep 445 trials out of it.
            "OTEL_EXPORTER_OTLP_ENDPOINT": "",
        }
        if self._disabled_tools:
            env["PRISM_DISABLED_TOOLS"] = self._disabled_tools
        if self._reasoning_effort:
            env["PRISM_REASONING_EFFORT"] = self._reasoning_effort
        if self._thinking:
            env["PRISM_THINKING"] = self._thinking
        return env

    def _populate_context(self, context: AgentContext, response: dict[str, Any]) -> None:
        usage = response.get("usage")
        if isinstance(usage, dict):
            # Reported per step by the provider and summed over the turn by the
            # runtime. Zero means the provider reported nothing, so skip rather
            # than record a false zero.
            for field, key in (
                ("n_input_tokens", "inputTokens"),
                ("n_output_tokens", "outputTokens"),
            ):
                value = usage.get(key)
                if isinstance(value, (int, float)) and value > 0:
                    setattr(context, field, value)

        metadata = _metadata_dict(context)
        if metadata is None:
            return
        if isinstance(usage, dict) and isinstance(usage.get("steps"), int):
            metadata[STEPS_METADATA_KEY] = usage["steps"]
        tool_calls = response.get("toolCalls")
        if isinstance(tool_calls, list):
            metadata[TOOL_CALLS_METADATA_KEY] = len(tool_calls)
        if self._reasoning_effort:
            metadata[EFFORT_METADATA_KEY] = self._reasoning_effort
        if self._thinking:
            metadata[THINKING_METADATA_KEY] = self._thinking

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        body = chat_request_body(instruction, self._agent_id, BENCHMARK_USER_ID)
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "prism-chat-body.json"
            source.write_text(body, encoding="utf-8")
            await environment.upload_file(source_path=source, target_path=_SANDBOX_CHAT_BODY)

        env = self._runtime_env()
        exports = " ".join(f"{key}={shlex.quote(value)}" for key, value in env.items())
        result = await self.exec_as_agent(
            environment, command=f"env {exports} {_SANDBOX_RUN_SCRIPT}"
        )

        response = parse_chat_response(getattr(result, "stdout", "") or "")
        if response is None:
            # The turn produced nothing parseable. Surface it as a failed trial
            # rather than a silent pass: the grader would otherwise score an
            # untouched task tree as a plain wrong answer and hide the cause.
            raise NonZeroAgentExitCodeError(
                "prism produced no parseable chat response "
                f"(exit {getattr(result, 'return_code', 'unknown')}).\n"
                f"stdout: {self._truncate_output(getattr(result, 'stdout', ''))}\n"
                f"stderr: {self._truncate_output(getattr(result, 'stderr', ''))}"
            )

        self._populate_context(context, response)
