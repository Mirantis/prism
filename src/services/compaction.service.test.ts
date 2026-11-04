/**
 * Compaction Service Tests
 *
 * Covers the auto-trigger guards, the forked summarize request's exact shape,
 * commit semantics for DATABASE vs SLACK threads (fork rows minus tail, never
 * "all rows at commit time"), the manual path, failure handling (nothing is
 * written unless the summarizer produced text; failures never throw), and the
 * post-compaction estimate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModelMessage } from 'ai';

const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
}));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: mockGenerateText,
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    conversationThread: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    conversationMessage: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
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
    idleCompaction: true,
    chatCacheTtl: '5m' as '5m' | '1h',
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
vi.mock('../lib/context-window', () => ({ contextWindowFor: () => null }));
vi.mock('../lib/langfuse', () => ({ isLangfuseEnabled: () => false }));

// Implementations set via .mockResolvedValue/.mockReturnValue are re-applied in
// beforeEach — the vitest config resets them between tests (only vi.fn(impl)
// arguments survive a reset).
const { mockCreateProvider, mockBuildSystemPromptParts, mockBuildConversationMessages } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(() =>
    Object.assign((modelId: string) => ({ modelId }), {
      // A spy rather than a constant, so the chat-parity test can pin which
      // model id the breakpoint was resolved against. On Bedrock the namespace
      // follows the model, and a mismatch is discarded without an error.
      cachePoint: vi.fn(() => ({ anthropic: { cacheControl: { type: 'ephemeral' } } })),
    }),
  ),
  mockBuildSystemPromptParts: vi.fn(),
  mockBuildConversationMessages: vi.fn(),
}));
vi.mock('../lib/llm-providers/create-provider', () => ({ createProvider: mockCreateProvider }));
// Every announcement comes back as trailing; where each one lands is
// context-builder.test.ts's business.
const { mockBuildConversationHistory } = vi.hoisted(() => ({
  mockBuildConversationHistory: vi.fn(
    (context: unknown, toolChanges: Array<{ message: unknown }> = []) => ({
      messages: mockBuildConversationMessages(context),
      trailingToolChanges: toolChanges.map((change) => change.message),
    }),
  ),
}));
vi.mock('../prompts/context-builder', () => ({
  buildSystemPromptParts: mockBuildSystemPromptParts,
  buildConversationHistory: mockBuildConversationHistory,
  SUMMARY_MESSAGE_OPENING: '<conversation-summary>',
}));
const { mockThreadContext } = vi.hoisted(() => ({ mockThreadContext: vi.fn() }));
vi.mock('./message-delivery.service', () => ({ messageDeliveryService: { threadContext: mockThreadContext } }));
// A thread with no channel label, unless a test gives one.
beforeEach(() => {
  mockThreadContext.mockImplementation(async (threadId: string) => ({ channel: 'websocket', threadId }));
});
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
  withToolOutputCapture: (tools: Record<string, unknown>) => tools,
}));

vi.mock('./agent-workspace.service', () => ({
  agentWorkspaceService: { getSubagents: vi.fn(async () => []) },
  resolveEffectiveModel: (stored: string | null | undefined) => stored ?? 'default-model',
}));

const { mockNewestThreadCall, mockListIdleCandidates } = vi.hoisted(() => ({
  mockNewestThreadCall: vi.fn(),
  mockListIdleCandidates: vi.fn(),
}));
vi.mock('./llm-call.service', () => ({ llmCallService: { newestThreadCall: mockNewestThreadCall } }));
vi.mock('./conversation.service', () => ({
  conversationService: { listIdleCompactionCandidates: mockListIdleCandidates },
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../logger', () => ({ logger: mockLogger }));

import { COMPACTION_PROMPT } from '../prompts/compaction-prompt';
import { ANTHROPIC_TOOL_CHANGES } from '../lib/llm-providers/tool-changes';
import { toolLedgerService } from './tool-ledger.service';
import {
  compactionService,
  type AutoCompactFork,
  type CompactionEvent,
  type CompactionFork,
  type ForkRow,
  splitTail,
  toForkRows,
} from './compaction.service';

const THREAD = 'thread-1';

function makeRows(count: number, overrides: Partial<ForkRow> = {}): ForkRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    externalMessageId: null,
    internalStep: false,
    // Rows alternate request and reply, so the tail can start on any even index.
    fromUser: i % 2 === 0,
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
    cacheRequest: {},
    system: [{ role: 'system', content: 'system prompt' }] as never,
    tools: { shell: {} as never },
    declaredTools: false,
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
  mockConfig.idleCompaction = true;
  mockConfig.chatCacheTtl = '5m';
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
  mockPrisma.conversationMessage.findMany.mockResolvedValue([]);
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

  it("sends the turn's request-level cache options", async () => {
    const cacheRequest = { openai: { promptCacheOptions: { ttl: '12h' as const } } };
    compactionService.maybeAutoCompact(makeFork({ cacheRequest }));
    await flushAuto();

    expect(mockGenerateText.mock.calls[0][0].providerOptions).toBe(cacheRequest);
  });

  it('sends a declared tool list under auto, refusing every call', async () => {
    // Under 'none' the provider SDK sends no tools block, which the replayed
    // announcements need.
    const execute = vi.fn();
    compactionService.maybeAutoCompact(makeFork({ declaredTools: true, tools: { shell: { execute } as never } }));
    await flushAuto();

    const request = mockGenerateText.mock.calls[0][0];
    expect(request.toolChoice).toBe('auto');
    expect(request.allowSystemInMessages).toBe(true);
    // A model that calls a tool anyway answers after the refusal.
    expect(request.stopWhen).toBeDefined();
    await expect(request.tools.shell.execute({}, {})).rejects.toThrow('not available');
    expect(execute).not.toHaveBeenCalled();
  });

  it('sends the turn\'s own tools under none when it had no declared list', async () => {
    compactionService.maybeAutoCompact(makeFork());
    await flushAuto();
    expect(mockGenerateText.mock.calls[0][0].toolChoice).toBe('none');
    expect('allowSystemInMessages' in mockGenerateText.mock.calls[0][0]).toBe(false);
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
      { id: 's0', externalMessageId: '1700.0002', internalStep: false, fromUser: false, contentChars: 50 },
      { id: 'i0', externalMessageId: null, internalStep: true, fromUser: false, contentChars: 50 },
      { id: 's1', externalMessageId: '1700.0010', internalStep: false, fromUser: false, contentChars: 50 },
      { id: 's2', externalMessageId: '1700.0011', internalStep: false, fromUser: true, contentChars: 50 }, // tail
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

  it("sends the turn's request-level cache options", async () => {
    const cacheRequest = { openai: { promptCacheOptions: { ttl: '12h' as const } } };
    compactionService.maybeCompactAfterOverflow(makeOverflowFork({ cacheRequest }));
    await flushAuto();

    expect(mockGenerateText.mock.calls[0][0].providerOptions).toBe(cacheRequest);
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
      modelSelection: { mode: 'fixed', tiers: { small: null, medium: null, large: null } },
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

  it("gives a shared conversation's summary the senders and the channel instructions", async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(8));
    mockThreadContext.mockResolvedValue({ channel: 'websocket', threadId: THREAD, channelLabel: 'the web chat' });

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD });

    expect(mockThreadContext).toHaveBeenCalledWith(THREAD);
    expect(mockBuildConversationHistory.mock.calls[0][3]).toBe(true);
    const stable = mockGenerateText.mock.calls[0][0].system[0].content as string;
    expect(stable).toContain('## Channel Participation');
    expect(stable).toContain('You are in the web chat.');
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
    // `run_program` too, which a chat turn adds after the collected tools.
    expect(Object.keys(request.tools)).toEqual(['shell', 'run_program']);
    expect(request.tools.shell).toEqual({ description: 'sh' });
    expect(request.toolChoice).toBe('none');
    // Resolved against the model this compaction actually runs, not the agent's
    // stored default — the two differ under a mode override, and a breakpoint
    // aimed at the wrong protocol is dropped silently.
    expect(mockCreateProvider.mock.results[0]?.value.cachePoint).toHaveBeenCalledWith('stored-model', '5m');
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
    // Built exactly as a chat turn builds it, so this request reads the prefix
    // those turns keep warm instead of prefilling one of its own.
    expect(mockBuildSystemPromptParts).toHaveBeenCalledWith(
      expect.anything(),
      'chat',
      undefined,
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

  it('declares the tool list for a conversation it has no record of, as after a restart', async () => {
    // Under tool choice 'none' the SDK sends no tools block, so a request without a
    // declared list missed the prefix the chat turns cached.
    mockGetAgentContext.mockResolvedValue(makeContext(8));
    mockCreateProvider.mockReturnValueOnce(
      Object.assign((modelId: string) => ({ modelId }), {
        cachePoint: vi.fn(() => ({ anthropic: { cacheControl: { type: 'ephemeral' } } })),
        toolChanges: () => ANTHROPIC_TOOL_CHANGES,
      }),
    );

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: 'thread-after-restart' });

    const request = mockGenerateText.mock.calls[0][0];
    expect(mockCollectTools).toHaveBeenCalled();
    expect(Object.keys(request.tools)).toEqual(['shell', 'run_program']);
    expect(request.toolChoice).toBe('auto');
    // The record it leaves is the baseline the next chat turn would have declared.
    const record = toolLedgerService.peek({ threadId: 'thread-after-restart', modelId: 'stored-model', protocol: ANTHROPIC_TOOL_CHANGES });
    expect(Object.keys(record?.tools ?? {})).toEqual(['shell', 'run_program']);
    expect(record?.toolChanges).toEqual([]);
    expect(record?.deferred.size).toBe(0);
  });

  it('sends the declared list of a conversation that has one, with its announcements', async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(8));
    mockCreateProvider.mockReturnValueOnce(
      Object.assign((modelId: string) => ({ modelId }), {
        cachePoint: vi.fn(() => ({ anthropic: { cacheControl: { type: 'ephemeral' } } })),
        toolChanges: () => ANTHROPIC_TOOL_CHANGES,
      }),
    );
    const declare = async (available: Record<string, unknown>, rowIds: string[]) =>
      toolLedgerService.declare({
        threadId: THREAD,
        modelId: 'stored-model',
        protocol: ANTHROPIC_TOOL_CHANGES,
        available: available as never,
        rowIds,
      });
    await declare({ shell: { description: 'sh' }, browse: { description: 'web' } }, ['m0']);
    await declare({ shell: { description: 'sh' } }, ['m0', 'm1']);
    const removal = {
      role: 'system',
      content: '',
      providerOptions: { anthropic: { toolChanges: [{ type: 'tool_removal', toolName: 'browse' }] } },
    };

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD });

    const request = mockGenerateText.mock.calls[0][0];
    expect(mockCollectTools).not.toHaveBeenCalled();
    expect(Object.keys(request.tools)).toEqual(['shell', 'browse']);
    expect(request.toolChoice).toBe('auto');
    expect(request.allowSystemInMessages).toBe(true);
    expect(mockBuildConversationHistory).toHaveBeenCalledWith(
      expect.anything(),
      [{ afterRowId: 'm1', message: removal }],
      undefined,
      false,
    );
    expect(request.messages.slice(-2)).toEqual([
      {
        role: 'user',
        content: COMPACTION_PROMPT,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      removal,
    ]);
  });

  it('sends only run_program when the chat tool set is empty, as a chat turn does', async () => {
    mockGetAgentContext.mockResolvedValue(makeContext(8));
    mockCollectTools.mockResolvedValue({ tools: {}, subagents: [] });

    await compactionService.compactNow({ userId: 'user-1', agentId: 'agent-1', threadId: THREAD });

    const request = mockGenerateText.mock.calls[0][0];
    expect(Object.keys(request.tools)).toEqual(['run_program']);
    expect(request.toolChoice).toBe('none');
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
  it('is true for a DATABASE thread with any uncompacted message', async () => {
    mockPrisma.conversationMessage.count.mockResolvedValue(1);
    await expect(compactionService.hasCompactableHistory(THREAD)).resolves.toBe(true);
    expect(mockPrisma.conversationMessage.count).toHaveBeenCalledWith({
      where: { threadId: THREAD, isCompacted: false },
    });
  });

  it('is false for a thread with no uncompacted message', async () => {
    mockPrisma.conversationMessage.count.mockResolvedValue(0);
    await expect(compactionService.hasCompactableHistory(THREAD)).resolves.toBe(false);
  });

  it('passes SLACK threads through — their history lives in Slack, not the DB', async () => {
    mockPrisma.conversationThread.findUnique.mockResolvedValue({ threadSource: 'SLACK' });
    await expect(compactionService.hasCompactableHistory(THREAD)).resolves.toBe(true);
    expect(mockPrisma.conversationMessage.count).not.toHaveBeenCalled();
  });
});


describe('splitTail', () => {
  const row = (id: string, fromUser: boolean, contentChars = 100): ForkRow => ({
    id,
    externalMessageId: null,
    internalStep: false,
    fromUser,
    contentChars,
  });

  it('starts the tail on a user message, never on the reply that answers it', () => {
    mockConfig.compactionTailMessages = 3;
    const rows = [row('u0', true), row('a0', false), row('u1', true), row('a1', false), row('a2', false)];

    const { compactable, tail } = splitTail(rows);

    // Three newest rows would start on a1's request-less reply; the tail backs off to u1.
    expect(tail.map((r) => r.id)).toEqual(['u1', 'a1', 'a2']);
    expect(compactable.map((r) => r.id)).toEqual(['u0', 'a0']);
  });

  it('leaves out a reply whose tool output alone exceeds the token budget', () => {
    const rows = [row('u0', true), row('a0', false, 500_000), row('u1', true), row('a1', false)];

    expect(splitTail(rows).tail.map((r) => r.id)).toEqual(['u1', 'a1']);
  });

  it('keeps the newest request when its reply alone has more step rows than the cap', () => {
    mockConfig.compactionTailMessages = 3;
    const rows = [row('u0', true), row('a0', false), row('u1', true), ...['s1', 's2', 's3', 's4'].map((id) => row(id, false))];

    expect(splitTail(rows).tail.map((r) => r.id)).toEqual(['u1', 's1', 's2', 's3', 's4']);
  });

  it('starts the tail on the request, not on the recalled-memory block stored after it', () => {
    mockConfig.compactionTailMessages = 6;
    const recall: ForkRow = { ...row('r1', false), internalStep: true };
    const rows = [row('u0', true), row('a0', false), row('u1', true), recall, ...['s1', 's2', 's3', 's4', 's5'].map((id) => row(id, false))];

    expect(splitTail(rows).tail.map((r) => r.id)).toEqual(['u1', 'r1', 's1', 's2', 's3', 's4', 's5']);
  });

  it('keeps the newest rows that fit in a thread with no user message', () => {
    mockConfig.compactionTailMessages = 3;
    const rows = ['g1', 'g2', 'g3', 'g4', 'g5'].map((id) => row(id, false));

    expect(splitTail(rows).tail.map((r) => r.id)).toEqual(['g3', 'g4', 'g5']);
  });

  it('stops at the token budget in a thread with no user message', () => {
    const rows = [row('g1', false), row('g2', false), row('g3', false, 500_000), row('g4', false), row('g5', false)];

    expect(splitTail(rows).tail.map((r) => r.id)).toEqual(['g4', 'g5']);
  });

  it('keeps nothing when the newest row of such a thread is over the budget', () => {
    const rows = [row('g1', false), row('g2', false, 500_000)];

    expect(splitTail(rows).tail).toEqual([]);
  });

  it('reads a recalled-memory block, stored in a user row, as no request', () => {
    const [recall, request] = toForkRows([
      { id: 'r1', role: 'USER', internalStep: true, content: '<recalled-memories>' },
      { id: 'u1', role: 'USER', content: 'deploy it' },
    ]);

    expect(recall.fromUser).toBe(false);
    expect(request.fromUser).toBe(true);
  });

  it('summarizes everything with a tail of 0', () => {
    mockConfig.compactionTailMessages = 0;
    const rows = [row('u0', true), row('a0', false)];

    expect(splitTail(rows)).toEqual({ compactable: rows, tail: [] });
  });

  it('summarizes everything when even the newest exchange does not fit', () => {
    const rows = [row('u0', true), row('a0', false), row('u1', true), row('a1', false, 500_000)];

    const { compactable, tail } = splitTail(rows);

    expect(tail).toEqual([]);
    expect(compactable).toHaveLength(4);
  });
});

describe('summary checks', () => {
  it('writes nothing when the summary was cut off at the output limit', async () => {
    mockGenerateText.mockResolvedValue({ text: '## Goal\n- half a summ', finishReason: 'length' });
    const events = captureEvents();

    compactionService.maybeAutoCompact(makeFork());
    await flushAuto();

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: expect.stringContaining('cut off') });
  });

  it('keeps a previous summary when overflow recovery shrinks the history', async () => {
    const OVERFLOW = Object.assign(new Error('prompt is too long: 1200000 tokens > 1000000 maximum'), {
      statusCode: 400,
    });
    mockGenerateText.mockRejectedValueOnce(OVERFLOW).mockResolvedValueOnce({ text: 'THE SUMMARY' });
    const summary: ModelMessage = { role: 'user', content: '<conversation-summary>\nearlier' };
    const messages: ModelMessage[] = [
      summary,
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    const { snapshot: _s, finalAssistantText: _f, ...base } = makeFork();

    compactionService.maybeCompactAfterOverflow({ ...base, messages });
    await flushAuto();

    const retried = mockGenerateText.mock.calls[1][0].messages as ModelMessage[];
    expect(retried[0]).toBe(summary);
    expect(retried.map((m) => m.content)).not.toContain('q1');
  });

  it('drops the summary last, when nothing else is left to drop', async () => {
    const OVERFLOW = new Error('prompt is too long: 250000 tokens > 200000 maximum');
    mockGenerateText.mockRejectedValueOnce(OVERFLOW).mockResolvedValueOnce({ text: 'THE SUMMARY' });
    const summary: ModelMessage = { role: 'user', content: '<conversation-summary>\nhuge' };
    const { snapshot: _s, finalAssistantText: _f, ...base } = makeFork();

    compactionService.maybeCompactAfterOverflow({
      ...base,
      messages: [summary, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }],
    });
    await flushAuto();

    // Behind the summary there is one exchange, which a quarter-cut cannot shorten.
    const last = mockGenerateText.mock.calls[1][0].messages as ModelMessage[];
    expect(last.map((m) => m.content)).toEqual(['q1', 'a1', COMPACTION_PROMPT]);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});

describe('summary output budget', () => {
  it('asks for no more output than the window has room for', async () => {
    compactionService.maybeAutoCompact(
      makeFork({ snapshot: { threadId: THREAD, modelId: 'model-x', usedTokens: 186_000, windowTokens: 200_000, usedPercent: 93 } }),
    );
    await flushAuto();

    expect(mockGenerateText.mock.calls[0][0].maxOutputTokens).toBe(10_000);
  });

  it("asks for a chat turn's budget on a large window", async () => {
    compactionService.maybeAutoCompact(
      makeFork({ snapshot: { threadId: THREAD, modelId: 'model-x', usedTokens: 900_000, windowTokens: 1_000_000, usedPercent: 90 } }),
    );
    await flushAuto();

    expect(mockGenerateText.mock.calls[0][0].maxOutputTokens).toBe(16_000);
  });
});


describe('idle compaction', () => {
  const HOUR = 60 * 60 * 1000;
  const oneHourCache = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: '1h' as const } } };
  const turn = (overrides: Record<string, unknown> = {}) => ({
    userId: 'user-1',
    agentId: 'agent-1',
    threadId: THREAD,
    provider: mockCreateProvider(),
    modelId: 'stored-model',
    usedTokens: 250_000,
    ...overrides,
  });
  const context = {
    model: 'stored-model',
    modelSelection: { mode: 'fixed', tiers: { small: null, medium: null, large: null } },
    lockedIn: false,
    recentMessages: Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'USER' : 'AGENT',
      content: 'x'.repeat(100),
      externalMessageId: null,
      internalStep: false,
    })),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockConfig.chatCacheTtl = '1h';
    const provider = mockCreateProvider();
    (provider.cachePoint as ReturnType<typeof vi.fn>).mockImplementation((_id: string, ttl?: string) =>
      ttl === '1h' ? oneHourCache : { anthropic: { cacheControl: { type: 'ephemeral' } } },
    );
    mockCreateProvider.mockReturnValue(provider);
    mockGetAgentContext.mockResolvedValue(context);
    mockNewestThreadCall.mockResolvedValue(null);
    mockListIdleCandidates.mockResolvedValue([]);
  });
  afterEach(() => {
    compactionService.cancelIdle(THREAD);
    vi.useRealTimers();
  });

  /** Fire the due timer, then let the queued job and its settle run on real timers. */
  async function fire(ms: number): Promise<void> {
    vi.advanceTimersByTime(ms);
    vi.useRealTimers();
    await flushAuto();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('compacts a large conversation shortly before its one-hour cache expires, from the stored thread', async () => {
    const events = captureEvents();
    compactionService.armIdle(turn());

    vi.advanceTimersByTime(0.9 * HOUR - 1);
    expect(mockRun).not.toHaveBeenCalled();
    await fire(1);

    expect(mockGetAgentContext).toHaveBeenCalled();
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ status: 'completed', trigger: 'auto', idle: true });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'compaction finished',
      'user-1',
      expect.objectContaining({ 'compaction.reason': 'idle' }),
    );
  });

  it('does nothing when the thread is used again before the timer fires', () => {
    compactionService.armIdle(turn());
    compactionService.cancelIdle(THREAD);

    vi.advanceTimersByTime(HOUR);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("runs when the turn's own last call row is stamped just after the timer was armed", async () => {
    compactionService.armIdle(turn());
    mockNewestThreadCall.mockResolvedValue({ purpose: 'chat', model: 'm', createdAt: new Date(Date.now() + 1) });

    await fire(0.9 * HOUR);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('skips a timer that fired while a newer turn ran on the thread', async () => {
    compactionService.armIdle(turn());
    mockNewestThreadCall.mockResolvedValue({ purpose: 'chat', model: 'm', createdAt: new Date(Date.now() + HOUR) });

    await fire(0.9 * HOUR);

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(compactionService.hasInFlight()).toBe(false);
  });

  it('skips a timer when a compaction committed after the turn', async () => {
    compactionService.armIdle(turn());
    mockPrisma.conversationThread.findUnique.mockResolvedValueOnce({ compactedAt: new Date(Date.now() + 1_000) });

    await fire(0.9 * HOUR);

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(compactionService.hasInFlight()).toBe(false);
  });

  it('arms nothing when chat turns use the five-minute cache', () => {
    mockConfig.chatCacheTtl = '5m';
    compactionService.armIdle(turn());

    vi.advanceTimersByTime(2 * HOUR);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('arms nothing on a vendor whose cache lasts no longer under 1h', () => {
    // An empty breakpoint and no declared lifetime: five minutes either way.
    const provider = mockCreateProvider();
    (provider.cachePoint as ReturnType<typeof vi.fn>).mockReturnValue({});
    compactionService.armIdle(turn({ provider }));

    vi.advanceTimersByTime(2 * HOUR);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('arms nothing for a conversation under the size floor', () => {
    compactionService.armIdle(turn({ usedTokens: 150_000 }));

    vi.advanceTimersByTime(2 * HOUR);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('writes no cache entry for a summary whose cache has expired', async () => {
    // The one-hour cache expired an hour before the timer fired, as after a long restart.
    compactionService.armIdle(turn());
    mockNewestThreadCall.mockResolvedValue({ purpose: 'chat', model: 'm', createdAt: new Date(Date.now() - 2 * HOUR) });

    await fire(0.9 * HOUR);

    const request = mockGenerateText.mock.calls[0][0];
    expect(JSON.stringify(request)).not.toContain('cacheControl');
  });

  it('keeps the breakpoints while a one-hour cache is still warm', async () => {
    compactionService.armIdle(turn());

    await fire(0.9 * HOUR);

    expect(JSON.stringify(mockGenerateText.mock.calls[0][0])).toContain('cacheControl');
  });

  describe('on a vendor whose lifetime is a request option', () => {
    const provider = mockCreateProvider();
    beforeEach(() => {
      (provider.cachePoint as ReturnType<typeof vi.fn>).mockReturnValue({});
      Object.assign(provider, {
        cacheRequest: (_id: string, ttl: string, write: boolean) =>
          ttl === '1h' ? { openai: { promptCacheOptions: write ? { ttl: '12h' } : { mode: 'explicit' } } } : {},
        cacheTtlMs: (_id: string, ttl: string) => (ttl === '1h' ? 12 * HOUR : HOUR / 2),
      });
      mockCreateProvider.mockReturnValue(provider);
      mockConfig.chatCacheTtl = '1h';
    });

    it("waits for most of the vendor's lifetime, then sends it while the cache is warm", async () => {
      compactionService.armIdle(turn());

      vi.advanceTimersByTime(HOUR);
      expect(mockRun).not.toHaveBeenCalled();
      await fire(0.9 * 12 * HOUR - HOUR);

      expect(mockGenerateText.mock.calls[0][0].providerOptions).toEqual({
        openai: { promptCacheOptions: { ttl: '12h' } },
      });
    });

    it('asks for no entry once that cache has expired', async () => {
      compactionService.armIdle(turn());
      mockNewestThreadCall.mockResolvedValue({ purpose: 'chat', model: 'm', createdAt: new Date(Date.now() - 13 * HOUR) });

      await fire(0.9 * 12 * HOUR);

      expect(mockGenerateText.mock.calls[0][0].providerOptions).toEqual({
        openai: { promptCacheOptions: { mode: 'explicit' } },
      });
    });
  });

  it('arms nothing with IDLE_COMPACTION=off', () => {
    mockConfig.idleCompaction = false;
    compactionService.armIdle(turn());

    vi.advanceTimersByTime(2 * HOUR);
    expect(mockRun).not.toHaveBeenCalled();
  });

  describe('after a restart', () => {
    const candidate = { id: THREAD, agentId: 'agent-1', userId: 'user-1', compactedAt: null };
    const chatCall = (agoMs: number) => ({ purpose: 'chat', model: 'stored-model', createdAt: new Date(Date.now() - agoMs) });
    const provider = mockCreateProvider();
    beforeEach(() => {
      (provider.cachePoint as ReturnType<typeof vi.fn>).mockImplementation((_id: string, ttl?: string) =>
        ttl === '1h' ? oneHourCache : { anthropic: { cacheControl: { type: 'ephemeral' } } },
      );
      mockCreateProvider.mockReturnValue(provider);
      mockListIdleCandidates.mockResolvedValue([candidate]);
    });

    it('re-arms the timer for the rest of the wait', async () => {
      mockNewestThreadCall.mockResolvedValue(chatCall(30 * 60 * 1000));
      await compactionService.restoreIdle();

      vi.advanceTimersByTime(23 * 60 * 1000);
      expect(mockRun).not.toHaveBeenCalled();
      await fire(60 * 1000 + 1);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('compacts at once a conversation whose cache has already expired', async () => {
      mockNewestThreadCall.mockResolvedValue(chatCall(2 * HOUR));
      await compactionService.restoreIdle();

      await fire(0);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('leaves a conversation compacted after its last turn', async () => {
      mockNewestThreadCall.mockResolvedValue(chatCall(30 * 60 * 1000));
      mockListIdleCandidates.mockResolvedValue([{ ...candidate, compactedAt: new Date() }]);
      await compactionService.restoreIdle();

      vi.advanceTimersByTime(2 * HOUR);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('compacts a conversation whose summary a restart stopped before its commit', async () => {
      // An earlier compaction committed before the last turn; the idle summary after it never did.
      mockListIdleCandidates.mockResolvedValue([{ ...candidate, compactedAt: new Date(Date.now() - 3 * HOUR) }]);
      mockNewestThreadCall.mockResolvedValue(chatCall(2 * HOUR));
      await compactionService.restoreIdle();

      expect(mockNewestThreadCall).toHaveBeenCalledWith(THREAD, expect.not.arrayContaining(['compaction']));
      await fire(0);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('leaves a conversation whose newest call was not a chat turn', async () => {
      mockNewestThreadCall.mockResolvedValue({ ...chatCall(30 * 60 * 1000), purpose: 'cron' });
      await compactionService.restoreIdle();

      vi.advanceTimersByTime(2 * HOUR);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('restores nothing when chat turns use the five-minute cache', async () => {
      mockConfig.chatCacheTtl = '5m';
      await compactionService.restoreIdle();

      expect(mockListIdleCandidates).not.toHaveBeenCalled();
    });

    it("waits out the rest of the newest call's lifetime on its vendor", async () => {
      Object.assign(provider, { cacheTtlMs: (_id: string, ttl: string) => (ttl === '1h' ? 12 * HOUR : HOUR / 2) });
      mockNewestThreadCall.mockResolvedValue(chatCall(2 * HOUR));
      await compactionService.restoreIdle();

      vi.advanceTimersByTime(0.9 * 12 * HOUR - 2 * HOUR - 1);
      expect(mockRun).not.toHaveBeenCalled();
      await fire(1);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      delete (provider as { cacheTtlMs?: unknown }).cacheTtlMs;
    });
  });
});
