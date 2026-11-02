import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jsonSchema, tool, type Tool } from 'ai';

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));
vi.mock('../telemetry', () => ({ trackEvent: mockTrackEvent }));

import { config } from '../../config';
import { ANTHROPIC_DEFERRED_TOOLS, LOAD_TOOLS_NAME, OPENAI_DEFERRED_TOOLS } from '../llm-providers/deferred-tools';
import { planToolSearch, type PlanToolSearchInput } from './plan';

const saved = { ...config };
beforeEach(() => {
  mockTrackEvent.mockReset();
  config.toolSearch = 'auto';
  config.toolSearchThresholdPercent = 2;
  config.contextWindowTokens = 100_000;
});
afterEach(() => Object.assign(config, saved));

/** A tool whose definition is about `chars` characters long. */
function sized(chars: number): Tool {
  return tool({ description: 'x'.repeat(chars), inputSchema: jsonSchema({ type: 'object' }) });
}

function input(overrides: Partial<PlanToolSearchInput> = {}): PlanToolSearchInput {
  return {
    tools: {
      shell_exec: sized(100),
      nexus__github__create_issue: sized(5_000),
      nexus__gmail__send_email: sized(5_000),
    },
    deferrable: ['nexus__github__create_issue', 'nexus__gmail__send_email'],
    protocol: ANTHROPIC_DEFERRED_TOOLS,
    modelId: 'claude-opus-5-5',
    telemetry: { userId: 'u', agentId: 'a', mode: 'chat' },
    ...overrides,
  };
}

describe('planToolSearch', () => {
  it('defers the deferrable tools past the threshold and adds load_tools and the catalog', async () => {
    // 10,000 characters is 5,000 tokens, over 2% of 100,000.
    const plan = await planToolSearch(input());

    expect(plan.active).toBe(true);
    expect(plan.deferred).toEqual(['nexus__github__create_issue', 'nexus__gmail__send_email']);
    expect(plan.tools.nexus__github__create_issue.providerOptions).toEqual({ anthropic: { deferLoading: true } });
    expect(plan.tools.shell_exec.providerOptions).toBeUndefined();
    expect(Object.keys(plan.tools)).toContain(LOAD_TOOLS_NAME);
    expect(plan.catalog).toContain('- nexus__gmail__send_email');
  });

  it.each([
    ['under the threshold', () => (config.contextWindowTokens = 1_000_000)],
    ['with TOOL_SEARCH=off', () => (config.toolSearch = 'off')],
  ])('sends every tool as it is %s', async (_, set) => {
    set();
    const request = input();
    const plan = await planToolSearch(request);
    expect(plan).toMatchObject({ tools: request.tools, active: false, deferred: [], summaryDeclaresTools: false });
    expect(await plan.promptFor({}, new Set())).toEqual({});
  });

  it('defers 47,000 characters of definitions on a 1M window, which cost 20,000 tokens on Claude', async () => {
    config.contextWindowTokens = 1_000_000;
    const plan = await planToolSearch(input({
      tools: { nexus__github__create_issue: sized(23_500), nexus__gmail__send_email: sized(23_500) },
    }));
    expect(plan.active).toBe(true);
  });

  it('keeps the execute a deferred tool arrives with, so the risk gate still runs on its calls', async () => {
    const gated = vi.fn(async () => 'blocked by the risk gate');
    const request = input();
    request.tools.nexus__github__create_issue = { ...request.tools.nexus__github__create_issue, execute: gated };

    const plan = await planToolSearch(request);

    expect(plan.tools.nexus__github__create_issue.execute).toBe(gated);
  });

  it('sends every tool as it is on a model without a protocol', async () => {
    const plan = await planToolSearch(input({ protocol: undefined }));
    expect(plan.active).toBe(false);
  });

  it('defers on a model whose window is unknown', async () => {
    config.contextWindowTokens = null;
    const plan = await planToolSearch(input({ modelId: 'unknown-model' }));
    expect(plan.active).toBe(true);
  });

  it('reports a load without the query text', async () => {
    const plan = await planToolSearch(input());
    await plan.tools[LOAD_TOOLS_NAME].execute!({ query: 'send an email' }, { toolCallId: 't', messages: [] });

    expect(mockTrackEvent).toHaveBeenCalledWith('tools loaded', 'u', {
      'agent.id': 'a',
      'invoke.mode': 'chat',
      'tool.count': '1',
      'deferred.count': '2',
      match: 'query',
    });
  });

  it.each([
    ['refuses calls under auto on Anthropic, whose SDK drops the tools under none', ANTHROPIC_DEFERRED_TOOLS, true],
    ['keeps none on OpenAI, whose SDK sends the tools under it', OPENAI_DEFERRED_TOOLS, false],
  ])('a summary that history loads tools into %s', async (_, protocol, declares) => {
    const plan = await planToolSearch(input({ protocol, modelId: 'gpt-5.6-sol' }));
    expect(plan.summaryDeclaresTools).toBe(declares);
  });

  describe('promptFor', () => {
    it('builds the catalog and the replay from the declared list, leaving out its late joiners', async () => {
      const plan = await planToolSearch(input());
      // The ledger keeps every tool the plan sent and appends a deferred tool that joined later.
      const declared = {
        ...plan.tools,
        nexus__jira__create_ticket: { ...sized(10), providerOptions: { anthropic: { deferLoading: true } } },
      };

      const prompt = await plan.promptFor(declared, new Set(['nexus__jira__create_ticket']));
      const output = JSON.stringify({ loaded: ['nexus__github__create_issue'], unmatched: [], suggestions: [] });

      expect(prompt.catalog).toBe(plan.catalog);
      expect(prompt.catalog).not.toContain(`- ${LOAD_TOOLS_NAME}`);
      expect(prompt.replayToolCall!({ id: '1', tool: LOAD_TOOLS_NAME, input: {}, output })?.output).toEqual({
        type: 'content',
        value: [
          {
            type: 'custom',
            providerOptions: { anthropic: { type: 'tool-reference', toolName: 'nexus__github__create_issue' } },
          },
        ],
      });
    });
  });

  describe('replayToolCall', () => {
    it('replays a stored load as the protocol sends it, keeping only tools this request declares', async () => {
      const plan = await planToolSearch(input());
      const output = JSON.stringify({
        loaded: ['nexus__gmail__send_email', 'nexus__gone__tool'],
        unmatched: [],
        suggestions: [],
      });

      expect(plan.replayToolCall!({ id: 'toolu_1', tool: LOAD_TOOLS_NAME, input: {}, output })).toEqual({
        id: 'toolu_1',
        input: {},
        output: {
          type: 'content',
          value: [
            {
              type: 'custom',
              providerOptions: { anthropic: { type: 'tool-reference', toolName: 'nexus__gmail__send_email' } },
            },
          ],
        },
      });
    });

    it('leaves every other call, and a load it cannot read, to the text replay', async () => {
      const plan = await planToolSearch(input());
      expect(plan.replayToolCall!({ id: '1', tool: 'shell_exec', input: {}, output: '{"loaded":[]}' })).toBeUndefined();
      expect(plan.replayToolCall!({ id: '1', tool: LOAD_TOOLS_NAME, input: {}, output: 'Error' })).toBeUndefined();
    });
  });
});
