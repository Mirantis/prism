"""Tests for the Harbor adapter's pure helpers.

Scope is deliberately the functions that need no Harbor import, so this file
runs without the harness installed: `python -m pytest benchmark/`. The
install/run path is exercised by a real `harbor run` against one task — see the
smoke-test section of README.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

# Imported lazily so a missing `harbor` package skips rather than errors — the
# helpers under test are module-level and Harbor-free, but the module's own
# imports are not.
prism_agent = pytest.importorskip(
    "prism_agent", reason="harbor is not installed in this environment"
)


class TestNormalizeModelId:
    @pytest.mark.parametrize(
        "given,expected",
        [
            ("us.anthropic.claude-fable-5", "anthropic.claude-fable-5"),
            ("eu.anthropic.claude-fable-5", "anthropic.claude-fable-5"),
            ("global.anthropic.claude-fable-5", "anthropic.claude-fable-5"),
            ("anthropic.claude-fable-5", "anthropic.claude-fable-5"),
        ],
    )
    def test_strips_cross_region_prefix_on_mantle(self, given: str, expected: str) -> None:
        assert prism_agent.normalize_model_id(given, "bedrock-mantle") == expected

    def test_leaves_other_providers_alone(self) -> None:
        """Native Bedrock needs the profile prefix — stripping it would 400."""
        assert (
            prism_agent.normalize_model_id("us.anthropic.claude-fable-5", "bedrock")
            == "us.anthropic.claude-fable-5"
        )


class TestChatRequestBody:
    def test_round_trips_the_instruction(self) -> None:
        body = prism_agent.chat_request_body("do the thing", "agent-1", "user-1")
        assert json.loads(body) == {
            "userId": "user-1",
            "agentId": "agent-1",
            "message": "do the thing",
        }

    def test_escapes_shell_hostile_instructions(self) -> None:
        """The reason the body is a file: instructions carry quotes and newlines."""
        instruction = 'Run `echo "$HOME"` then\nwrite a \\ backslash \'quoted\''
        parsed = json.loads(prism_agent.chat_request_body(instruction, "a", "u"))
        assert parsed["message"] == instruction


class TestParseChatResponse:
    def test_reads_the_response_object(self) -> None:
        payload = {"threadId": "t1", "content": "done", "toolCalls": []}
        assert prism_agent.parse_chat_response(json.dumps(payload)) == payload

    def test_ignores_server_log_lines_around_it(self) -> None:
        payload = {"threadId": "t1", "content": "done"}
        stdout = "\n".join(
            [
                "prism-server is up at http://127.0.0.1:3003",
                "{not json at all",
                json.dumps(payload),
                "",
            ]
        )
        assert prism_agent.parse_chat_response(stdout) == payload

    def test_takes_the_last_response_when_output_repeats(self) -> None:
        first = json.dumps({"threadId": "t1", "content": "first"})
        second = json.dumps({"threadId": "t2", "content": "second"})
        assert prism_agent.parse_chat_response(f"{first}\n{second}")["content"] == "second"

    def test_rejects_json_that_is_not_a_chat_response(self) -> None:
        """A bare object with no threadId is some other log line, not the reply."""
        assert prism_agent.parse_chat_response('{"level":"info","msg":"booted"}') is None

    def test_returns_none_on_empty_output(self) -> None:
        assert prism_agent.parse_chat_response("") is None
