/**
 * Conversation Service
 *
 * Manages conversation threads and messages for the personal agent.
 * Handles thread creation, message persistence, and retrieval.
 */

import {
  ConversationThread,
  ConversationMessage,
  MessageRole,
  MessageTrigger,
  ThreadSource,
  Prisma,
} from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../config';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { deriveThreadTitle } from '../utils/thread-title';
import { ThreadMessageProvider } from './thread-provider.interface';
import { DatabaseThreadProvider } from './providers/database-thread.provider';
import { SlackThreadProvider } from './providers/slack-thread.provider';
import { attachmentService, type AttachmentMeta } from './attachment.service';
// The pure derivation, not contextUsageService — that service imports this
// module, so depending on it here would be a cycle.
import { buildContextSnapshot, type ContextUsageSnapshot } from '../lib/context-window';

// ============================================================================
// Types
// ============================================================================

export interface MessageInput {
  content: string;
  role: MessageRole;
  triggeredBy: MessageTrigger;
  toolCalls?: unknown[];
  blocks?: unknown[];
  tokenCount?: number;
  // Multi-user context (for channel messages)
  senderExternalId?: string; // External user ID (Slack: U..., Discord: snowflake, etc.)
  senderName?: string; // Human-readable display name
  /**
   * Marks a row the runtime wrote for the model, never for the reader.
   *
   * **An internal row is never shown to the end user.** Every client history read
   * asks for `view: 'client'`, and both thread providers answer that with
   * `internalStep: false` in the WHERE clause — so the web SPA, the TUI and Slack all
   * omit it, while the model-context read replays it. It also never names a thread,
   * and it is reported separately in `message added` telemetry so it cannot be
   * counted as something a user sent.
   *
   * Two writers today: concise mode's intermediate steps, and a turn's recalled
   * memories. Omit (or false) for a normal, user-visible message.
   */
  internalStep?: boolean;
}

export interface MessageWithAttachments extends ConversationMessage {
  attachments?: AttachmentMeta[];
}

export interface ThreadWithMessages extends ConversationThread {
  messages: MessageWithAttachments[];
  /**
   * Context occupancy derived from the thread's stored snapshot, so a reload
   * restores the context-window indicator without waiting for the next turn.
   * Null before the thread's first turn, or when `contextModel`'s window is
   * unknown.
   */
  contextUsage: ContextUsageSnapshot | null;
}

// ============================================================================
// Conversation Service
// ============================================================================

class ConversationService {
  private databaseProvider = new DatabaseThreadProvider();
  private slackProvider = new SlackThreadProvider();

  /**
   * Resolve the message provider for a thread based on its threadSource.
   */
  private async resolveProvider(threadId: string): Promise<ThreadMessageProvider> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { threadSource: true },
    });

    if (thread?.threadSource === ThreadSource.SLACK) {
      return this.slackProvider;
    }

    return this.databaseProvider;
  }

  /**
   * Get or create the latest database conversation thread for a user.
   *
   * There is no "active" flag — the runtime uses the most recently created
   * non-Slack thread. Slack channel threads (externalThreadId set) are excluded;
   * those are resolved via getOrCreateThreadByExternalId. Creates a fresh thread
   * when the user has none yet.
   */
  async getOrCreateLatestThread(agentId: string, userId: string): Promise<ConversationThread> {
    let thread = await prisma.conversationThread.findFirst({
      where: {
        agentId,
        userId,
        externalThreadId: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!thread) {
      thread = await prisma.conversationThread.create({
        data: { agentId, userId },
      });
      logger.info('Created new conversation thread for user %s (threadId: %s)', userId, thread.id);
      trackEvent('thread created', userId, {
        'agent.id': agentId,
        'thread.id': thread.id,
        'thread.source': 'database',
      });
    }

    return thread;
  }

  /**
   * Create a brand-new database conversation thread. Used when the CLI opens or
   * a session resets so the conversation starts fresh — the newly created thread
   * becomes the latest (see getOrCreateLatestThread), so no archiving is needed.
   *
   * `options.workspaceRoot` optionally records the working directory this
   * conversation is rooted in (e.g. the CLI's launch cwd). It's persisted once
   * here and never changed; shell tools later use it as their cwd. Empty /
   * whitespace-only values are ignored.
   */
  async startNewThread(
    agentId: string,
    userId: string,
    options?: { workspaceRoot?: string },
  ): Promise<ConversationThread> {
    const workspaceRoot = options?.workspaceRoot?.trim();
    const thread = await prisma.conversationThread.create({
      data: {
        agentId,
        userId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    logger.info('Started new conversation thread for user %s (threadId: %s)', userId, thread.id);
    trackEvent('thread created', userId, {
      'agent.id': agentId,
      'thread.id': thread.id,
      'thread.source': 'database',
    });

    return thread;
  }

  /**
   * Start a fresh conversation, reusing the newest thread when it is still
   * untouched (zero messages) so repeated "new conversation" clicks don't pile
   * up empty threads. Threads rooted in a workspace are never reused — the CLI
   * creates one (with a workspaceRoot) on every launch, and handing that
   * session's thread to the web would make them share it.
   */
  async getOrCreateFreshThread(agentId: string, userId: string): Promise<ConversationThread> {
    const newest = await prisma.conversationThread.findFirst({
      where: {
        agentId,
        userId,
        externalThreadId: null,
        threadSource: ThreadSource.DATABASE,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Counted separately rather than via `include: { _count: … }` on the query
    // above: that would attach a `_count` field to the returned row, so a reused
    // thread and a newly created one would serialize to different shapes.
    if (newest && !newest.workspaceRoot) {
      const messageCount = await prisma.conversationMessage.count({
        where: { threadId: newest.id },
      });
      if (messageCount === 0) return newest;
    }

    return this.startNewThread(agentId, userId);
  }

  /**
   * Read a thread's persisted workspace root (the directory it's rooted in),
   * or null if unset. Used by the conversation engine to scope shell tools to
   * the thread's workspace when one was recorded at creation.
   */
  async getThreadWorkspaceRoot(threadId: string): Promise<string | null> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { workspaceRoot: true },
    });
    return thread?.workspaceRoot ?? null;
  }

  /**
   * Build the channel-neutral delivery context for an autonomous message that
   * must land in a *specific* thread — e.g. a thread-bound scheduled task that
   * "continues" the conversation in the same place it was scheduled from.
   *
   * Mirrors the `channelContext` the conversation engine builds for a live turn,
   * but reconstructed from the stored origin channel plus the thread row, so a
   * Slack channel reply nests under the original `thread_ts` and a WebSocket
   * reply routes to the same session. Channel-specific knowledge stays here; the
   * scheduler just forwards the result to `publish()`.
   */
  async getChannelContext(
    threadId: string,
    originChannel?: string | null,
    originChannelId?: string | null,
  ): Promise<{ channel: 'slack' | 'websocket'; channelId?: string; threadTs?: string; threadId: string }> {
    if (originChannel === 'slack') {
      const thread = await prisma.conversationThread.findUnique({
        where: { id: threadId },
        select: { externalThreadId: true, externalChannelId: true, threadSource: true, userId: true, agentId: true },
      });
      let channelId = originChannelId ?? thread?.externalChannelId ?? undefined;
      // A DM-originated thread carries no channel id (the Slack DM path doesn't
      // capture one, and DM threads have no externalChannelId). Without an
      // explicit channel id the Slack adapter falls back to its mapping
      // broadcast, which can also post into the user's linked channels — so
      // resolve the user's DM channel to keep the continuation scoped to the DM.
      if (!channelId && thread) {
        const dm = await prisma.slackMapping.findFirst({
          where: { lensUserId: thread.userId, agentId: thread.agentId, dmChannelId: { not: null } },
          select: { dmChannelId: true },
        });
        channelId = dm?.dmChannelId ?? undefined;
      }
      // With no channel id, the Slack adapter has nowhere to post: the resume is
      // dropped silently. Warn so an undeliverable "continue in thread" run is at
      // least diagnosable rather than vanishing without a trace. We intentionally
      // do NOT fall back to the main channel here — a thread-bound task resumes in
      // its own thread or not at all; redirecting it elsewhere would surprise the
      // user with output in an unrelated channel.
      if (!channelId) {
        logger.warn(
          'No Slack channel resolved for thread %s (no origin/external channel id and no DM mapping) — a "continue in thread" resume will not be delivered',
          threadId,
        );
      }
      return {
        channel: 'slack',
        channelId,
        // Only SLACK-sourced threads carry a real Slack thread_ts in
        // externalThreadId. Top-level DM threads are threadSource=DATABASE and
        // store the dmChannelId (a `D…` id) there — using that as a thread_ts
        // would post with an invalid thread_ts and break the continuation, so
        // resume them top-level (channelId scopes delivery to the DM).
        threadTs: thread?.threadSource === ThreadSource.SLACK ? (thread.externalThreadId ?? undefined) : undefined,
        threadId,
      };
    }
    return { channel: 'websocket', threadId };
  }

  /**
   * Get or create a conversation thread bound to a specific external thread ID.
   * Used for Slack channel threads where each Slack thread maps to its own conversation.
   */
  async getOrCreateThreadByExternalId(
    userId: string,
    agentId: string,
    externalThreadId: string,
    options?: { channelId?: string },
  ): Promise<ConversationThread> {
    const thread = await prisma.conversationThread.upsert({
      where: {
        agentId_userId_externalThreadId: { agentId, userId, externalThreadId },
      },
      create: {
        agentId,
        userId,
        externalThreadId,
        ...(options?.channelId && {
          threadSource: 'SLACK' as ThreadSource,
          externalChannelId: options.channelId,
        }),
      },
      update: {
        // Update channelId if provided (in case it was missing before)
        ...(options?.channelId && {
          threadSource: 'SLACK' as ThreadSource,
          externalChannelId: options.channelId,
        }),
      },
    });

    // Upsert can't report create-vs-update; on create both timestamps carry
    // the same initial value, while the update path bumps @updatedAt.
    if (
      thread?.createdAt instanceof Date &&
      thread.updatedAt instanceof Date &&
      thread.createdAt.getTime() === thread.updatedAt.getTime()
    ) {
      trackEvent('thread created', userId, {
        'agent.id': agentId,
        'thread.id': thread.id,
        // Mirror the actual threadSource: with a channelId this is a SLACK
        // thread (channel or threaded DM); without one it's a top-level DM,
        // which stays DATABASE — don't mislabel those as Slack.
        'thread.source': options?.channelId ? 'slack' : 'database',
      });
    }

    return thread;
  }

  /**
   * Get a thread by ID (with ownership check)
   */
  async getThread(userId: string, agentId: string, threadId: string): Promise<ThreadWithMessages | null> {
    const thread = await prisma.conversationThread.findFirst({
      where: {
        id: threadId,
        agentId,
        userId,
      },
    });

    if (!thread) return null;

    const provider = thread.threadSource === ThreadSource.SLACK
      ? this.slackProvider
      : this.databaseProvider;

    // CLIENT history (web SPA): hide concise-mode internal steps. The model path
    // (getThreadContext) reads without this option so it still replays them.
    const messages = await provider.getMessages(threadId, { view: 'client' });

    // Attach file metadata (no bytes) so the web UI renders chips on history.
    const withAttachments: MessageWithAttachments[] =
      await attachmentService.attachMetaToMessages(messages);

    // Derived here rather than in each client: the percentage needs the model's
    // context window, which only the runtime has (the models.dev catalog isn't
    // importable from the web/cli workspaces). Null until the thread's first turn
    // completes, or when the stored model is unrecognized.
    const contextUsage = buildContextSnapshot(threadId, thread.contextModel, thread.contextTokens);

    return { ...thread, messages: withAttachments, contextUsage };
  }

  /**
   * Lightweight ownership/existence check: returns the thread id when it
   * belongs to this agent+user, else null. Unlike getThread it does NOT load
   * the thread's messages or attachment metadata, so callers that only need to
   * authorize a thread id (e.g. the CLI's /messages replay) stay cheap.
   */
  async getOwnedThreadId(userId: string, agentId: string, threadId: string): Promise<string | null> {
    const thread = await prisma.conversationThread.findFirst({
      where: { id: threadId, agentId, userId },
      select: { id: true },
    });
    return thread?.id ?? null;
  }

  /**
   * List all threads for a user
   */
  async listThreads(
    userId: string,
    agentId: string,
    options?: { limit?: number; threadSource?: ThreadSource }
  ): Promise<ConversationThread[]> {
    return prisma.conversationThread.findMany({
      where: {
        agentId,
        userId,
        // The DATABASE set is the web/CLI-resumable one. Genuine web/CLI threads
        // are always created with externalThreadId: null (getOrCreateLatestThread
        // / startNewThread); externalId-keyed DATABASE threads (top-level Slack
        // DMs keyed by dmChannelId) are conversation records, not resumable
        // threads — exclude them so they don't surface in Recents or the resume
        // picker. The SLACK listing path is untouched.
        ...(options?.threadSource === ThreadSource.DATABASE
          ? { threadSource: ThreadSource.DATABASE, externalThreadId: null }
          : options?.threadSource
            ? { threadSource: options.threadSource }
            : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: options?.limit ?? 20,
    });
  }

  /**
   * Add a message to a thread.
   *
   * Returns the created message plus `titleSet` — the title just assigned to
   * the thread from this (first user) message, or null when no title was set
   * (non-USER, empty content, or the thread is already titled). Callers use it
   * to push a live title update to clients.
   */
  async addMessage(
    threadId: string,
    input: MessageInput
  ): Promise<{ message: ConversationMessage; titleSet: string | null }> {
    const message = await prisma.conversationMessage.create({
      data: {
        threadId,
        role: input.role,
        content: input.content,
        triggeredBy: input.triggeredBy,
        toolCalls: input.toolCalls as Prisma.InputJsonValue | undefined,
        blocks: input.blocks as Prisma.InputJsonValue | undefined,
        tokenCount: input.tokenCount,
        senderExternalId: input.senderExternalId,
        senderName: input.senderName,
        internalStep: input.internalStep,
      },
    });

    // Update thread's updatedAt
    const thread = await prisma.conversationThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });

    trackEvent('message added', null, {
      ...(thread?.agentId ? { 'agent.id': thread.agentId } : {}),
      'thread.id': threadId,
      'message.role': input.role,
      'message.triggered_by': input.triggeredBy,
      // Internal rows are written by the runtime, not sent by anyone. Without this a
      // recalling chat turn adds a second `role=USER` count and every message-volume
      // metric steps at deploy for a reason that is not user behaviour.
      'message.internal': String(Boolean(input.internalStep)),
    });

    // Name the thread after the user's first message (first 3 words, capped).
    // `title: null` makes this atomic and one-shot — it fires only for the very
    // first user message with text and is a no-op for every later message.
    // `count > 0` means this call actually set it, so callers can broadcast it.
    // Never from an internal row: those are written for model context and are not
    // the user's words. A first message carrying only a file leaves the title unset
    // (its text is empty), and the turn's recalled memories would otherwise be the
    // next USER row with text and name the thread after themselves.
    let titleSet: string | null = null;
    if (input.role === 'USER' && !input.internalStep) {
      const title = deriveThreadTitle(input.content);
      if (title) {
        const res = await prisma.conversationThread.updateMany({
          where: { id: threadId, title: null },
          data: { title },
        });
        if (res.count > 0) titleSet = title;
      }
    }

    return { message, titleSet };
  }

  /**
   * Store the external message ID (e.g. Slack ts) on a persisted message.
   * Used to link DB records back to Slack messages for tool call enrichment.
   */
  async setExternalMessageId(messageId: string, externalMessageId: string): Promise<void> {
    await prisma.conversationMessage.update({
      where: { id: messageId },
      data: { externalMessageId },
    });
  }

  /**
   * Get recent messages from a thread for CLIENT history (CLI `/messages`).
   * Hides concise-mode internal steps — the model path uses getThreadContext.
   */
  async getRecentMessages(
    threadId: string,
    limit: number = 20
  ): Promise<ConversationMessage[]> {
    const provider = await this.resolveProvider(threadId);
    return provider.getRecentMessages(threadId, limit, { view: 'client' });
  }

  /**
   * Record this thread's latest context-occupancy snapshot.
   *
   * `contextTokens` is a per-turn measurement (the provider-reported prompt size
   * plus that turn's output), NOT a running total — each call overwrites the
   * previous value. `contextModel` is stored alongside so the percentage is
   * recomputed against the right window even after the agent's model changes.
   *
   * `updateMany` so a thread deleted mid-turn is a silent no-op rather than a
   * thrown P2025, matching `updateThreadTitle`.
   */
  async setThreadContextUsage(threadId: string, contextTokens: number, contextModel: string): Promise<void> {
    await prisma.conversationThread.updateMany({
      where: { id: threadId },
      data: { contextTokens, contextModel },
    });
  }

  /**
   * Update thread title
   */
  async updateThreadTitle(
    agentId: string,
    userId: string,
    threadId: string,
    title: string
  ): Promise<void> {
    await prisma.conversationThread.updateMany({
      where: { id: threadId, agentId, userId },
      data: { title },
    });
  }

  /**
   * Get thread with compaction summary (for context building).
   * Compaction itself (summarize + mark rows) lives in `compaction.service.ts`.
   */
  async getThreadContext(threadId: string): Promise<{
    compactionSummary: string | null;
    threadSource: ThreadSource;
    messages: ConversationMessage[];
  }> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: {
        compactionSummary: true,
        threadSource: true,
      },
    });

    const threadSource = thread?.threadSource ?? ThreadSource.DATABASE;
    const provider = threadSource === ThreadSource.SLACK
      ? this.slackProvider
      : this.databaseProvider;

    const messages = await provider.getMessages(threadId);

    return {
      compactionSummary: thread?.compactionSummary ?? null,
      threadSource,
      messages,
    };
  }

  /**
   * Set the external thread ID on an existing thread.
   * Used to link an internal thread to an external channel thread (e.g. Slack thread_ts).
   * Always overwrites any existing external ID — the latest Slack thread wins.
   */
  async setExternalId(threadId: string, externalThreadId: string): Promise<void> {
    await prisma.conversationThread.updateMany({
      where: { id: threadId },
      data: { externalThreadId },
    });
    trackEvent('thread external id set', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'thread.id': threadId,
    });
  }

  /**
   * Get the latest database thread for a user without creating one.
   * Used by heartbeat to include conversation context. Slack threads
   * (externalThreadId set) are excluded.
   */
  async getLatestThread(userId: string): Promise<ConversationThread | null> {
    return prisma.conversationThread.findFirst({
      where: { userId, externalThreadId: null },
      orderBy: { createdAt: 'desc' },
    });
  }
}

// Export singleton instance
export const conversationService = new ConversationService();
