/**
 * Conversation Thread Activity Service
 *
 * Owns which conversation threads are working. A thread is working while at least
 * one invocation runs on it. A bound scheduled task can run on a thread while a
 * chat turn runs there, so each thread holds a count.
 */

import { EventEmitter } from 'node:events';
import { conversationService } from './conversation.service';
import { logger } from '../logger';
import type { InvokeRequest } from '../types';

export interface ThreadActivityChange {
  threadId: string;
  working: boolean;
}

class ConversationThreadActivityService {
  readonly events = new EventEmitter();
  private readonly running = new Map<string, number>();

  /**
   * Mark the request's thread as working. The returned function ends that, once.
   *
   * A request without a thread works on the user's latest web thread, where its
   * result is published. A subagent runs inside a parent invocation, which already
   * marks its thread.
   */
  async begin(
    request: Pick<InvokeRequest, 'mode' | 'threadId' | 'agentId' | 'userId'>,
  ): Promise<() => void> {
    const threadId = await this.threadFor(request);
    if (!threadId) return () => {};
    return this.beginThread(threadId);
  }

  /** Mark a known thread as working. The returned function ends that, once. */
  beginThread(threadId: string): () => void {
    this.add(threadId, 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.add(threadId, -1);
    };
  }

  /** The threads that are working now. */
  workingThreadIds(): string[] {
    return [...this.running.keys()];
  }

  private async threadFor(
    request: Pick<InvokeRequest, 'mode' | 'threadId' | 'agentId' | 'userId'>,
  ): Promise<string | null> {
    if (request.mode === 'subagent') return null;
    if (request.threadId) return request.threadId;
    try {
      const latest = await conversationService.findLatestWebThread(request.agentId, request.userId);
      return latest?.id ?? null;
    } catch (err) {
      logger.warn({ err }, '[ThreadActivity] latest-thread lookup failed; no thread shows as working');
      return null;
    }
  }

  private add(threadId: string, delta: 1 | -1): void {
    const count = (this.running.get(threadId) ?? 0) + delta;
    if (count > 0) this.running.set(threadId, count);
    else this.running.delete(threadId);

    if (count === 1 && delta === 1) this.emit({ threadId, working: true });
    if (count === 0) this.emit({ threadId, working: false });
  }

  private emit(change: ThreadActivityChange): void {
    this.events.emit('change', change);
  }
}

export const conversationThreadActivityService = new ConversationThreadActivityService();
