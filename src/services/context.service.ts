/**
 * Context Service
 *
 * Builds agent context by fetching agent data from the backend
 * and conversation history from the local database.
 */

import { agentWorkspaceService } from './agent-workspace.service';
import { conversationService } from './conversation.service';
import { AgentContext } from '../types';

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
      const thread = await conversationService.getActiveThread(userId);
      resolvedThreadId = thread?.id;
    }

    if (includeConversation && resolvedThreadId) {
      const threadContext = await conversationService.getThreadContext(resolvedThreadId);
      context.conversationSummary = threadContext.compactionSummary;
      context.recentMessages = threadContext.messages
        .filter(m => m.content.trim().length > 0 || (m.role === 'AGENT' && m.toolCalls))
        .slice(-20);
    }

    return context;
  }
}

export const contextService = new ContextService();
