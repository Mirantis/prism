import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));
vi.mock('../../services/conversation.service', () => ({
  conversationService: { listCompactedMessages: mockList },
}));
vi.mock('../../lib/tool-output-store', () => ({
  toolOutputPath: (id: string, root?: string) => `${root ?? '/data'}/tool-outputs/${id}`,
}));

import { COMPACTED_HISTORY_TOOL_NAME, getConversationHistoryTools } from '../conversation-history';

type Execute = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const run = (input: Record<string, unknown>) =>
  (getConversationHistoryTools('thread-1')[COMPACTED_HISTORY_TOOL_NAME].execute as unknown as Execute)(input);

const at = new Date('2026-10-01T09:00:00.000Z');

describe('read_compacted_history', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it("reads the turn's own thread, one page at a time", async () => {
    mockList.mockResolvedValue({
      messages: [
        { role: 'USER', content: 'Deploy to staging.', toolCalls: null, internalStep: false, createdAt: at },
        {
          role: 'AGENT',
          content: 'It failed.',
          toolCalls: [{ tool: 'shell_exec', input: { command: 'kubectl get pods' }, output: 'CrashLoopBackOff', rendered: true }],
          internalStep: false,
          createdAt: at,
        },
      ],
      more: true,
    });

    const result = await run({ query: 'crash', offset: 20 });

    expect(mockList).toHaveBeenCalledWith('thread-1', { query: 'crash', offset: 20, limit: 20 });
    expect(result).toEqual({
      messages: [
        { from: 'user', at: '2026-10-01T09:00:00.000Z', text: 'Deploy to staging.' },
        {
          from: 'you',
          at: '2026-10-01T09:00:00.000Z',
          text: 'It failed.',
          toolCalls: [{ tool: 'shell_exec', input: { command: 'kubectl get pods' }, output: 'CrashLoopBackOff' }],
        },
      ],
      nextOffset: 22,
    });
  });

  it('labels a recalled-memory block as context, not as the user', async () => {
    mockList.mockResolvedValue({
      messages: [{ role: 'USER', content: '<recalled-memories>', toolCalls: null, internalStep: true, createdAt: at }],
      more: false,
    });

    const result = await run({});

    expect((result.messages as Array<{ from: string }>)[0].from).toBe('context');
    expect(result).not.toHaveProperty('nextOffset');
  });

  it('stops a page before the tool budget and points to the first message left out', async () => {
    const big = 'x'.repeat(1_800);
    mockList.mockResolvedValue({
      messages: Array.from({ length: 20 }, () => ({
        role: 'AGENT',
        content: 'step',
        toolCalls: [{ tool: 'shell_exec', input: {}, output: big }],
        internalStep: false,
        createdAt: at,
      })),
      more: false,
    });

    const result = await run({});
    const shown = (result.messages as unknown[]).length;

    expect(shown).toBeLessThan(20);
    expect(JSON.stringify(result.messages).length).toBeLessThanOrEqual(20_000);
    expect(result.nextOffset).toBe(shown);
  });

  it('cuts a long message text and a long tool input too', async () => {
    mockList.mockResolvedValue({
      messages: [
        {
          role: 'AGENT',
          content: 'z'.repeat(40_000),
          toolCalls: [{ tool: 'shell_write', input: { path: 'a', content: 'w'.repeat(40_000) }, output: 'ok' }],
          internalStep: false,
          createdAt: at,
        },
      ],
      more: false,
    });

    const result = await run({});

    expect(JSON.stringify(result).length).toBeLessThan(6_000);
  });

  it('cuts a long tool result inside a page', async () => {
    mockList.mockResolvedValue({
      messages: [{ role: 'AGENT', content: '', toolCalls: [{ tool: 't', output: 'y'.repeat(5_000) }], internalStep: false, createdAt: at }],
      more: false,
    });

    const result = await run({});
    const output = (result.messages as Array<{ toolCalls: Array<{ output: string }> }>)[0].toolCalls[0].output;

    expect(output).toMatch(/^y{2000}\n\[2000 of 5000 characters shown\.\]$/);
  });

  it("shows the window around the query's match and where the whole result is saved", async () => {
    const output = `${'a'.repeat(20_000)} OOMKilled pod-7 ${'b'.repeat(10_000)}`;
    mockList.mockResolvedValue({
      messages: [
        {
          role: 'AGENT',
          content: '',
          toolCalls: [{ tool: 'shell_exec', output, truncated: { spillId: 'spill-1' } }],
          internalStep: false,
          createdAt: at,
        },
      ],
      more: false,
    });

    const result = await run({ query: 'oomkilled' });
    const call = (result.messages as Array<{ toolCalls: Array<{ output: string; savedAt?: string }> }>)[0].toolCalls[0];

    expect(call.output).toContain('OOMKilled pod-7');
    expect(call.output).toMatch(/^\[From character \d+\.\]/);
    expect(call.savedAt).toBe('/data/tool-outputs/spill-1');
  });

  it('says when nothing matches', async () => {
    mockList.mockResolvedValue({ messages: [], more: false });

    await expect(run({ query: 'nothing' })).resolves.toEqual({ messages: [], note: 'No earlier message matches.' });
  });
});
