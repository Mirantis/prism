import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../../services/conversation.service', () => ({
  conversationService: { listCompactedMessages: mockList, getCompactedMessage: mockGet },
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
    mockGet.mockReset();
  });

  it("reads the turn's own thread, one page at a time", async () => {
    mockList.mockResolvedValue({
      messages: [
        { role: 'USER', content: 'Deploy to staging.', toolCalls: null, internalStep: false, createdAt: at, position: 31 },
        {
          role: 'AGENT',
          content: 'It failed.',
          toolCalls: [{ tool: 'shell_exec', input: { command: 'kubectl get pods' }, output: 'CrashLoopBackOff', rendered: true }],
          internalStep: false,
          createdAt: at,
          position: 32,
        },
      ],
      more: true,
    });

    const result = await run({ query: 'crash', offset: 20 });

    expect(mockList).toHaveBeenCalledWith('thread-1', { query: 'crash', offset: 20, limit: 20 });
    expect(result).toEqual({
      messages: [
        { position: 31, from: 'user', at: '2026-10-01T09:00:00.000Z', text: 'Deploy to staging.' },
        {
          position: 32,
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
      messages: [{ role: 'AGENT', content: '', toolCalls: [{ tool: 't', output: 'y'.repeat(5_000) }], internalStep: false, createdAt: at, position: 7 }],
      more: false,
    });

    const result = await run({});
    const output = (result.messages as Array<{ toolCalls: Array<{ output: string }> }>)[0].toolCalls[0].output;

    expect(output).toBe(`${'y'.repeat(2000)}\n[Cut: 2000 of 5000 characters shown. Call with position 7 to read this message in full.]`);
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
          position: 3,
        },
      ],
      more: false,
    });

    const result = await run({ query: 'oomkilled' });
    const call = (result.messages as Array<{ toolCalls: Array<{ output: string; savedAt?: string }> }>)[0].toolCalls[0];

    expect(call.output).toContain('OOMKilled pod-7');
    expect(call.output).toMatch(/^\[From character \d+\.\]/);
    expect(call.output).toMatch(/Call with position \d+ to read this message in full\.\]$/);
    expect(call.savedAt).toBe('/data/tool-outputs/spill-1');
  });

  it('cuts a long tool input around a query that holds quotes', async () => {
    const content = `${'x'.repeat(5_000)}say "deploy-7f3a" now${'y'.repeat(5_000)}`;
    mockList.mockResolvedValue({
      messages: [{
        role: 'AGENT',
        content: 'wrote it',
        toolCalls: [{ tool: 'shell_write', input: { path: 'a', content }, output: 'ok' }],
        internalStep: false,
        createdAt: at,
      }],
      more: false,
    });

    const result = await run({ query: '"deploy-7f3a"' });
    const input = (result.messages as Array<{ toolCalls: Array<{ input: string }> }>)[0].toolCalls[0].input;

    expect(input).toContain('\\"deploy-7f3a\\"');
    expect(input).toContain('to read this message in full');
  });

  it('reads one message in full, a page at a time, with its saved result named', async () => {
    const output = 'z'.repeat(30_000);
    mockGet.mockResolvedValue({
      role: 'AGENT',
      content: 'Ran the build.',
      toolCalls: [{ tool: 'shell_exec', input: '{"command":"make"}', output, truncated: { spillId: 'spill-2' } }],
      internalStep: false,
      createdAt: at,
      position: 12,
    });

    const first = await run({ position: 12, query: 'ignored', offset: 5 });

    expect(mockGet).toHaveBeenCalledWith('thread-1', 12);
    expect(mockList).not.toHaveBeenCalled();
    expect(first).toMatchObject({ position: 12, from: 'you', start: 0, nextStart: 20_000 });
    expect(first.text).toMatch(/^Ran the build\.\n\n\[Tool call: shell_exec\]\n\n\[Input\]\n\{"command":"make"\}\n\n\[Output\]\n/);

    const second = await run({ position: 12, start: first.nextStart });
    const total = first.characters as number;

    expect(second).toMatchObject({ start: 20_000, characters: total });
    expect(second).not.toHaveProperty('nextStart');
    expect((first.text as string) + (second.text as string)).toHaveLength(total);
    expect(second.text).toMatch(/\[Saved whole result: \/data\/tool-outputs\/spill-2\]$/);
  });

  it('says when no message has the position', async () => {
    mockGet.mockResolvedValue(null);

    await expect(run({ position: 99 })).resolves.toEqual({ note: 'No earlier message at position 99.' });
  });

  it('says when nothing matches', async () => {
    mockList.mockResolvedValue({ messages: [], more: false });

    await expect(run({ query: 'nothing' })).resolves.toEqual({ messages: [], note: 'No earlier message matches.' });
  });
});
