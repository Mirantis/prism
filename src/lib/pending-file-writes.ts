/**
 * The file writes the model asked for in the current step, so that a tool
 * reading a file can wait for the writes to that same file first.
 *
 * Why this exists. `share_file` reads the file when it runs. The model routinely
 * issues the write and the share in one assistant message, and the SDK executes
 * a step's tool calls concurrently (`Promise.all`), so the read can win the race
 * and capture the file as it was *before* the edit. The attachment then holds
 * stale bytes while the reply describes the new ones — indistinguishable to the
 * reader, and the bytes are copied eagerly into the media store, so nothing
 * downstream can repair it.
 *
 * Why it can work. The AI SDK's `generateText` step loop announces **every** tool
 * call in the step — awaiting each tool's `onInputAvailable` in turn — and only
 * then calls `executeTools`. So by the time any tool in a step begins executing,
 * every write in that step has already registered here. That ordering is the
 * whole mechanism; it is a property of the `generateText` path specifically (on
 * the `streamText` path announce and execute interleave per call, which would
 * break it — `invoke.ts` uses `generateText` only).
 *
 * A write whose target is unknown registers with no path and holds every reader
 * in the step: `shell_exec` can change any file, and nothing can tell which.
 *
 * Waiting is free. The step already joins on every tool promise before the next
 * model call, so a reader finishing last within its own step delays nothing.
 *
 * Scope is one step: `invoke.ts` clears the registry at each step boundary
 * (`prepareStep`), which runs after the previous step's tools have all settled
 * and before the next step's calls exist. No timestamps, no cross-step leakage.
 */

import { logger } from '../logger';

export type PendingWaitOutcome =
  | { status: 'none' }
  | { status: 'settled'; toolNames: string[]; elapsedMs: number }
  | { status: 'timeout' | 'aborted' | 'cleared'; toolNames: string[]; elapsedMs: number };

export interface PendingFileWrites {
  /**
   * Record a write the model has asked for, to `fullPath` or, without one, to any
   * file. With `outsideCallersOnly` it holds only callers outside every program:
   * `run_program` registers so, because the calls inside a program register their
   * own writes, and two programs that each wait on the other would never end. Called from a write tool's `onInputAvailable`, which the SDK runs for
   * every call in the step before any of them executes — registering from
   * `execute` instead would defeat the point, since concurrent siblings have no
   * ordering between them.
   */
  register(
    toolCallId: string | undefined,
    toolName: string,
    fullPath?: string,
    options?: { outsideCallersOnly?: boolean },
  ): void;
  /** Release a registered write. Called from the write tool's `execute` finally. */
  settle(toolCallId: string | undefined): void;
  /**
   * Record a non-write call, so `wasAnnounced` can answer for it. This is the
   * canary: a reader that finds its own id unannounced knows the hook did not run
   * and must not read an empty registry as "no pending writes".
   */
  announce(toolCallId: string | undefined, toolName: string): void;
  /** Whether this call id passed through `onInputAvailable`. */
  wasAnnounced(toolCallId: string | undefined): boolean;
  /**
   * Wait for the unsettled writes that can change `fullPath`: the ones to that
   * exact string, and the ones with no path. A call made inside another call has
   * the id `<outer id>:<n>` (`run_program`), and does not wait for the call it is
   * part of, which cannot end before it does, nor for a write registered with
   * `outsideCallersOnly`.
   */
  waitFor(
    fullPath: string,
    options: { timeoutMs: number; abortSignal?: AbortSignal; callerId?: string },
  ): Promise<PendingWaitOutcome>;
  /**
   * Drop everything. Releases outstanding waiters first so none of them hang —
   * as `'cleared'` rather than `'settled'`, because a write abandoned at a step
   * boundary is precisely the case where nobody knows what is on disk.
   */
  clear(): void;
}

interface PendingWrite {
  toolName: string;
  /** Undefined when the write can change any file. */
  fullPath?: string;
  /** Held only by callers outside every program. */
  outsideCallersOnly: boolean;
  done: Promise<'settled' | 'cleared'>;
  resolve: (how: 'settled' | 'cleared') => void;
}

export function createPendingFileWrites(): PendingFileWrites {
  const writes = new Map<string, PendingWrite>();
  const announced = new Set<string>();

  return {
    register(toolCallId, toolName, fullPath, options) {
      if (!toolCallId) return;
      announced.add(toolCallId);
      // A duplicate id would mean the SDK announced one call twice; keep the
      // first deferred so an existing waiter still has something to await.
      if (writes.has(toolCallId)) return;
      let resolve!: (how: 'settled' | 'cleared') => void;
      const done = new Promise<'settled' | 'cleared'>((r) => {
        resolve = r;
      });
      writes.set(toolCallId, {
        toolName,
        fullPath,
        outsideCallersOnly: options?.outsideCallersOnly ?? false,
        done,
        resolve,
      });
    },

    settle(toolCallId) {
      if (!toolCallId) return;
      const entry = writes.get(toolCallId);
      if (!entry) return;
      writes.delete(toolCallId);
      entry.resolve('settled');
    },

    announce(toolCallId, _toolName) {
      if (!toolCallId) return;
      announced.add(toolCallId);
    },

    wasAnnounced(toolCallId) {
      return toolCallId ? announced.has(toolCallId) : false;
    },

    async waitFor(fullPath, options) {
      const { callerId } = options;
      const insideProgram = callerId?.includes(':') ?? false;
      const matching = [...writes.entries()]
        .filter(([id, w]) => !callerId?.startsWith(`${id}:`) && !(insideProgram && w.outsideCallersOnly))
        .map(([, w]) => w)
        .filter((w) => w.fullPath === undefined || w.fullPath === fullPath);
      if (matching.length === 0) return { status: 'none' };

      const toolNames = matching.map((w) => w.toolName);
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const { abortSignal } = options;

      try {
        const outcome = await Promise.race<'settled' | 'timeout' | 'aborted' | 'cleared'>([
          // Any entry released by `clear()` poisons the whole wait: one abandoned
          // write is enough to make the file's contents unknown.
          Promise.all(matching.map((w) => w.done)).then((hows) =>
            hows.includes('cleared') ? ('cleared' as const) : ('settled' as const),
          ),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
          }),
          new Promise<'aborted'>((resolve) => {
            if (!abortSignal) return;
            if (abortSignal.aborted) {
              resolve('aborted');
              return;
            }
            onAbort = () => resolve('aborted');
            abortSignal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
        return { status: outcome, toolNames, elapsedMs: Date.now() - started };
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort && abortSignal) abortSignal.removeEventListener('abort', onAbort);
      }
    },

    clear() {
      if (writes.size > 0) {
        // A write still registered at a step boundary never reached its own
        // `finally` — it threw somewhere above the handler, or the SDK contract
        // changed. Resolve it so nothing awaits a promise no one will settle.
        logger.warn(
          { pendingWrites: [...writes.values()].map((w) => w.toolName) },
          'pending file writes left unsettled at step boundary',
        );
        for (const entry of writes.values()) entry.resolve('cleared');
      }
      writes.clear();
      announced.clear();
    },
  };
}
