import type { ConversationMessage } from '@prisma/client';
import type { AgentMessageKind } from '../protocol/chat-protocol';

/**
 * A message from another agent keeps its kind in `triggerName`. Both the chat
 * socket's `message` event and a client's history read derive it here, so a
 * message shows the same whether it arrived live or was read back.
 */
export function agentMessageKind(message: Pick<ConversationMessage, 'triggeredBy' | 'triggerName'>): AgentMessageKind | null {
  if (message.triggeredBy !== 'AGENT_MESSAGE') return null;
  return message.triggerName === 'ask' || message.triggerName === 'notice' ? message.triggerName : 'message';
}
