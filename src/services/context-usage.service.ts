/**
 * Context-window occupancy tracking (channel-agnostic).
 *
 * Answers "how much of the model's context window is this thread using?" so the
 * clients can show a context-window indicator (% of the window consumed).
 *
 * The numerator comes from the provider, not from an estimate. The AI SDK's
 * `usage.inputTokens` is the full prompt size *including* cached tokens — the
 * Anthropic provider sets it to `input_tokens + cache_creation + cache_read`, and
 * the SDK core flattens that to a single number. So it must NOT have cache
 * read/write added on top; that would double-count, badly, because `invoke.ts`
 * sets four cache breakpoints and cache reads dominate a warm thread.
 *
 * Note the distinction from `InvokeResponse.usage.totalTokens`, which sums every
 * step: each agentic step resends the whole conversation, so that figure is
 * cumulative *billed* spend, not occupancy.
 *
 * Occupancy here is the latest step's prompt **plus that step's output** — i.e.
 * how full the context will be when the next turn starts, since the reply becomes
 * part of the next prompt. Deliberately not the prompt alone: at the moment the
 * number matters most, the reply is exactly what pushed it there. Don't "simplify"
 * this to `inputTokens` to match a narrower reading of the word occupancy; that
 * silently changes the metric.
 *
 * Nothing here knows about WebSockets — snapshots are announced on the `events`
 * emitter and transports subscribe, matching `thread-title.service.ts`.
 */

import { EventEmitter } from 'node:events';
import { buildContextSnapshot, type ContextUsageSnapshot } from '../lib/context-window';
import { conversationService } from './conversation.service';
import { logger } from '../logger';

export type { ContextUsageSnapshot };

/** A thread's occupancy changed — emitted as `'usage'`. */
export interface ContextUsageEvent extends ContextUsageSnapshot {
  userId: string;
}

interface RecordInput {
  /** Carried only so the `usage` event can be routed to that user's clients. */
  userId: string;
  threadId: string;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface TrackedThread {
  snapshot: ContextUsageSnapshot;
}

class ContextUsageService {
  readonly events = new EventEmitter();

  /**
   * Keyed by threadId. Bounded by concurrent in-flight turns (goal runs are
   * already serialized per thread), and each entry is dropped by `finalize`.
   */
  private readonly tracked = new Map<string, TrackedThread>();

  /**
   * Record one step's measurement. Called per `onStepFinish`, so it stays cheap:
   * no I/O, and it only emits when the rounded percentage actually moved —
   * otherwise a 100-step turn would push 100 identical frames.
   *
   * Returns the snapshot, or null when occupancy can't be determined (the
   * provider reported no usage, or the model's window is unknown). A null means
   * *render nothing* — never a reassuring 0% used, which would be a claim we
   * can't back.
   */
  record(input: RecordInput): ContextUsageSnapshot | null {
    if (typeof input.inputTokens !== 'number') return null;

    const usedTokens = input.inputTokens + (input.outputTokens ?? 0);
    const snapshot = buildContextSnapshot(input.threadId, input.modelId, usedTokens);
    if (!snapshot) return null;

    const previous = this.tracked.get(input.threadId);
    this.tracked.set(input.threadId, { snapshot });

    if (previous?.snapshot.usedPercent !== snapshot.usedPercent) {
      this.events.emit('usage', { userId: input.userId, ...snapshot } satisfies ContextUsageEvent);
    }

    return snapshot;
  }

  /**
   * Persist the turn's final measurement. One write per turn rather than per step.
   * Fail-soft: this is a display metric, so a DB error is logged and swallowed
   * rather than surfacing in the user's turn.
   */
  async finalize(input: { threadId: string }): Promise<void> {
    const tracked = this.tracked.get(input.threadId);
    this.tracked.delete(input.threadId);
    if (!tracked) return;

    const { snapshot } = tracked;

    try {
      await conversationService.setThreadContextUsage(
        snapshot.threadId,
        snapshot.usedTokens,
        snapshot.modelId
      );
    } catch (err) {
      logger.error({ err, threadId: snapshot.threadId }, '[ContextUsage] failed to persist snapshot');
    }
  }

  /**
   * Rebuild a snapshot from the columns stored on a thread, for read paths (a
   * page reload or a resumed CLI session). Recomputes the percentage against
   * `contextModel`'s window rather than the agent's current model, so a stale
   * measurement is never reinterpreted against a different window.
   */
  fromStored(
    threadId: string,
    contextTokens: number | null | undefined,
    contextModel: string | null | undefined
  ): ContextUsageSnapshot | null {
    return buildContextSnapshot(threadId, contextModel, contextTokens);
  }

  /** Drop in-flight state for a thread without persisting (e.g. thread deleted). */
  forget(threadId: string): void {
    this.tracked.delete(threadId);
  }

  /**
   * Apply a post-compaction occupancy estimate: emit a usage frame so the
   * clients' meters drop immediately, and persist it as the thread's stored
   * snapshot so a reload shows the same number. The estimate (chars/4 over the
   * rebuilt context) undershoots the real prompt — it ignores the system prompt
   * and tools — and self-corrects on the next turn's provider-reported usage.
   *
   * Deliberately does not touch the per-turn `tracked` map: compaction runs
   * under the thread mutex, so no turn is in flight for this thread and there
   * is no entry to reconcile.
   *
   * Returns null (and does nothing) when the model's window is unknown — never
   * a made-up percent.
   */
  applyEstimate(input: {
    userId: string;
    threadId: string;
    modelId: string;
    usedTokens: number;
  }): ContextUsageSnapshot | null {
    const snapshot = buildContextSnapshot(input.threadId, input.modelId, input.usedTokens);
    if (!snapshot) return null;

    this.events.emit('usage', { userId: input.userId, ...snapshot } satisfies ContextUsageEvent);
    void conversationService
      .setThreadContextUsage(snapshot.threadId, snapshot.usedTokens, snapshot.modelId)
      .catch((err) => {
        logger.error({ err, threadId: snapshot.threadId }, '[ContextUsage] failed to persist estimate');
      });

    return snapshot;
  }
}

export const contextUsageService = new ContextUsageService();
