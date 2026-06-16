/**
 * Context Service
 *
 * Builds agent context by fetching agent data from the backend
 * and conversation history from the local database.
 */

import { agentWorkspaceService } from './agent-workspace.service';
import { conversationService } from './conversation.service';
import { attachmentService } from './attachment.service';
import { AgentContext } from '../types';
import type { ConversationMessage as PrismaConversationMessage } from '@prisma/client';

class ContextService {
  async getAgentContext(
    userId: string,
    options: { agentId: string; threadId?: string; includeConversation?: boolean }
  ): Promise<AgentContext> {
    const { threadId, includeConversation = true } = options;

    // 1. Fetch agent from database
    const agent = await agentWorkspaceService.getAgent();

    const isBootstrapPhase = !!(agent.bootstrapMd && agent.bootstrapMd.trim());

    const context: AgentContext = {
      soulMd: agent.soulMd,
      userMd: agent.userMd,
      memoryMd: agent.memoryMd,
      heartbeatMd: agent.heartbeatMd,
      bootstrapMd: agent.bootstrapMd,
      visionMd: agent.visionMd,
      agentMd: agent.agentMd,
      agentName: agent.name,
      agentId: agent.id,
      userId,
      proactivity: agent.proactivity,
      verbosity: agent.verbosity,
      model: agent.model ?? null,
      isBootstrapPhase,
      conversationSummary: null,
      recentMessages: [],
    };

    // 2. Resolve thread and fetch conversation
    let resolvedThreadId = threadId;
    if (includeConversation && !resolvedThreadId) {
      const thread = await conversationService.getLatestThread(userId);
      resolvedThreadId = thread?.id;
    }

    if (includeConversation && resolvedThreadId) {
      const threadContext = await conversationService.getThreadContext(resolvedThreadId);
      context.conversationSummary = threadContext.compactionSummary;
      context.recentMessages = await this.attachFiles(resolvedThreadId, threadContext.threadSource, threadContext.messages);
    }

    return context;
  }

  /**
   * Filter to the last-20 LLM window and load shared-file bytes for each
   * surviving message. Shared files are ALWAYS exposed while they're in the
   * window. Attachment keys differ by source: DB threads key by messageId,
   * live-read Slack threads key by the Slack message ts (externalMessageId).
   *
   * Two passes keep it cheap: a metadata-only pass (no BLOB reads) decides
   * which otherwise-empty file-only turns to keep, then bytes load only for
   * the final ≤20 messages.
   */
  private async attachFiles(
    threadId: string,
    threadSource: 'DATABASE' | 'SLACK',
    messages: PrismaConversationMessage[],
  ): Promise<AgentContext['recentMessages']> {
    const isSlack = threadSource === 'SLACK';
    const keyOf = (m: PrismaConversationMessage) => (isSlack ? m.externalMessageId ?? '' : m.id);

    const metaMap = isSlack
      ? await attachmentService.getMetaByExternalTs(
          threadId,
          messages.map(m => m.externalMessageId).filter((t): t is string => !!t),
        )
      : await attachmentService.getMetaByMessageIds(messages.map(m => m.id));

    const windowed = messages
      .filter(m =>
        m.content.trim().length > 0 ||
        (m.role === 'AGENT' && !!m.toolCalls) ||
        metaMap.has(keyOf(m)),
      )
      .slice(-20);

    // This runs on every chat/heartbeat turn; the meta pass covered every
    // candidate message, so an empty map means the BLOB query would return
    // nothing — skip it (the common, attachment-free case).
    if (metaMap.size === 0) return windowed;

    const windowKeys = windowed.map(keyOf).filter((k): k is string => !!k);
    if (windowKeys.length === 0) return windowed;

    const bytesMap = isSlack
      ? await attachmentService.loadByExternalTs(threadId, windowKeys)
      : await attachmentService.loadForMessages(windowKeys);

    return windowed.map(m => {
      const attachments = bytesMap.get(keyOf(m));
      return attachments && attachments.length > 0 ? { ...m, attachments } : m;
    });
  }
}

export const contextService = new ContextService();
