/**
 * What the agent spent on models, read from the estimated cost on each `llm_calls`
 * row: in a time range, per calendar period, per thread, per request and per
 * scheduled task, webhook or goal.
 *
 * A cost is an estimate from catalog prices. A call whose model has no price is
 * counted in `unpricedCalls` and adds nothing to `costUsd`, so a total with
 * unpriced calls is a lower bound.
 */

import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../config';
import { wallClock, zonedInstant } from '../lib/zoned-time';
import type { SpendSourceKind } from '../lib/spend-context';
import { spendKindOf, type SpendKind } from './llm-call.service';
import { isWebThread } from './web-thread';

export interface SpendTotals {
  costUsd: number;
  calls: number;
  /** Calls with no price, which `costUsd` leaves out. */
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Where spend went, in the words a person uses for it. */
export type SpendCategory =
  | 'conversations'
  | 'coding-agent'
  | 'voice'
  | 'heartbeat'
  | 'scheduled-tasks'
  | 'webhooks'
  | 'goals'
  | 'background';

/** The categories whose spend is listed per scheduled task, webhook or goal. */
export const SOURCED_CATEGORIES = ['scheduled-tasks', 'webhooks', 'goals'] as const;
export type SourcedCategory = (typeof SOURCED_CATEGORIES)[number];

export interface SpendBreakdown extends SpendTotals {
  byKind: Array<SpendTotals & { kind: SpendKind }>;
  byCategory: Array<SpendTotals & { category: SpendCategory }>;
  byModel: Array<SpendTotals & { model: string }>;
  byPurpose: Array<SpendTotals & { purpose: string }>;
}

export interface SpendRange {
  from: Date;
  to: Date;
}

export type SpendPeriod = 'day' | 'week' | 'month';

export interface PeriodSpend extends SpendTotals {
  /** The period's first local date, `YYYY-MM-DD`. */
  start: string;
  from: string;
  to: string;
  /** `costUsd` split by kind. */
  costUsdByKind: Record<SpendKind, number>;
}

export interface ThreadSpend extends SpendTotals {
  threadId: string;
  title: string | null;
  /** The requests spent in the thread: the messages answered and the runs made in it. */
  requests: number;
  firstCallAt: string;
  lastCallAt: string;
}

/** What a request in a thread was: a message a person or an agent sent, a task's result, or a run. */
export type RequestKind = 'message' | 'agent-message' | 'task-result' | SpendSourceKind | 'other';

export interface RequestSpend extends SpendTotals {
  requestId: string;
  kind: RequestKind;
  /** The start of the message the request answers, for a message alone. */
  preview: string | null;
  firstCallAt: string;
}

export interface SourceSpend extends SpendTotals {
  /** Null for the spend recorded before runs named their source. */
  sourceId: string | null;
  /** The task's, webhook's or goal's name; null when it was deleted or is unknown. */
  name: string | null;
}

const PREVIEW_CHARS = 120;

/** The sums one `groupBy` row has, which every read adds up the same way. */
interface GroupSums {
  _count: { _all: number; costMicroUsd: number };
  _sum: {
    costMicroUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  };
}

const SUMS = {
  _count: { _all: true, costMicroUsd: true },
  _sum: { costMicroUsd: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
} as const;

/** Running totals in micro-dollars, converted once at the end so rounding never accumulates. */
interface Accumulator {
  costMicroUsd: number;
  calls: number;
  pricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function emptyAccumulator(): Accumulator {
  return { costMicroUsd: 0, calls: 0, pricedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function add(acc: Accumulator, row: GroupSums): void {
  acc.costMicroUsd += row._sum.costMicroUsd ?? 0;
  acc.calls += row._count._all;
  acc.pricedCalls += row._count.costMicroUsd;
  acc.inputTokens += row._sum.inputTokens ?? 0;
  acc.outputTokens += row._sum.outputTokens ?? 0;
  acc.cacheReadTokens += row._sum.cacheReadTokens ?? 0;
  acc.cacheWriteTokens += row._sum.cacheWriteTokens ?? 0;
}

function usd(microUsd: number): number {
  return microUsd / 1_000_000;
}

function totalsOf(acc: Accumulator): SpendTotals {
  return {
    costUsd: usd(acc.costMicroUsd),
    calls: acc.calls,
    unpricedCalls: acc.calls - acc.pricedCalls,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
  };
}

function totalsOfRow(row: GroupSums): SpendTotals {
  const acc = emptyAccumulator();
  add(acc, row);
  return totalsOf(acc);
}

/** One entry per key, most spent first. */
function ranked<K extends string, V extends string>(groups: Map<V, Accumulator>, key: K): Array<SpendTotals & Record<K, V>> {
  return [...groups.entries()]
    .sort(([, a], [, b]) => b.costMicroUsd - a.costMicroUsd || b.calls - a.calls)
    .map(([value, acc]) => ({ [key]: value, ...totalsOf(acc) }) as SpendTotals & Record<K, V>);
}

function addTo<V>(groups: Map<V, Accumulator>, value: V, row: GroupSums): void {
  const acc = groups.get(value) ?? emptyAccumulator();
  add(acc, row);
  groups.set(value, acc);
}

const CATEGORY_OF_SOURCE: Record<SpendSourceKind, SpendCategory> = {
  chat: 'conversations',
  heartbeat: 'heartbeat',
  cron: 'scheduled-tasks',
  webhook: 'webhooks',
  goal: 'goals',
  'voice-chat': 'voice',
  meeting: 'voice',
  dictation: 'voice',
};

/** The invoke modes a call recorded before sources were stored names as its purpose. */
const SOURCE_OF_PURPOSE: Record<string, SpendSourceKind> = {
  chat: 'chat',
  heartbeat: 'heartbeat',
  cron: 'cron',
  webhook: 'webhook',
  goal: 'goal',
};

/**
 * A call's category. The coding agent's and the voice models' own calls are their
 * kind; any other call is the category of what started its request, and a call
 * that no request started (a thread title, an idle compaction) is background work.
 */
export function categoryOf(purpose: string, sourceKind: string | null): SpendCategory {
  const kind = spendKindOf(purpose);
  if (kind !== 'main') return kind;
  const source = (sourceKind as SpendSourceKind | null) ?? SOURCE_OF_PURPOSE[purpose];
  return source ? (CATEGORY_OF_SOURCE[source] ?? 'background') : 'background';
}

/** The agent's own rows. Subagent work is recorded against the owner. */
function owned(where: Prisma.LlmCallWhereInput): Prisma.LlmCallWhereInput {
  return { agentId: config.agentId ?? '', ...where };
}

/** A local calendar date, as `Date.UTC` reads it: out-of-range days and months roll over. */
interface LocalDate {
  year: number;
  month: number;
  day: number;
}

function normalized(date: LocalDate): LocalDate {
  const at = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

function label(date: LocalDate): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** The first day of the period that holds `date`. A week starts on Monday. */
function periodStart(period: SpendPeriod, date: LocalDate): LocalDate {
  if (period === 'month') return { year: date.year, month: date.month, day: 1 };
  if (period === 'day') return date;
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return normalized({ ...date, day: date.day - ((weekday + 6) % 7) });
}

/** The period `steps` periods after the one that starts on `start`. */
function shifted(period: SpendPeriod, start: LocalDate, steps: number): LocalDate {
  if (period === 'month') return normalized({ year: start.year, month: start.month + steps, day: 1 });
  return normalized({ ...start, day: start.day + steps * (period === 'week' ? 7 : 1) });
}

function startInstant(date: LocalDate, timeZone: string): Date {
  return zonedInstant(date.year, date.month, date.day, 0, 0, timeZone);
}

function previewOf(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/** What a request was, from the message it answers or, for a run, what started it. */
function requestKind(message: { triggeredBy: string } | undefined, sourceKind: string | null): RequestKind {
  if (message?.triggeredBy === 'TASK_NOTIFICATION') return 'task-result';
  if (message?.triggeredBy === 'AGENT_MESSAGE') return 'agent-message';
  if (message) return 'message';
  return (sourceKind as SpendSourceKind | null) ?? 'other';
}

class SpendingService {
  /** Totals for `range`, by kind, category, model and purpose. */
  async summary(range: SpendRange): Promise<SpendBreakdown> {
    return this.breakdown({ createdAt: { gte: range.from, lt: range.to } });
  }

  /**
   * The last `count` periods in `timeZone`, the current one included, oldest first.
   * A period with no calls is listed with zeros.
   */
  async periods(period: SpendPeriod, count: number, timeZone: string, now = Date.now()): Promise<PeriodSpend[]> {
    const current = periodStart(period, wallClock(now, timeZone));
    const starts = Array.from({ length: count + 1 }, (_, i) => shifted(period, current, i - count + 1));
    const bounds = starts.map((start) => startInstant(start, timeZone).getTime());

    const rows = await prisma.llmCall.groupBy({
      by: ['bucket', 'purpose'],
      where: owned({ bucket: { gte: new Date(bounds[0]), lt: new Date(bounds[count]) } }),
      ...SUMS,
    });

    // A period starts at a local midnight, which is a whole 15-minute bucket in every zone.
    const accumulators = Array.from({ length: count }, emptyAccumulator);
    const byKind = Array.from({ length: count }, () => ({ main: 0, 'coding-agent': 0, voice: 0 }) as Record<SpendKind, number>);
    for (const row of rows) {
      const at = row.bucket.getTime();
      const index = bounds.findIndex((bound, i) => i < count && at >= bound && at < bounds[i + 1]);
      add(accumulators[index], row);
      byKind[index][spendKindOf(row.purpose)] += row._sum.costMicroUsd ?? 0;
    }

    return accumulators.map((acc, i) => ({
      start: label(starts[i]),
      from: new Date(bounds[i]).toISOString(),
      to: new Date(bounds[i + 1]).toISOString(),
      ...totalsOf(acc),
      costUsdByKind: {
        main: usd(byKind[i].main),
        'coding-agent': usd(byKind[i]['coding-agent']),
        voice: usd(byKind[i].voice),
      },
    }));
  }

  /** Threads with calls in `range`, most spent first, `limit` from `offset`. */
  async threads(range: SpendRange, limit: number, offset: number): Promise<{ threads: ThreadSpend[]; nextOffset: number | null }> {
    const inRange = { createdAt: { gte: range.from, lt: range.to } };
    const rows = await prisma.llmCall.groupBy({
      by: ['threadId'],
      where: owned({ threadId: { not: null }, ...inRange }),
      ...SUMS,
      _min: { createdAt: true },
      _max: { createdAt: true },
      orderBy: [{ _sum: { costMicroUsd: 'desc' } }, { threadId: 'asc' }],
      skip: offset,
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.threadId!);

    const [threads, requests] = await Promise.all([
      prisma.conversationThread.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }),
      // Prisma counts no distinct values, so the page's requests are grouped and counted here.
      prisma.llmCall.groupBy({
        by: ['threadId', 'requestId'],
        where: owned({ threadId: { in: ids }, requestId: { not: null }, ...inRange }),
      }),
    ]);
    const titles = new Map(threads.map((thread) => [thread.id, thread.title]));
    const requestCounts = new Map<string, number>();
    for (const row of requests) requestCounts.set(row.threadId!, (requestCounts.get(row.threadId!) ?? 0) + 1);

    return {
      threads: page.map((row) => ({
        threadId: row.threadId!,
        title: titles.get(row.threadId!) ?? null,
        requests: requestCounts.get(row.threadId!) ?? 0,
        firstCallAt: row._min.createdAt!.toISOString(),
        lastCallAt: row._max.createdAt!.toISOString(),
        ...totalsOfRow(row),
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }

  /**
   * One thread's totals and its requests, newest first, or null for a thread with no calls.
   * `opensInChat` is true for a web thread, which web chat opens by its id.
   */
  async thread(
    threadId: string,
  ): Promise<(SpendBreakdown & { threadId: string; title: string | null; opensInChat: boolean; requests: RequestSpend[] }) | null> {
    const breakdown = await this.breakdown({ threadId });
    if (breakdown.calls === 0) return null;

    const [requestRows, thread] = await Promise.all([
      prisma.llmCall.groupBy({
        by: ['requestId'],
        where: owned({ threadId, requestId: { not: null } }),
        ...SUMS,
        _min: { createdAt: true, sourceKind: true },
        orderBy: { _min: { createdAt: 'desc' } },
      }),
      prisma.conversationThread.findUnique({ where: { id: threadId }, select: { title: true, threadSource: true, externalThreadId: true } }),
    ]);
    const messages = new Map(
      (
        await prisma.conversationMessage.findMany({
          where: { id: { in: requestRows.map((row) => row.requestId!) }, threadId },
          select: { id: true, content: true, triggeredBy: true },
        })
      ).map((message) => [message.id, message]),
    );

    return {
      threadId,
      title: thread?.title ?? null,
      opensInChat: thread ? isWebThread(thread) : false,
      ...breakdown,
      requests: requestRows.map((row) => {
        const message = messages.get(row.requestId!);
        const kind = requestKind(message, row._min.sourceKind);
        return {
          requestId: row.requestId!,
          kind,
          preview: message && kind !== 'task-result' ? previewOf(message.content) : null,
          firstCallAt: row._min.createdAt!.toISOString(),
          ...totalsOfRow(row),
        };
      }),
    };
  }

  /** One request's totals, or null for a request with no calls. */
  async request(requestId: string): Promise<(SpendBreakdown & { requestId: string; threadId: string | null }) | null> {
    const breakdown = await this.breakdown({ requestId });
    if (breakdown.calls === 0) return null;
    const first = await prisma.llmCall.findFirst({
      where: owned({ requestId, threadId: { not: null } }),
      select: { threadId: true },
    });
    return { requestId, threadId: first?.threadId ?? null, ...breakdown };
  }

  /** A category's spend in `range` per scheduled task, webhook or goal, most spent first. */
  async sources(category: SourcedCategory, range: SpendRange): Promise<SourceSpend[]> {
    const rows = await prisma.llmCall.groupBy({
      by: ['purpose', 'sourceKind', 'sourceId'],
      where: owned({ createdAt: { gte: range.from, lt: range.to } }),
      ...SUMS,
    });
    const groups = new Map<string | null, Accumulator>();
    for (const row of rows) {
      if (categoryOf(row.purpose, row.sourceKind) === category) addTo(groups, row.sourceId, row);
    }
    const names = await this.sourceNames(category, [...groups.keys()].filter((id): id is string => id !== null));

    return [...groups.entries()]
      .sort(([, a], [, b]) => b.costMicroUsd - a.costMicroUsd || b.calls - a.calls)
      .map(([sourceId, acc]) => ({ sourceId, name: sourceId ? (names.get(sourceId) ?? null) : null, ...totalsOf(acc) }));
  }

  private async sourceNames(category: SourcedCategory, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const where = { id: { in: ids } };
    if (category === 'scheduled-tasks') {
      return new Map((await prisma.cronTask.findMany({ where, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    }
    if (category === 'webhooks') {
      return new Map((await prisma.webhookSubscription.findMany({ where, select: { id: true, name: true } })).map((w) => [w.id, w.name]));
    }
    return new Map((await prisma.goal.findMany({ where, select: { id: true, objective: true } })).map((g) => [g.id, previewOf(g.objective)]));
  }

  private async breakdown(where: Prisma.LlmCallWhereInput): Promise<SpendBreakdown> {
    const rows = await prisma.llmCall.groupBy({ by: ['purpose', 'model', 'sourceKind'], where: owned(where), ...SUMS });

    const total = emptyAccumulator();
    const byKind = new Map<SpendKind, Accumulator>();
    const byCategory = new Map<SpendCategory, Accumulator>();
    const byModel = new Map<string, Accumulator>();
    const byPurpose = new Map<string, Accumulator>();
    for (const row of rows) {
      add(total, row);
      addTo(byKind, spendKindOf(row.purpose), row);
      addTo(byCategory, categoryOf(row.purpose, row.sourceKind), row);
      addTo(byModel, row.model, row);
      addTo(byPurpose, row.purpose, row);
    }

    return {
      ...totalsOf(total),
      byKind: ranked(byKind, 'kind'),
      byCategory: ranked(byCategory, 'category'),
      byModel: ranked(byModel, 'model'),
      byPurpose: ranked(byPurpose, 'purpose'),
    };
  }
}

export const spendingService = new SpendingService();
