/**
 * Turn Activity Service
 *
 * Owns which threads have a turn in progress. Each activity has its own
 * `turnId`, so the end of one turn clears only that turn.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { conversationService } from './conversation.service';
import { logger } from '../logger';
import type { InvokeRequest } from '../types';

export interface TurnActivityChange {
  threadId: string;
  turnId: string;
  working: boolean;
}

class TurnActivityService {
  readonly events = new EventEmitter();
  private readonly active = new Map<string, TurnActivityChange>();

  /**
   * The thread a turn shows on, or null when it shows on none.
   *
   * A turn without a thread shows on the user's latest thread, where its result is
   * published. A subagent runs inside a parent turn, which already shows.
   */
  async threadFor(
    request: Pick<InvokeRequest, 'mode' | 'threadId' | 'agentId' | 'userId'>,
  ): Promise<string | null> {
    if (request.mode === 'subagent') return null;
    if (request.threadId) return request.threadId;
    try {
      const latest = await conversationService.findLatestThread(request.agentId, request.userId);
      return latest?.id ?? null;
    } catch (err) {
      logger.warn({ err }, '[TurnActivity] latest-thread lookup failed; the turn shows on no thread');
      return null;
    }
  }

  /** Mark a turn as working on `threadId`. The returned function ends it, once. */
  begin(threadId: string): () => void {
    const turnId = randomUUID();
    const change = { threadId, turnId, working: true };
    this.active.set(turnId, change);
    this.emit(change);
    return () => {
      if (!this.active.delete(turnId)) return;
      this.emit({ threadId, turnId, working: false });
    };
  }

  /** The turns in progress now. */
  activeTurns(): TurnActivityChange[] {
    return [...this.active.values()];
  }

  private emit(change: TurnActivityChange): void {
    this.events.emit('change', change);
  }
}

export const turnActivityService = new TurnActivityService();
