/**
 * The record of each webhook event the runtime accepted, read by the Activity
 * page.
 *
 * An agent run is written as `queued` when the receiver accepts it, moves to
 * `running` when its turn in the subscription's queue comes, and is finished
 * with its result. A deliver-only event is written as `running` before its
 * publish and finished as `delivered` or `failed`.
 */

import prisma from '../lib/prisma';
import { config } from '../config';
import { logger } from '../logger';
import { readToolCalls } from './tool-call-history.service';
import type { ToolCallRecord } from '../types';

export const WEBHOOK_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'budget_exceeded',
  'delivered',
  'suppressed',
] as const;
export type WebhookRunStatus = (typeof WEBHOOK_RUN_STATUSES)[number];

/** A run in these states still has a worker that will write to its row. */
const UNFINISHED: WebhookRunStatus[] = ['queued', 'running'];

/** How a run ended. */
export interface WebhookRunResult {
  status: 'completed' | 'failed' | 'budget_exceeded' | 'delivered' | 'suppressed';
  error?: string | null;
  /** The message the run delivered; absent when the delivery itself failed. */
  messageId?: string | null;
}

/**
 * Finished rows kept per agent. Unfinished rows are never trimmed, and are
 * bounded by the subscriptions' queues. A constant, not a setting.
 */
export const MAX_WEBHOOK_RUNS = 1000;

/** Cap on the stored error. The delivered message holds the whole notice. */
const ERROR_MAX_CHARS = 2000;

export const INTERRUPTED_ERROR = 'The runtime restarted before the run finished.';

export interface WebhookRunSummary {
  id: string;
  name: string;
  event: string;
  status: WebhookRunStatus;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** The message the run delivered, if it delivered one. */
  message: {
    id: string;
    threadId: string;
    threadTitle: string | null;
    /** The thread is a web conversation, not a channel destination's own thread. */
    inWebChat: boolean;
  } | null;
}

export interface WebhookRunDetail extends WebhookRunSummary {
  /** What the delivered message said and the tool calls it stored, in step order. */
  delivered: { content: string; toolCalls: ToolCallRecord[] } | null;
}

export interface WebhookRunPage {
  items: WebhookRunSummary[];
  nextCursor: string | null;
}

interface AcceptedEvent {
  /** The runId the receiver answered with. */
  id: string;
  agentId: string;
  name: string;
  event: string;
}

const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

const SUMMARY_SELECT = {
  id: true,
  name: true,
  event: true,
  status: true,
  error: true,
  createdAt: true,
  finishedAt: true,
  message: {
    select: { id: true, threadId: true, thread: { select: { title: true, externalThreadId: true } } },
  },
} as const;

type SummaryRow = {
  id: string;
  name: string;
  event: string;
  status: string;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  message: {
    id: string;
    threadId: string;
    thread: { title: string | null; externalThreadId: string | null };
  } | null;
};

function toSummary(row: SummaryRow): WebhookRunSummary {
  return {
    id: row.id,
    name: row.name,
    event: row.event,
    status: row.status as WebhookRunStatus,
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    message: row.message
      ? {
          id: row.message.id,
          threadId: row.message.threadId,
          threadTitle: row.message.thread.title,
          inWebChat: row.message.thread.externalThreadId === null,
        }
      : null,
  };
}

function capError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error.length <= ERROR_MAX_CHARS ? error : `${error.slice(0, ERROR_MAX_CHARS)}…`;
}

/**
 * `accept` is on the request's path and throws, so an event that cannot be
 * recorded answers 500 before anything runs or is sent. `start` and `finish`
 * follow a run already under way: a failed write is logged and never changes
 * what the run does or what the sender is told.
 */
class WebhookRunService {
  /**
   * An event the receiver accepted: `queued` for an agent run waiting in its
   * subscription's queue, `running` for a deliver-only publish.
   */
  async accept(event: AcceptedEvent, status: 'queued' | 'running'): Promise<void> {
    await this.insert({ ...event, status });
  }

  async start(id: string): Promise<void> {
    try {
      await prisma.webhookRun.update({ where: { id }, data: { status: 'running' } });
    } catch (error: unknown) {
      logger.error({ err: error, runId: id }, '[WebhookRun] Could not mark the run running');
    }
  }

  async finish(id: string, result: WebhookRunResult): Promise<void> {
    try {
      await prisma.webhookRun.update({
        where: { id },
        data: {
          status: result.status,
          error: capError(result.error),
          messageId: result.messageId ?? null,
          finishedAt: new Date(),
        },
      });
    } catch (error: unknown) {
      logger.error(
        { err: error, runId: id, status: result.status },
        '[WebhookRun] Could not record how the run ended',
      );
    }
  }

  /**
   * Runs live in this process's queue, so a run still queued or running at boot
   * was cut off by the restart. Returns how many were.
   */
  async failInterrupted(agentId: string): Promise<number> {
    const { count } = await prisma.webhookRun.updateMany({
      where: { agentId, status: { in: UNFINISHED } },
      data: { status: 'failed', error: INTERRUPTED_ERROR, finishedAt: new Date() },
    });
    return count;
  }

  /** One page of runs, newest first. */
  async page(limit: number, cursor?: string): Promise<WebhookRunPage> {
    // An unset id would filter on nothing and return every agent's runs.
    const owner = config.agentId;
    if (!owner) return { items: [], nextCursor: null };

    // A cursor row trimmed since the last page reads as the end.
    const rows: SummaryRow[] = await prisma.webhookRun.findMany({
      where: { agentId: owner },
      orderBy: NEWEST_FIRST,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: SUMMARY_SELECT,
    });

    const items = rows.slice(0, limit).map(toSummary);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
  }

  /** One run with what it delivered, or null when this agent has no such run. */
  async get(id: string): Promise<WebhookRunDetail | null> {
    const owner = config.agentId;
    if (!owner) return null;

    const row = await prisma.webhookRun.findFirst({
      where: { id, agentId: owner },
      select: {
        ...SUMMARY_SELECT,
        message: { select: { ...SUMMARY_SELECT.message.select, content: true, toolCalls: true } },
      },
    });
    if (!row) return null;

    return {
      ...toSummary(row),
      delivered: row.message
        ? {
            content: row.message.content,
            toolCalls: readToolCalls(row.message.toolCalls)
              .reverse()
              .map(({ call }) => call),
          }
        : null,
    };
  }

  /** Writes the row and trims the oldest finished rows beyond the bound, in one transaction. */
  private async insert(data: AcceptedEvent & { status: WebhookRunStatus }): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.webhookRun.create({ data });

      const overBound = await tx.webhookRun.findMany({
        where: { agentId: data.agentId, status: { notIn: UNFINISHED } },
        orderBy: NEWEST_FIRST,
        skip: MAX_WEBHOOK_RUNS,
        select: { id: true },
      });
      if (overBound.length === 0) return;

      await tx.webhookRun.deleteMany({ where: { id: { in: overBound.map((row) => row.id) } } });
    });
  }
}

export const webhookRunService = new WebhookRunService();
