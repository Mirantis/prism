import { describe, it, expect, vi } from 'vitest';
import { jsonSchema, type Tool } from 'ai';
import { ToolLedgerService } from './tool-ledger.service';
import { ANTHROPIC_TOOL_CHANGES } from '../lib/llm-providers/tool-changes';

const MODEL = 'global.anthropic.claude-opus-5-5';

function tool(
  description: string,
  execute = vi.fn(async () => description),
  properties: Record<string, unknown> = {},
): Tool {
  return { description, inputSchema: jsonSchema({ type: 'object', properties }), execute } as unknown as Tool;
}

function declare(
  ledger: ToolLedgerService,
  available: Record<string, Tool>,
  rowIds: string[],
  options: { threadId?: string; modelId?: string } = {},
) {
  return ledger.declare({
    threadId: options.threadId ?? 'thread-1',
    modelId: options.modelId ?? MODEL,
    protocol: ANTHROPIC_TOOL_CHANGES,
    available,
    rowIds,
  });
}

async function asSchemaJson(declared: Tool) {
  return (declared.inputSchema as { jsonSchema: unknown }).jsonSchema;
}

/** The changes each announcement has, with its row. */
function announced(toolChanges: Awaited<ReturnType<typeof declare>>['toolChanges']) {
  return toolChanges.map(({ afterRowId, message }) => ({
    afterRowId,
    changes: message.providerOptions?.anthropic?.toolChanges,
  }));
}

describe('ToolLedgerService', () => {
  it('declares the first turn\'s tools as loaded, with nothing to announce', async () => {
    const ledger = new ToolLedgerService();

    const first = await declare(ledger, { a: tool('A'), b: tool('B') }, ['u1']);

    expect(Object.keys(first.tools)).toEqual(['a', 'b']);
    expect(first.deferred.size).toBe(0);
    expect(first.toolChanges).toEqual([]);
  });

  it('sends the same list and announces nothing when the tools do not change', async () => {
    const ledger = new ToolLedgerService();
    await declare(ledger, { a: tool('A'), b: tool('B') }, ['u1']);

    const second = await declare(ledger, { a: tool('A'), b: tool('B') }, ['u1', 'r1', 'u2']);

    expect(Object.keys(second.tools)).toEqual(['a', 'b']);
    expect(second.toolChanges).toEqual([]);
  });

  it('keeps a removed tool declared, announces the removal after the last row, and refuses its calls', async () => {
    const ledger = new ToolLedgerService();
    const removedExecute = vi.fn(async () => 'ran');
    await declare(ledger, { a: tool('A'), b: tool('B', removedExecute) }, ['u1']);

    const second = await declare(ledger, { a: tool('A') }, ['u1', 'r1', 'u2']);

    expect(Object.keys(second.tools)).toEqual(['a', 'b']);
    expect(second.tools.b.description).toBe('B');
    expect(announced(second.toolChanges)).toEqual([
      { afterRowId: 'u2', changes: [{ type: 'tool_removal', toolName: 'b' }] },
    ]);
    await expect(
      second.tools.b.execute!({}, { toolCallId: 't1', messages: [] }),
    ).rejects.toThrow('The b tool is not available in this conversation now.');
    expect(removedExecute).not.toHaveBeenCalled();
  });

  it('announces a tool that comes back as an addition, and replays the earlier removal', async () => {
    const ledger = new ToolLedgerService();
    await declare(ledger, { a: tool('A'), b: tool('B') }, ['u1']);
    await declare(ledger, { a: tool('A') }, ['u1', 'r1', 'u2']);

    const third = await declare(ledger, { a: tool('A'), b: tool('B') }, ['u1', 'r1', 'u2', 'r2', 'u3']);

    expect(Object.keys(third.tools)).toEqual(['a', 'b']);
    expect(third.deferred.size).toBe(0);
    expect(announced(third.toolChanges)).toEqual([
      { afterRowId: 'u2', changes: [{ type: 'tool_removal', toolName: 'b' }] },
      { afterRowId: 'u3', changes: [{ type: 'tool_addition', toolName: 'b' }] },
    ]);
  });

  it('appends a tool first seen mid-conversation as deferred and announces it', async () => {
    const ledger = new ToolLedgerService();
    await declare(ledger, { a: tool('A') }, ['u1']);

    const second = await declare(ledger, { c: tool('C'), a: tool('A') }, ['u1', 'r1', 'u2']);

    expect(Object.keys(second.tools)).toEqual(['a', 'c']);
    expect(second.deferred).toEqual(new Set(['c']));
    expect(second.tools.c.providerOptions).toEqual({ anthropic: { deferLoading: true } });
    expect(announced(second.toolChanges)).toEqual([
      { afterRowId: 'u2', changes: [{ type: 'tool_addition', toolName: 'c' }] },
    ]);
  });

  it('runs the turn\'s own execute under the declared definition', async () => {
    const ledger = new ToolLedgerService();
    await declare(ledger, { a: tool('A') }, ['u1']);
    const liveExecute = vi.fn(async () => 'live');

    const second = await declare(ledger, { a: tool('A', liveExecute) }, ['u1', 'r1', 'u2']);

    await expect(second.tools.a.execute!({}, { toolCallId: 't1', messages: [] })).resolves.toBe('live');
  });

  it('replaces a definition that changes, in its place and with its loading', async () => {
    // An MCP server that adds a required parameter: calls with the old schema would fail.
    const ledger = new ToolLedgerService();
    await declare(ledger, { a: tool('A'), b: tool('B') }, ['u1']);
    await declare(ledger, { a: tool('A'), b: tool('B'), c: tool('C') }, ['u1', 'r1', 'u2']);

    const third = await declare(
      ledger,
      { a: tool('A', undefined, { region: { type: 'string' } }), b: tool('B'), c: tool('C, now with a region') },
      ['u1', 'r1', 'u2', 'r2', 'u3'],
    );

    expect(Object.keys(third.tools)).toEqual(['a', 'b', 'c']);
    expect(await asSchemaJson(third.tools.a)).toEqual({ type: 'object', properties: { region: { type: 'string' } } });
    expect(third.tools.c.description).toBe('C, now with a region');
    expect(third.tools.c.providerOptions).toEqual({ anthropic: { deferLoading: true } });
    expect(third.toolChanges).toHaveLength(1);
  });

  it('folds the announcements of compacted rows into their net change at the start', async () => {
    const ledger = new ToolLedgerService();
    await declare(ledger, { a: tool('A'), b: tool('B'), c: tool('C') }, ['u1']);
    await declare(ledger, { a: tool('A'), c: tool('C') }, ['u1', 'r1', 'u2']);
    await declare(ledger, { a: tool('A'), b: tool('B') }, ['u1', 'r1', 'u2', 'r2', 'u3']);
    await declare(ledger, { a: tool('A') }, ['u1', 'r1', 'u2', 'r2', 'u3', 'r3', 'u4']);

    // Compaction kept the rows from r3 on.
    const after = await declare(ledger, { a: tool('A') }, ['r3', 'u4', 'r4', 'u5']);

    expect(Object.keys(after.tools)).toEqual(['a', 'b', 'c']);
    expect(announced(after.toolChanges)).toEqual([
      // u2 removed b and u3 put it back and removed c: c's removal is what is left.
      { afterRowId: null, changes: [{ type: 'tool_removal', toolName: 'c' }] },
      { afterRowId: 'u4', changes: [{ type: 'tool_removal', toolName: 'b' }] },
    ]);
  });

  it('starts a new list after a restart, with nothing to replay', async () => {
    const before = new ToolLedgerService();
    await declare(before, { a: tool('A'), b: tool('B') }, ['u1']);
    await declare(before, { a: tool('A') }, ['u1', 'r1', 'u2']);

    const restarted = new ToolLedgerService();
    const first = await declare(restarted, { a: tool('A') }, ['u1', 'r1', 'u2', 'r2', 'u3']);

    expect(Object.keys(first.tools)).toEqual(['a']);
    expect(first.toolChanges).toEqual([]);
  });

  it('keeps a list of its own for each model the conversation runs on', async () => {
    const ledger = new ToolLedgerService();
    await declare(ledger, { a: tool('A'), b: tool('B') }, ['u1']);

    // A thread-bound cron task with a model of its own, then the chat model again.
    const other = await declare(ledger, { a: tool('A') }, ['u1', 'r1'], { modelId: 'us.anthropic.claude-opus-4-8' });
    const back = await declare(ledger, { a: tool('A'), b: tool('B') }, ['u1', 'r1', 'r2', 'u3']);

    expect(Object.keys(other.tools)).toEqual(['a']);
    expect(other.toolChanges).toEqual([]);
    expect(Object.keys(back.tools)).toEqual(['a', 'b']);
    expect(back.toolChanges).toEqual([]);
  });

  it('shows the declared list without recording anything, every tool refusing', async () => {
    const ledger = new ToolLedgerService();
    const execute = vi.fn(async () => 'ran');
    await declare(ledger, { a: tool('A', execute), b: tool('B') }, ['u1']);
    await declare(ledger, { a: tool('A', execute) }, ['u1', 'r1', 'u2']);

    const peeked = ledger.peek({ threadId: 'thread-1', modelId: MODEL, protocol: ANTHROPIC_TOOL_CHANGES })!;

    expect(Object.keys(peeked.tools)).toEqual(['a', 'b']);
    expect(announced(peeked.toolChanges)).toEqual([
      { afterRowId: 'u2', changes: [{ type: 'tool_removal', toolName: 'b' }] },
    ]);
    await expect(peeked.tools.a.execute!({}, { toolCallId: 't1', messages: [] })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(ledger.peek({ threadId: 'thread-2', modelId: MODEL, protocol: ANTHROPIC_TOOL_CHANGES })).toBeUndefined();
    expect(ledger.peek({ threadId: 'thread-1', modelId: 'other', protocol: ANTHROPIC_TOOL_CHANGES })).toBeUndefined();
  });

  it('forgets the least recently used conversation past its bound', async () => {
    const ledger = new ToolLedgerService();
    for (let i = 0; i <= 100; i++) {
      await declare(ledger, { a: tool('A') }, ['u1'], { threadId: `thread-${i}` });
    }

    expect(ledger.peek({ threadId: 'thread-0', modelId: MODEL, protocol: ANTHROPIC_TOOL_CHANGES })).toBeUndefined();
    expect(ledger.peek({ threadId: 'thread-1', modelId: MODEL, protocol: ANTHROPIC_TOOL_CHANGES })).toBeDefined();
  });
});
