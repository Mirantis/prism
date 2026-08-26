/**
 * Compaction Service Tests
 *
 * Covers the auto-trigger guards, the forked summarize request's exact shape,
 * commit semantics for DATABASE vs SLACK threads (fork rows minus tail, never
 * "all rows at commit time"), the manual path, failure handling (nothing is
 * written unless the summarizer produced text; failures never throw), and the
 * post-compaction estimate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelMessage } from 'ai';

const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
}));
vi.mock('ai', () => ({ generateText: mockGenerateText }));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    conversationThread: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    conversationMessage: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}));
vi.mock('../lib/prisma', () => ({ prisma: mockPrisma, default: mockPrisma }));

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    compactionThresholdPercent: 90 as number | null,
    compactionTailMessages: 6,
  },
}));
vi.mock('../config', () => ({ config: mockConfig }));

// Every queued job runs immediately; the last returned promise is kept so
// tests can await the fire-and-forget auto path deterministically.
const { mockRun, runState } = vi.hoisted(() => {
  const runState: { last: Promise<unknown> | null } = { last: null };
  return {
    runState,
    mockRun: vi.fn((_threadId: string, fn: () => Promise<unknown>) => {
      runState.last = fn();
      return runState.last;
    }),
  };
});
vi.mock('./thread-turn.service', () => ({ threadTurnService: { run: mockRun } }));

const { mockGetAgentContext } = vi.hoisted(() => ({ mockGetAgentContext: vi.fn() }));
vi.mock('./context.service', () => ({ contextService: { getAgentContext: mockGetAgentContext } }));

const { mockApplyEstimate } = vi.hoisted(() => ({ mockApplyEstimate: vi.fn() }));
vi.mock('./context-usage.service', () => ({
  contextUsageService: { applyEstimate: mockApplyEstimate },
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));
vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));

vi.mock('../lib/model-catalog', () => ({ MIN_PLAUSIBLE_CONTEXT: 1_000 }));
vi.mock('../lib/langfuse', () => ({ isLangfuseEnabled: () => false }));

// Implementations set via .mockResolvedValue/.mockReturnValue are re-applied in
// beforeEach — the vitest config resets them between tests (only vi.fn(impl)
// arguments survive a reset).
const { mockCreateProvider, mockBuildSystemPromptParts, mockBuildConversationMessages } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(() =>
    Object.assign((modelId: string) => ({ modelId }), {
      cachePoint: () => ({ anthropic: { cacheControl: { type: 'ephemeral' } } }),
    }),
  ),
  mockBuildSystemPromptParts: vi.fn(),
  mockBuildConversationMessages: vi.fn(),
}));
vi.mock('../lib/llm-providers/create-provider', () => ({ createProvider: mockCreateProvider }));
vi.mock('../prompts/context-builder', () => ({
  buildSystemPromptParts: mockBuildSystemPromptParts,
  buildConversationMessages: mockBuildConversationMessages,
}));
vi.mock('../prompts/task-tool-prompt', () => ({
  getTaskToolInstructions: (subs: { name: string }[]) => `TASK TOOLS: ${subs.map((s) => s.name).join(',')}`,
}));

const { mockCollectTools } = vi.hoisted(() => ({ mockCollectTools: vi.fn() }));
vi.mock('../lib/tool-collection', () => ({
  collectTools: mockCollectTools,
  // Real semantics matter here: the last tool must gain the cache breakpoint.
  withToolsCacheControl: (tools: Record<string, unknown>) => tools,
}));
vi.mock('../lib/tool-output-limiter', () => ({
  withOutputLimits: (tools: Record<string, unknown>) => tools,
}));
vi.mock('./agent-workspace.service', () => ({
  resolveEffectiveModel: (stored: string | null | undefined) => stored ?? 'default-model',
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../logger', () => ({ logger: mockLogger }));

import { COMPACTION_PROMPT } from '../prompts/compaction-prompt';
import {
  compactionService,
  type AutoCompactFork,
  type CompactionEvent,
  type CompactionFork,
  type ForkRow,
} from './compaction.service';

const THREAD = 'thread-1';

function makeRows(count: number, overrides: Partial<ForkRow> = {}): ForkRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    externalMessageId: null,
    internalStep: false,
    contentChars: 100,
    ...overrides,
  }));
}

function makeFork(overrides: Partial<AutoCompactFork> = {}): AutoCompactFork {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    threadId: THREAD,
    modelId: 'model-x',
    model: { modelId: 'model-x' } as never,
    cachePoint: { anthropic: { cacheControl: { type: 'ephemeral' as const } } },
    system: [{ role: 'system', content: 'system prompt' }] as never,
    tools: { shell: {} as never },
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'latest' },
    ],
    injections: [],
    finalAssistantText: 'final answer',
    contextRows: makeRows(8),
    snapshot: {
      threadId: THREAD,
      modelId: 'model-x',
      usedTokens: 190_000,
      windowTokens: 200_000,
      usedPercent: 95,
    },
    ...overrides,
  };
}

/** Collect compaction events for the duration of a test. */
const eventListeners: ((event: CompactionEvent) => void)[] = [];
function captureEvents(): CompactionEvent[] {
  const seen: CompactionEvent[] = [];
  const listener = (event: CompactionEvent) => seen.push(event);
  compactionService.events.on('compaction', listener);
  eventListeners.push(listener);
  return seen;
}

/** Await the fire-and-forget auto job (and the service's own catch/finally). */
async function flushAuto(): Promise<void> {
  await runState.last?.catch(() => {});
  // Let the .finally() that clears inFlight run.
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  runState.last = null;
  for (const listener of eventListeners.splice(0)) {
    compactionService.events.off('compaction', listener);
  }
  mockConfig.compactionThresholdPercent = 90;
  mockConfig.compactionTailMessages = 6;
  mockGenerateText.mockResolvedValue({ text: 'THE SUMMARY' });
  mockBuildSystemPromptParts.mockResolvedValue([{ text: 'system prompt', cacheable: true }]);
  mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'hello' }]);
  mockCollectTools.mockResolvedValue({ tools: { shell: { description: 'sh' } }, subagents: [] });
  mockPrisma.conversationThread.update.mockResolvedValue({});
  mockPrisma.conversationMessage.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.conversationThread.findUnique.mockResolvedValue({
    threadSource: 'DATABASE',
    contextTokens: 12_345,
    workspaceRoot: null,
  });
  mockPrisma.conversationMessage.findFirst.mockResolvedValue({
    createdAt: new Date('2026-08-04T10:00:00.000Z'),
  });
  mockApplyEstimate.mockImplementation((input: { usedTokens: number }) => ({
    threadId: THREAD,
    modelId: 'model-x',
    usedTokens: input.usedTokens,
    windowTokens: 200_000,
    usedPercent: 1,
  }));
});

describe('maybeAutoCompact guards', () => {
  it('does nothing when auto-compaction is disabled', () => {
    mockConfig.compactionThresholdPercent = null;
    compactionService.maybeAutoCompact(makeFork());
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('does nothing below the threshold', () => {
    compactionService.maybeAutoCompact(
      makeFork({ snapshot: { ...makeFork().snapshot, usedPercent: 89 } }),
    );
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('fires exactly at the threshold', async () => {
    compactionService.maybeAutoCompact(
      makeFork({ snapshot: { ...makeFork().snapshot, usedPercent: 90 } }),
    );
    expect(mockRun).toHaveBeenCalledTimes(1);
    await flushAuto();
  });

  it('refuses an implausibly small window (poisoned-catalog defense)', () => {
    compactionService.maybeAutoCompact(
      makeFork({ snapshot: { ...makeFork().snapshot, windowTokens: 999 } }),
    );
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('does nothing when the context has no more rows than the tail', () => {
    compactionService.maybeAutoCompact(makeFork({ contextRows: makeRows(6) }));
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('queues at most one compaction per thread at a time', async () => {
    let release!: (value: { text: string }) => void;
    mockGenerateText.mockReturnValue(new Promise((resolve) => (release = resolve)));

    compactionService.maybeAutoCompact(makeFork());
    compactionService.maybeAutoCompact(makeFork());

    expect(mockRun).toHaveBeenCalledTimes(1);
    release({ text: 'THE SUMMARY' });
    await flushAuto();
  });
});

describe('the forked summarize request', () => {
  it('reuses the turn ingredients: system, tools with toolChoice none, history + prompt', async () => {
    const fork = makeFork({
      injections: [{ role: 'user', content: 'mid-turn steer' }],
    });
    compactionService.maybeAutoCompact(fork);
    await flushAuto();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const request = mockGenerateText.mock.calls[0][0];
    expect(request.system).toBe(fork.system);
    expect(request.tools).toBe(fork.tools);
    expect(request.toolChoice).toBe('none');
    expect(request.messages).toEqual([
      ...fork.messages,
      { role: 'user', content: 'mid-turn steer' },
      { role: 'assistant', content: 'final answer' },
      {
        role: 'user',
        content: COMPACTION_PROMPT,
        // The final-message breakpoint is what cache-reads the turn's history.
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ]);
  });

  it('omits the tools field when the turn had none', async () => {
    compactionService.maybeAutoCompact(makeFork({ tools: {} }));
    await flushAuto();
    expect(mockGenerateText.mock.calls[0][0].tools).toBeUndefined();
  });

  it('skips the assistant block when the turn produced no visible text', async () => {
    // An empty assistant content block would be rejected by the provider.
    const fork = makeFork({ finalAssistantText: '  ' });
    compactionService.maybeAutoCompact(fork);
    await flushAuto();
    const { messages } = mockGenerateText.mock.calls[0][0];
    expect(messages).toEqual([
      ...fork.messages,
      {
        role: 'user',
        content: COMPACTION_PROMPT,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ]);
  });
});

describe('commit — DATABASE threads', () => {
  it('marks exactly the fork rows minus the tail, atomically with the summary', async () => {
    const events = captureEvents();
    compactionService.maybeAutoCompact(makeFork());
    await flushAuto();

    // 8 fork rows, tail 6 → the oldest 2 are compacted. A row that landed
    // between fork and commit is by construction not in this id list.
    expect(mockPrisma.conversationMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m0', 'm1'] } },
      data: { isCompacted: true },
    });
    expect(mockPrisma.conversationThread.update).toHaveBeenCalledWith({
      where: { id: THREAD },
      data: {
        compactionSummary: 'THE SUMMARY',
        compactedAt: expect.any(Date),
        compactedThroughTs: '2026-08-04T10:00:00.000Z',
      },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      status: 'completed',
      trigger: 'auto',
      messagesCompacted: 2,
    });
  });

  it('tail 0 compacts every row', async () => {
    mockConfig.compactionTailMessages = 0;
    compactionService.maybeAutoCompact(makeFork({ contextRows: makeRows(3) }));
    await flushAuto();

    expect(mockPrisma.conversationMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m0', 'm1', 'm2'] } },
      data: { isCompacted: true },
    });
  });
});

describe('commit — SLACK threads', () => {
  it('advances the max-ts watermark and flags only internal-step rows', async () => {
    mockPrisma.conversationThread.findUnique.mockResolvedValue({
      threadSource: 'SLACK',
      contextTokens: null,
      workspaceRoot: null,
    });
    mockConfig.compactionTailMessages = 1;
    const rows: ForkRow[] = [
      { id: 's0', externalMessageId: '1700.0002', internalStep: false, contentChars: 50 },
      { id: 'i0', externalMessageId: null, internalStep: true, contentChars: 50 },
      { id: 's1', externalMessageId: '1700.0010', internalStep: false, contentChars: 50 },
      { id: 's2', externalMessageId: '1700.0011', internalStep: false, contentChars: 50 }, // tail
    ];
    compactionService.maybeAutoCompact(makeFork({ contextRows: rows }));
    await flushAuto();

    // Slack-derived rows have synthesized ids that match nothing in the DB —
    // only the internal-step row is flag-flipped.
    expect(mockPrisma.conversationMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['i0'] } },
      data: { isCompacted: true },
    });
    expect(mockPrisma.conversationThread.update).toHaveBeenCalledWith({
      where: { id: THREAD },
      data: {
        compactionSummary: 'THE SUMMARY',
        compactedAt: expect.any(Date),
        compactedThroughTs: '1700.0010',
      },
    });
    // The DB-path watermark query is not used for Slack threads.
    expect(mockPrisma.conversationMessage.findFirst).not.toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  it('writes nothing and emits failed when the summarizer returns empty text', async () => {
    mockGenerateText.mockResolvedValue({ text: '   ' });
    const events = captureEvents();
    compactionService.maybeAutoCompact(makeFork());
    await flushAuto();

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.conversationMessage.updateMany).not.toHaveBeenCalled();
    expect(events.map((e) => e.status)).toEqual(['started', 'failed']);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'compaction failed',
      'user-1',
      expect.objectContaining({ 'compaction.trigger': 'auto' }),
    );
  });

  it('emits failed and never throws when the summarize call rejects', async () => {
    mockGenerateText.mockRejectedValue(new Error('model unavailable'));
    const events = captureEvents();
    compactionService.maybeAutoCompact(makeFork());
    await flushAuto();

    expect(events.at(-1)).toMatchObject({
      status: 'failed',
      trigger: 'auto',
      error: 'model unavailable',
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('finish', () => {
  it('estimates the rebuilt context (summary + tail chars over 4) and pushes it', async () => {
    const events = captureEvents();
    compactionService.maybeAutoCompact(makeFork());
    await flushAuto();

    // summary 'THE SUMMARY' = 11 chars, tail = 6 rows × 100 chars.
    const expected = Math.ceil((11 + 600) / 4);
    expect(mockApplyEstimate).toHaveBeenCalledWith({
      userId: 'user-1',
      threadId: THREAD,
      modelId: 'model-x',
      usedTokens: expected,
    });
    expect(events.at(-1)).toMatchObject({
      status: 'completed',
      tokensBefore: 190_000,
      tokensAfter: expected,
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'compaction finished',
      'user-1',
      expect.objectContaining({
        'compaction.trigger': 'auto',
        'compaction.messages_compacted': '2',
        'context.tokens_before': '190000',
        'context.tokens_after': String(expected),
        'context.window_tokens': '200000',
      }),
    );
  });

  it('reports tokensAfter null when the model window is unknown', async () => {
    mockApplyEstimate.mockReturnValue(null);
    const events = captureEvents();
    compactionService.maybeAutoCompact(makeFork());
    await flushAuto();

    expect(events.at(-1)).toMatchObject({ status: 'completed', tokensAfter: null });
  });
});

describe('maybeCompactAfterOverflow', () => {
  const OVERFLOW = new Error('prompt is too long: 250000 tokens > 200000 maximum');

  function makeOverflowFork(overrides: Partial<CompactionFork> = {}): CompactionFork {
    const { snapshot: _s, finalAssistantText: _f, ...base } = makeFork();
    return { ...base, ...overrides };
  }

  it('skips when the operator disabled auto-compaction', () => {
    mockConfig.compactionThresholdPercent = null;
    compactionService.maybeCompactAfterOverflow(makeOverflowFork());
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('skips when the context has no more rows than the tail', () => {
    compactionService.maybeCompactAfterOverflow(makeOverflowFork({ contextRows: makeRows(6) }));
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('compacts without any threshold or window check — the rejection is the evidence', async () => {
    const events = captureEvents();
    compactionService.maybeCompactAfterOverflow(makeOverflowFork());
    await flushAuto();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockPrisma.conversationMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m0', 'm1'] } },
      data: { isCompacted: true },
    });
    expect(events.map((e) => e.status)).toEqual(['started', 'completed']);
    expect(events.at(-1)).toMatchObject({ trigger: 'auto' });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'compaction finished',
      'user-1',
      expect.objectContaining({ 'compaction.reason': 'overflow' }),
    );
  });

  it('shrinks the history head and retries when the summarize call itself overflows', async () => {
    mockGenerateText
      .mockRejectedValueOnce(OVERFLOW)
      .mockResolvedValueOnce({ text: 'THE SUMMARY' });
    compactionService.maybeCompactAfterOverflow(makeOverflowFork());
    await flushAuto();

    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    const first = mockGenerateText.mock.calls[0][0].messages;
    const second = mockGenerateText.mock.calls[1][0].messages;
    expect(second.length).toBeLessThan(first.length);
    // Re-anchored on a user message so tool-call pairs never split.
    expect(second[0].role).toBe('user');
    // The commit still covers every fork row minus the tail.
    expect(mockPrisma.conversationMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m0', 'm1'] } },
      data: { isCompacted: true },
    });
  });

  it('gives up when the history cannot shrink further', async () => {
    mockGenerateText.mockRejectedValue(OVERFLOW);
    const events = captureEvents();
    compactionService.maybeCompactAfterOverflow(makeOverflowFork());
    await flushAuto();

    // fork.messages has 3 entries: full → 1 message → nothing left to drop.
    expect(mockGenerateText.mock.calls.length).toBeLessThanOrEqual(3);
    expect(events.at(-1)).toMatchObject({ status: 'failed', trigger: 'auto' });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('recovers a history far larger than the window instead of exhausting the retries', async () => {
    // The upgrade case: a thread whose full history was never compacted, so the
    // first turn carries many times the window. Each attempt drops a quarter,
    // so the budget has to reach ~7% for a 10x-oversized history — at the old
    // 5-attempt cap this bottomed out near 32% and the thread was lost.
    const huge: ModelMessage[] = Array.from({ length: 400 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `m${i}`,
    }));
    // Overflow until the history is under a tenth of what it started as.
    mockGenerateText.mockImplementation(async (req: { messages: ModelMessage[] }) => {
      if (req.messages.length > 40) throw OVERFLOW;
      return { text: 'THE SUMMARY' };
    });
    const events = captureEvents();

    compactionService.maybeCompactAfterOverflow(
      makeOverflowFork({ messages: huge, contextRows: makeRows(20) }),
    );
    await flushAuto();

    expect(events.at(-1)).toMatchObject({ status: 'completed', trigger: 'auto' });
    expect(mockPrisma.conversationThread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ compactionSummary: 'THE SUMMARY' }) }),
    );
  });

  it('fails without retrying on a non-overflow summarize error', async () => {
    mockGenerateText.mockRejectedValue(new Error('model unavailable'));
    const events = captureEvents();
    compactionService.maybeCompactAfterOverflow(makeOverflowFork());
    await flushAuto();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'model unavailable' });
  });
});

describe('compactNow (manual)', () => {
  function makeContext(rowCount: number, overrides: Record<string, unknown> = {}) {
    return {
      model: 'stored-model',
      lockedIn: false,
      recentMessages: Array.from({ length: rowCount }, (_, i) => ({
        id: `m${i}`,
        role: 'USER',
        content: 'x'.repeat(100),
        externalMessageId: null,
        internalStep: false,
      })),
      ...overrides,
    };
  }

  it('emits skipped — not failed — when there is nothing to compact', async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(3));
    const events = captureEvents();

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD });

    // A no-op must not read as an error in the UI, nor inflate the failure
    // metric: distinct status, and `compaction failed` is never emitted.
    expect(events.map((e) => e.status)).toEqual(['started', 'skipped']);
    expect(events[1]).toMatchObject({ trigger: 'manual', detail: 'Nothing to compact yet.' });
    expect(events[1].error).toBeUndefined();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'compaction skipped',
      'user-1',
      expect.objectContaining({ 'compaction.trigger': 'manual' }),
    );
    expect(mockTrackEvent).not.toHaveBeenCalledWith('compaction failed', expect.anything(), expect.anything());
  });

  it('rebuilds the context with chat parity: same tools, toolChoice none, cache breakpoints', async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(8));
    const events = captureEvents();

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD });

    const request = mockGenerateText.mock.calls[0][0];
    // The chat tool set rides along so the request shares the tools+system
    // cache prefix chat turns keep warm; 'none' forbids actually calling them.
    expect(mockCollectTools).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD, mode: 'chat' }),
    );
    expect(request.tools).toEqual({ shell: { description: 'sh' } });
    expect(request.toolChoice).toBe('none');
    // Cacheable system parts carry the Anthropic breakpoint, like invoke.ts.
    expect(request.system).toEqual([
      {
        role: 'system',
        content: 'system prompt',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ]);
    expect(request.messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'user',
        content: COMPACTION_PROMPT,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ]);
    expect(mockBuildSystemPromptParts).toHaveBeenCalledWith(
      expect.anything(),
      'chat',
      undefined,
      '',
      undefined,
    );
    // tokensBefore comes from the thread's stored snapshot column.
    expect(events.at(-1)).toMatchObject({
      status: 'completed',
      trigger: 'manual',
      tokensBefore: 12_345,
      messagesCompacted: 2,
    });
  });

  // The tools block is the provider's cache prefix. A chat turn on a locked
  // agent withholds the six workspace-markdown writers, so a compaction that
  // did not pass the flag would assemble a larger block and miss the prefix.
  it('reflects the lock in the tool set, so the block matches the chat turn byte-for-byte', async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(8, { lockedIn: true }));

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD });

    expect(mockCollectTools).toHaveBeenCalledWith(expect.objectContaining({ lockedIn: true }));
  });

  it('leaves the lock off in the tool set for an unlocked agent', async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(8));

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD });

    expect(mockCollectTools).toHaveBeenCalledWith(expect.objectContaining({ lockedIn: false }));
  });

  it('appends the task-tool instructions to the stable system part when subagents exist', async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(8));
    mockCollectTools.mockResolvedValue({
      tools: { shell: {}, Task: {} },
      subagents: [{ name: 'helper', description: 'helps' }],
    });

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD });

    const request = mockGenerateText.mock.calls[0][0];
    expect(request.system[0].content).toBe('system prompt\n\nTASK TOOLS: helper');
  });

  it('omits tools and toolChoice when the chat tool set is empty', async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(8));
    mockCollectTools.mockResolvedValue({ tools: {}, subagents: [] });

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD });

    const request = mockGenerateText.mock.calls[0][0];
    expect(request.tools).toBeUndefined();
    expect(request.toolChoice).toBeUndefined();
  });

  it('emits failed (never throws) when the summarize call rejects', async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(8));
    mockGenerateText.mockRejectedValue(new Error('boom'));
    const events = captureEvents();

    await expect(
      compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD }),
    ).resolves.toBeUndefined();

    expect(events.at(-1)).toMatchObject({ status: 'failed', trigger: 'manual', error: 'boom' });
  });
});

describe('hasCompactableHistory', () => {
  it('is true for DATABASE threads with more uncompacted rows than the tail', async () => {
    mockPrisma.conversationMessage.count.mockResolvedValue(7);
    await expect(compactionService.hasCompactableHistory(THREAD)).resolves.toBe(true);
    expect(mockPrisma.conversationMessage.count).toHaveBeenCalledWith({
      where: { threadId: THREAD, isCompacted: false },
    });
  });

  it('is false at or below the tail', async () => {
    mockPrisma.conversationMessage.count.mockResolvedValue(6);
    await expect(compactionService.hasCompactableHistory(THREAD)).resolves.toBe(false);
  });

  it('passes SLACK threads through — their history lives in Slack, not the DB', async () => {
    mockPrisma.conversationThread.findUnique.mockResolvedValue({ threadSource: 'SLACK' });
    await expect(compactionService.hasCompactableHistory(THREAD)).resolves.toBe(true);
    expect(mockPrisma.conversationMessage.count).not.toHaveBeenCalled();
  });
});
