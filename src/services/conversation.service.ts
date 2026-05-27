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
  ThreadStatus,
  ThreadSource,
  Prisma,
} from '@prisma/client';
import prisma from '../lib/prisma';
import { logger } from '../logger';
import { ThreadMessageProvider } from './thread-provider.interface';
import { DatabaseThreadProvider } from './providers/database-thread.provider';
import { SlackThreadProvider } from './providers/slack-thread.provider';

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

export interface ThreadWithMessages extends ConversationThread {
  messages: ConversationMessage[];
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
   * Get or create the active conversation thread for a user.
   * If no active thread exists, creates a new one.
   */
  async getOrCreateActiveThread(agentId: string, userId: string): Promise<ConversationThread> {
    // Find existing active thread (exclude threads bound to external conversations
    // like Slack channel threads — those use getOrCreateThreadByExternalId)
    let thread = await prisma.conversationThread.findFirst({
      where: {
        agentId: agentId,
        userId,
        status: 'ACTIVE',
        externalThreadId: null,
      },
      orderBy: { updatedAt: 'desc' },
    });

    // Create new thread if none exists
    if (!thread) {
      thread = await prisma.conversationThread.create({
        data: {
          agentId: agentId,
          userId,
          status: 'ACTIVE',
        },
      });
      logger.info('Created new conversation thread for user %s (threadId: %s)', userId, thread.id);
    }

    return thread;
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
    return prisma.conversationThread.upsert({
      where: {
        agentId_userId_externalThreadId: { agentId, userId, externalThreadId },
      },
      create: {
        agentId,
        userId,
        externalThreadId,
        status: 'NON_ACTIVE',
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

    return { ...thread, messages };
  }

  /**
   * List all threads for a user
   */
  async listThreads(
    userId: string,
    agentId: string,
    options?: { status?: ThreadStatus; limit?: number }
  ): Promise<ConversationThread[]> {
    return prisma.conversationThread.findMany({
      where: {
        agentId,
        userId,
        ...(options?.status && { status: options.status }),
      },
      orderBy: { updatedAt: 'desc' },
      take: options?.limit ?? 20,
    });
  }

  /**
   * Add a message to a thread
   */
  async addMessage(
    threadId: string,
    input: MessageInput
  ): Promise<ConversationMessage> {
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
    await prisma.conversationThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });

    return message;
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
   * Deactivate a thread by ID (set status to NON_ACTIVE)
   * Can be called with just threadId (for internal use) or with userId for ownership check
   */
  async deactivateThread(threadId: string, userId?: string): Promise<void> {
    if (userId) {
      await prisma.conversationThread.updateMany({
        where: { id: threadId, userId },
        data: { status: 'NON_ACTIVE' },
      });
    } else {
      // Internal use - just deactivate by ID
      await prisma.conversationThread.update({
        where: { id: threadId },
        data: { status: 'NON_ACTIVE' },
      });
    }
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
    messages: ConversationMessage[];
  }> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: {
        compactionSummary: true,
        threadSource: true,
      },
    });

    const provider = thread?.threadSource === ThreadSource.SLACK
      ? this.slackProvider
      : this.databaseProvider;

    const messages = await provider.getMessages(threadId);

    return {
      compactionSummary: thread?.compactionSummary ?? null,
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
  }

  /**
   * Get the active thread for a user without creating one.
   * Used by heartbeat to include conversation context.
   */
  async getActiveThread(userId: string): Promise<ConversationThread | null> {
    return prisma.conversationThread.findFirst({
      where: { userId, status: 'ACTIVE', externalThreadId: null },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Delete old threads (cleanup)
   */
  async cleanupOldThreads(
    agentId: string,
    userId: string,
    daysOld: number = 30
  ): Promise<number> {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

    const result = await prisma.conversationThread.deleteMany({
      where: {
        agentId,
        userId,
        status: 'NON_ACTIVE',
        updatedAt: { lt: cutoff },
      },
    });

    return result.count;
  }
}

// Export singleton instance
export const conversationService = new ConversationService();
