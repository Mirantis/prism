/**
 * Pins what each protocol puts on the wire, through the real SDKs. The shapes
 * were measured live: a drift in either SDK fails here before it fails a turn.
 */

import { describe, it, expect } from 'vitest';
import { generateText, jsonSchema, tool, type ModelMessage, type Tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import {
  ANTHROPIC_DEFERRED_TOOLS,
  LOAD_TOOLS_NAME,
  OPENAI_DEFERRED_TOOLS,
  describeLoad,
} from './deferred-tools';
import { mergeProviderOptions, type ToolLoad, type ToolLoader } from './llm-provider';

const ISSUE_TOOL = 'nexus__github__create_issue';
const parameters = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };

const loader: ToolLoader = {
  description: 'Load tools.',
  load: () => ({ loaded: [ISSUE_TOOL], unmatched: [], suggestions: [] }),
  definition: (name) => (name === ISSUE_TOOL ? { name, description: 'Create an issue.', parameters } : undefined),
};

function issueTool(deferred: Record<string, Record<string, unknown>>): Tool {
  const base = tool({ description: 'Create an issue.', inputSchema: jsonSchema(parameters) });
  return { ...base, providerOptions: mergeProviderOptions(base.providerOptions, deferred) };
}

/** A `fetch` that records each request body and answers with `response`. */
function capture(response: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { bodies, fetch };
}

function history(replayed: { id: string; input: unknown; output: unknown }): ModelMessage[] {
  return [
    { role: 'user', content: 'File an issue.' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: replayed.id, toolName: LOAD_TOOLS_NAME, input: replayed.input }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: replayed.id,
          toolName: LOAD_TOOLS_NAME,
          output: replayed.output as never,
        },
      ],
    },
  ];
}

const load: ToolLoad = { loaded: [ISSUE_TOOL], unmatched: [], suggestions: [] };

describe('ANTHROPIC_DEFERRED_TOOLS', () => {
  const answer = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it('sends a deferred tool with defer_loading and replays a load as tool_reference blocks', async () => {
    const { bodies, fetch } = capture(answer);
    const replayed = ANTHROPIC_DEFERRED_TOOLS.replay(
      { id: 'toolu_1', input: { names: [ISSUE_TOOL] }, result: load },
      loader,
    );

    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
      tools: {
        [LOAD_TOOLS_NAME]: ANTHROPIC_DEFERRED_TOOLS.loadTool(loader),
        [ISSUE_TOOL]: issueTool(ANTHROPIC_DEFERRED_TOOLS.deferredTool),
      },
      messages: history(replayed),
    });

    const body = bodies[0] as { tools: Array<Record<string, unknown>>; messages: Array<{ content: unknown }> };
    expect(body.tools.find((t) => t.name === ISSUE_TOOL)?.defer_loading).toBe(true);
    expect(body.tools.find((t) => t.name === LOAD_TOOLS_NAME)?.defer_loading).toBeUndefined();
    expect(body.messages[2].content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'tool_reference', tool_name: ISSUE_TOOL }],
      }),
    ]);
  });

  it('replays a load that found nothing as text, since a result cannot mix the two', () => {
    const empty: ToolLoad = { loaded: [], unmatched: ['jira'], suggestions: [ISSUE_TOOL] };
    const replayed = ANTHROPIC_DEFERRED_TOOLS.replay({ id: 'toolu_1', input: {}, result: empty }, loader);
    expect(replayed.output).toEqual({ type: 'text', value: describeLoad(empty) });
  });
});

describe('OPENAI_DEFERRED_TOOLS', () => {
  const answer = {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'gpt-5.6-sol',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };

  it('replays a load as a client tool_search call with a tsc id and the loaded definitions', async () => {
    const { bodies, fetch } = capture(answer);
    const replayed = OPENAI_DEFERRED_TOOLS.replay(
      { id: 'call_abc-1', input: { arguments: { names: [ISSUE_TOOL] }, call_id: 'call_abc-1' }, result: load },
      loader,
    );
    expect(replayed.id).toBe('tsc_callabc1');

    await generateText({
      model: createOpenAI({ apiKey: 'k', fetch }).responses('gpt-5.6-sol'),
      tools: {
        [LOAD_TOOLS_NAME]: OPENAI_DEFERRED_TOOLS.loadTool(loader),
        [ISSUE_TOOL]: issueTool(OPENAI_DEFERRED_TOOLS.deferredTool),
      },
      messages: history(replayed),
    });

    const body = bodies[0] as { tools: Array<Record<string, unknown>>; input: Array<Record<string, unknown>> };
    expect(body.tools.find((t) => t.name === ISSUE_TOOL)?.defer_loading).toBe(true);
    expect(body.tools.find((t) => t.type === 'tool_search')).toMatchObject({ execution: 'client' });
    expect(body.input.find((item) => item.type === 'tool_search_call')).toMatchObject({
      call_id: 'tsc_callabc1',
      execution: 'client',
      arguments: { names: [ISSUE_TOOL] },
    });
    expect(body.input.find((item) => item.type === 'tool_search_output')).toMatchObject({
      call_id: 'tsc_callabc1',
      tools: [expect.objectContaining({ type: 'function', name: ISSUE_TOOL, parameters, defer_loading: true })],
    });
  });
});
