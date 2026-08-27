/**
 * Tool Call History Service Tests
 *
 * The feed walks message rows, so what matters is the cursor, which has to
 * survive a page boundary landing inside one row's array.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    conversationMessage: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { toolCallHistoryService } from './tool-call-history.service';
import { config } from '../config';

function call(tool: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    tool,
    input: JSON.stringify({ command: `run ${tool}` }),
    output: '"done"',
    success: true,
    timestamp: '2026-08-27T09:00:00.000Z',
    ...over,
  };
}

/** A message row as the service selects it. */
function row(id: string, toolCalls: unknown[], createdAt = '2026-08-27T09:00:00.000Z') {
  return {
    id,
    threadId: 'thread-1',
    triggeredBy: 'USER_INPUT',
    toolCalls,
    createdAt: new Date(createdAt),
    thread: { title: 'A thread' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toolCallHistoryService.page', () => {
  it('returns a row\'s calls newest first, with provenance', async () => {
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      row('msg-1', [call('first'), call('second')]),
    ]);

    const page = await toolCallHistoryService.page(30);

    expect(page.items.map((i) => i.tool)).toEqual(['second', 'first']);
    expect(page.items[0]).toMatchObject({
      id: 'msg-1-tc-1',
      messageId: 'msg-1',
      threadId: 'thread-1',
      threadTitle: 'A thread',
      triggeredBy: 'USER_INPUT',
      success: true,
    });
    expect(page.nextCursor).toBeNull();
  });

  it('reads agent rows newest turn first', async () => {
    mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

    await toolCallHistoryService.page(30);

    const args = mockPrisma.conversationMessage.findMany.mock.calls[0][0];
    expect(args.where.role).toBe('AGENT');
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('pages only the agent this runtime owns', async () => {
    mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

    await toolCallHistoryService.page(30);

    const where = mockPrisma.conversationMessage.findMany.mock.calls[0][0].where;
    expect(where.thread).toEqual({ agentId: config.agentId });
  });

  it('will not resume from another agent\'s row', async () => {
    // The cursor is client-supplied, so the row it names is re-checked against
    // the owning agent rather than trusted.
    mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);
    mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

    const page = await toolCallHistoryService.page(30, 'someone-elses-row:3');

    expect(page).toEqual({ items: [], nextCursor: null });
    const where = mockPrisma.conversationMessage.findFirst.mock.calls[0][0].where;
    expect(where.thread).toEqual({ agentId: config.agentId });
  });

  it('stops at the limit mid-row and resumes below that position', async () => {
    const calls = [call('a'), call('b'), call('c'), call('d')];
    mockPrisma.conversationMessage.findMany.mockResolvedValue([row('msg-1', calls)]);

    const first = await toolCallHistoryService.page(2);

    // Indices descend from 3, so a page of two ends on index 2.
    expect(first.items.map((i) => i.tool)).toEqual(['d', 'c']);
    expect(first.nextCursor).toBe('msg-1:2');

    // The continuation re-reads that row and takes only what sits below index 2.
    mockPrisma.conversationMessage.findFirst.mockResolvedValue(row('msg-1', calls));
    mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

    const second = await toolCallHistoryService.page(2, 'msg-1:2');

    expect(second.items.map((i) => i.tool)).toEqual(['b', 'a']);
    expect(second.items.map((i) => i.id)).toEqual(['msg-1-tc-1', 'msg-1-tc-0']);
  });

  it('never repeats or skips a call across a page boundary', async () => {
    const calls = Array.from({ length: 7 }, (_, i) => call(`t${i}`));
    mockPrisma.conversationMessage.findMany.mockResolvedValue([row('msg-1', calls)]);
    mockPrisma.conversationMessage.findFirst.mockResolvedValue(row('msg-1', calls));

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 5; page++) {
      // Older rows are exhausted; only the cursor's own row has anything left.
      mockPrisma.conversationMessage.findMany.mockResolvedValue(
        cursor ? [] : [row('msg-1', calls)],
      );

      const result = await toolCallHistoryService.page(3, cursor);
      seen.push(...result.items.map((i) => i.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toEqual([
      'msg-1-tc-6', 'msg-1-tc-5', 'msg-1-tc-4',
      'msg-1-tc-3', 'msg-1-tc-2', 'msg-1-tc-1',
      'msg-1-tc-0',
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('walks on to older rows once the cursor row is spent', async () => {
    mockPrisma.conversationMessage.findFirst.mockResolvedValue(
      row('msg-2', [call('newest')], '2026-08-27T09:00:00.000Z'),
    );
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      row('msg-1', [call('older')], '2026-08-27T08:00:00.000Z'),
    ]);

    const page = await toolCallHistoryService.page(30, 'msg-2:0');

    expect(page.items.map((i) => i.tool)).toEqual(['older']);

    // Older rows are selected on (createdAt, id) — createdAt alone is not
    // unique, so a same-millisecond row would repeat or vanish.
    const where = mockPrisma.conversationMessage.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { createdAt: { lt: new Date('2026-08-27T09:00:00.000Z') } },
      { createdAt: new Date('2026-08-27T09:00:00.000Z'), id: { lt: 'msg-2' } },
    ]);
  });

  it('ends the list when the cursor row has been deleted', async () => {
    mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);

    const page = await toolCallHistoryService.page(30, 'gone:3');

    expect(page).toEqual({ items: [], nextCursor: null });
    expect(mockPrisma.conversationMessage.findMany).not.toHaveBeenCalled();
  });

  it('caps the text it serves, and says how much it cut', async () => {
    // The row keeps the raw tool result: `lib/tool-output-limiter.ts` bounds
    // only what a model is shown. A shell_exec may capture 10 MiB per stream,
    // so a page of 30 has to be bounded here or it serializes hundreds of MiB.
    const hugeOutput = 'x'.repeat(60_000);
    const hugeInput = JSON.stringify({ command: 'y'.repeat(9_000) });

    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      row('msg-1', [call('shell_exec', { input: hugeInput, output: hugeOutput })]),
    ]);

    const page = await toolCallHistoryService.page(30);
    const item = page.items[0];

    expect(item.output.length).toBeLessThan(11_000);
    expect(item.input.length).toBeLessThan(2_400);
    expect(item.output).toContain('10,000 of 60,000 characters');
    expect(item.output.startsWith('x'.repeat(100))).toBe(true);
  });

  it('leaves text that fits exactly as it was stored', async () => {
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      row('msg-1', [call('shell_exec', { input: '{"command":"ls"}', output: '"a.txt"' })]),
    ]);

    const item = (await toolCallHistoryService.page(30)).items[0];

    expect(item.input).toBe('{"command":"ls"}');
    expect(item.output).toBe('"a.txt"');
    expect(item.output).not.toContain('truncated');
  });

  it('skips malformed entries and rows whose column is not an array', async () => {
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      row('msg-2', [null, { input: '{}' }, { tool: '' }, call('real')]),
      row('msg-1', 'not an array' as unknown as unknown[]),
    ]);

    const page = await toolCallHistoryService.page(30);

    expect(page.items.map((i) => i.tool)).toEqual(['real']);
  });

  it('fills in missing fields rather than dropping a named call', async () => {
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      row('msg-1', [{ tool: 'shell_exec' }]),
    ]);

    const page = await toolCallHistoryService.page(30);

    expect(page.items[0]).toMatchObject({
      tool: 'shell_exec',
      input: '',
      output: '',
      success: false,
      timestamp: '',
    });
  });

  it('ignores a malformed cursor and starts from the newest row', async () => {
    mockPrisma.conversationMessage.findMany.mockResolvedValue([row('msg-1', [call('a')])]);

    const page = await toolCallHistoryService.page(30, 'nonsense');

    expect(page.items.map((i) => i.tool)).toEqual(['a']);
    expect(mockPrisma.conversationMessage.findFirst).not.toHaveBeenCalled();
  });

  it('stops paging once the cursor sits on the oldest call', async () => {
    // The client has been handed a cursor at the last call. This request has
    // nothing left to give, and must say so — a cursor here would have the
    // client fetching empty pages for ever.
    mockPrisma.conversationMessage.findFirst.mockResolvedValue(row('msg-1', [call('a')]));
    mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

    const page = await toolCallHistoryService.page(30, 'msg-1:0');

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('walks the whole history exactly once, one call per page', async () => {
    // Three rows, five calls, two of them sharing a timestamp so the (createdAt,
    // id) tie-break is exercised. Paging at limit 1 must yield each call once,
    // in order, and then stop.
    const rows = [
      row('msg-3', [call('e')], '2026-08-27T10:00:00.000Z'),
      row('msg-2', [call('c'), call('d')], '2026-08-27T09:00:00.000Z'),
      row('msg-1', [call('a'), call('b')], '2026-08-27T09:00:00.000Z'),
    ];
    const byId = new Map(rows.map((r) => [r.id, r]));

    mockPrisma.conversationMessage.findFirst.mockImplementation(
      async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null,
    );

    // Stand in for the real ordered read: newest first, and when an OR clause is
    // present only rows strictly older on (createdAt, id).
    mockPrisma.conversationMessage.findMany.mockImplementation(
      async ({ where }: { where: { OR?: Array<Record<string, unknown>> } }) => {
        if (!where.OR) return rows;

        const [byTime, byTie] = where.OR as [
          { createdAt: { lt: Date } },
          { createdAt: Date; id: { lt: string } },
        ];
        return rows.filter(
          (r) =>
            r.createdAt.getTime() < byTime.createdAt.lt.getTime() ||
            (r.createdAt.getTime() === byTie.createdAt.getTime() && r.id < byTie.id.lt),
        );
      },
    );

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let i = 0; i < 20; i++) {
      const page = await toolCallHistoryService.page(1, cursor);
      seen.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual([
      'msg-3-tc-0',
      'msg-2-tc-1', 'msg-2-tc-0',
      'msg-1-tc-1', 'msg-1-tc-0',
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('hands back a cursor when the batch bound stops a short page', async () => {
    // Every batch is full but carries no tool calls, so the walk hits its bound
    // with nothing to show. Returning null there would pass a truncated list off
    // as the end of history.
    mockPrisma.conversationMessage.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => row(`empty-${i}`, [])),
    );

    const page = await toolCallHistoryService.page(30);

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe('empty-49:0');
  });
});
