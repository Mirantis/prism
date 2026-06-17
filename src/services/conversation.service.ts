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
}

export interface MessageWithAttachments extends ConversationMessage {
  attachments?: AttachmentMeta[];
}

export interface ThreadWithMessages extends ConversationThread {
  messages: MessageWithAttachments[];
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
        'thread.source': 'slack',
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

    const messages = await provider.getMessages(threadId);

    // Attach file metadata (no bytes) so the web UI renders chips on history.
    const withAttachments: MessageWithAttachments[] =
      await attachmentService.attachMetaToMessages(messages);

    return { ...thread, messages: withAttachments };
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
        // Optional channel filter. `DATABASE` is the web/CLI-resumable set —
        // it excludes Slack threads (which the resume picker and Recents list
        // never show).
        ...(options?.threadSource && { threadSource: options.threadSource }),
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
    });

    // Name the thread after the user's first message (first 3 words, capped).
    // `title: null` makes this atomic and one-shot — it fires only for the very
    // first user message with text and is a no-op for every later message.
    // `count > 0` means this call actually set it, so callers can broadcast it.
    let titleSet: string | null = null;
    if (input.role === 'USER') {
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
   * Get recent messages from a thread
   */
  async getRecentMessages(
    threadId: string,
    limit: number = 20
  ): Promise<ConversationMessage[]> {
    const provider = await this.resolveProvider(threadId);
    return provider.getRecentMessages(threadId, limit);
  }

  /**
   * Get total token count for a thread
   */
  async getThreadTokenCount(threadId: string): Promise<number> {
    const result = await prisma.conversationMessage.aggregate({
      where: {
        threadId,
        isCompacted: false,
      },
      _sum: {
        tokenCount: true,
      },
    });

    return result._sum.tokenCount ?? 0;
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
   * Compact old messages in a thread
   * This is called when the thread is approaching the context limit.
   */
  async compactThread(
    threadId: string,
    summary: string,
    preserveLastN: number = 10
  ): Promise<void> {
    // Get all uncompacted messages
    const messages = await prisma.conversationMessage.findMany({
      where: {
        threadId,
        isCompacted: false,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (messages.length <= preserveLastN) {
      return; // Nothing to compact
    }

    // Mark older messages as compacted
    const messagesToCompact = messages.slice(0, -preserveLastN);
    const messageIds = messagesToCompact.map(m => m.id);

    await prisma.conversationMessage.updateMany({
      where: { id: { in: messageIds } },
      data: { isCompacted: true },
    });

    // Store the summary
    await prisma.conversationThread.update({
      where: { id: threadId },
      data: {
        compactionSummary: summary,
        compactedAt: new Date(),
      },
    });

    logger.info('Compacted %d messages in thread %s', messagesToCompact.length, threadId);
  }

  /**
   * Get thread with compaction summary (for context building)
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
