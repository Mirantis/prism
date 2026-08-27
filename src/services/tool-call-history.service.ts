/**
 * The tool calls the agent has stored, paged newest first.
 *
 * Paging is over *message rows* rather than over tool calls, because the calls
 * live inside a JSON array: one row can hold anything from a single call to a
 * hundred. A cursor therefore names a row and a position inside that row's
 * array, and a page is assembled by walking rows newest-first until it holds
 * enough calls.
 */

import prisma from '../lib/prisma';
import { config } from '../config';
import type { MessageTrigger } from './message-delivery.service';
import type { ToolCallRecord } from '../types';

/**
 * Message rows read per batch while filling one page. Each row carries its whole
 * `toolCalls` array, and a call's stored output is the model-facing view capped
 * by `lib/tool-output-limiter.ts`, so a batch is bounded at roughly that cap
 * times the calls in a turn.
 */
const ROW_BATCH = 25;

/** Bound on batches per page, so a long run of call-less rows cannot spin. */
const MAX_ROW_BATCHES = 20;

/** Per-call display caps, applied to what a page serves. */
const MAX_INPUT_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 10_000;

/**
 * Rows belonging to the agent this runtime owns. A subagent is its own
 * `AgentWorkspace` row in the same database, and the thread carries the owner.
 */
function ownedByThisAgent(owner: string) {
  return { role: 'AGENT' as const, thread: { agentId: owner } };
}

/** Cut `text` to `max`, saying so in place. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… truncated for this view: ${max.toLocaleString()} of ${text.length.toLocaleString()} characters`;
}

export interface ToolCallHistoryEntry extends ToolCallRecord {
  /** Stable per-call id: the row plus the position inside its stored array. */
  id: string;
  messageId: string;
  threadId: string;
  threadTitle: string | null;
  triggeredBy: MessageTrigger;
}

export interface ToolCallHistoryPage {
  items: ToolCallHistoryEntry[];
  /** Cursor for the next page, or null at the end of history. */
  nextCursor: string | null;
}

/** `<messageId>:<indexInStoredArray>` — opaque to the client. */
interface Position {
  messageId: string;
  index: number;
}

function parseCursor(raw: string | undefined): Position | null {
  if (!raw) return null;

  const at = raw.lastIndexOf(':');
  if (at <= 0) return null;

  const index = Number.parseInt(raw.slice(at + 1), 10);
  if (!Number.isInteger(index) || index < 0) return null;

  return { messageId: raw.slice(0, at), index };
}

/**
 * One row's stored tool calls, newest first.
 *
 * Parsed defensively, as `parseToolCalls` in `prompts/context-builder.ts` does:
 * the column is JSON, so an entry's shape is a convention rather than a
 * constraint. The stored array is in step order, so walking it backwards puts
 * the row's latest call first.
 *
 * `index` is the position in the *stored* array, not in this reversed view, so
 * a cursor built from it stays valid however the page is read.
 */
function readToolCalls(stored: unknown): Array<{ index: number; call: ToolCallRecord }> {
  if (!Array.isArray(stored)) return [];

  const calls: Array<{ index: number; call: ToolCallRecord }> = [];

  for (let i = stored.length - 1; i >= 0; i--) {
    const entry = stored[i] as Record<string, unknown> | null | undefined;
    if (!entry || typeof entry.tool !== 'string' || !entry.tool) continue;

    calls.push({
      index: i,
      call: {
        tool: entry.tool,
        input: typeof entry.input === 'string' ? cap(entry.input, MAX_INPUT_CHARS) : '',
        output: typeof entry.output === 'string' ? cap(entry.output, MAX_OUTPUT_CHARS) : '',
        success: entry.success === true,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
      },
    });
  }

  return calls;
}

const ROW_SELECT = {
  id: true,
  threadId: true,
  triggeredBy: true,
  toolCalls: true,
  createdAt: true,
  thread: { select: { title: true } },
} as const;

type ToolCallRow = {
  id: string;
  threadId: string;
  triggeredBy: string;
  toolCalls: unknown;
  createdAt: Date;
  thread: { title: string | null } | null;
};

class ToolCallHistoryService {
  /**
   * One page of tool calls across every thread and trigger.
   *
   * Ordered by the turn that produced them, newest turn first, then by
   * position within a turn, so two turns running at once can interleave.
   * Ordering on each call's own timestamp needs the calls in their own table.
   *
   * Two phases, because one row can hold more calls than fit on a page: resume
   * inside the cursor's row first, then walk strictly older rows.
   */
  async page(limit: number, rawCursor?: string): Promise<ToolCallHistoryPage> {
    // An unset id would filter on nothing in Prisma and return every agent's
    // calls, so it answers empty, as the usage read does.
    const owner = config.agentId;
    if (!owner) return { items: [], nextCursor: null };

    const cursor = parseCursor(rawCursor);
    const items: ToolCallHistoryEntry[] = [];
    // Parallel to `items`: the stored-array position each one came from, so the
    // next cursor is read off the last call emitted rather than parsed back out
    // of its id.
    const positions: Position[] = [];

    const emit = (row: ToolCallRow, index: number, call: ToolCallRecord): void => {
      items.push({
        ...call,
        id: `${row.id}-tc-${index}`,
        messageId: row.id,
        threadId: row.threadId,
        threadTitle: row.thread?.title ?? null,
        triggeredBy: row.triggeredBy as MessageTrigger,
      });
      positions.push({ messageId: row.id, index });
    };

    // Where the older-rows walk resumes, and the oldest row it has reached.
    let after: { createdAt: Date; id: string } | null = null;
    let lastRowId: string | null = null;
    let exhausted = false;

    if (cursor) {
      // findFirst rather than findUnique: the row has to belong to this agent,
      // and only findFirst takes a relation filter alongside the id.
      const row = await prisma.conversationMessage.findFirst({
        where: { ...ownedByThisAgent(owner), id: cursor.messageId },
        select: ROW_SELECT,
      });

      // The cursor's row is gone — its thread was deleted while the client was
      // scrolling. End the list; a reload starts from a history that exists.
      if (!row) return { items: [], nextCursor: null };

      for (const { index, call } of readToolCalls(row.toolCalls)) {
        // Positions descend, so anything at or above the cursor's index has
        // already been sent.
        if (index >= cursor.index) continue;
        if (items.length === limit) break;
        emit(row, index, call);
      }

      after = { createdAt: row.createdAt, id: row.id };
      lastRowId = row.id;
    }

    for (let batch = 0; batch < MAX_ROW_BATCHES && items.length < limit; batch++) {
      const rows: ToolCallRow[] = await prisma.conversationMessage.findMany({
        where: {
          ...ownedByThisAgent(owner),
          // Strictly older than the last row read, compared on (createdAt, id)
          // because createdAt alone is not unique — two rows written in the same
          // millisecond would otherwise repeat or go missing.
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: ROW_BATCH,
        select: ROW_SELECT,
      });

      // A short batch is the end of history, an empty one included — that is
      // what a cursor on the oldest row reads. Set before the break, so the
      // cursor goes null and the client stops asking.
      if (rows.length < ROW_BATCH) exhausted = true;
      if (rows.length === 0) break;

      for (const row of rows) {
        if (items.length === limit) break;

        after = { createdAt: row.createdAt, id: row.id };
        lastRowId = row.id;

        for (const { index, call } of readToolCalls(row.toolCalls)) {
          if (items.length === limit) break;
          emit(row, index, call);
        }
      }

      if (exhausted) break;
    }

    return {
      items,
      nextCursor: this.nextCursor({
        filled: items.length === limit,
        exhausted,
        positions,
        lastRowId,
      }),
    };
  }

  /**
   * Where the next page resumes, or null once history is spent.
   *
   * A page that filled gets a cursor naming the last call emitted, since the
   * page may have stopped part-way through a row; the cost is one empty page
   * when the limit lands on a row's last call. A page that did not fill ran out
   * of rows or of batches. Out of rows ends the list. Out of batches resumes at
   * the last row read, index 0.
   */
  private nextCursor(state: {
    filled: boolean;
    exhausted: boolean;
    positions: Position[];
    lastRowId: string | null;
  }): string | null {
    const last = state.positions[state.positions.length - 1];

    if (state.filled && last) return `${last.messageId}:${last.index}`;
    if (state.exhausted) return null;

    return state.lastRowId ? `${state.lastRowId}:0` : null;
  }
}

export const toolCallHistoryService = new ToolCallHistoryService();
