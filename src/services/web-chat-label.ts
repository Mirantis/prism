/**
 * How the web chat appears in the agent's system prompt, for the channel
 * participation instructions it gets once a second person writes there.
 */

import { prisma } from '../lib/prisma';
import { conversationService } from './conversation.service';

export const WEB_CHAT_LABEL =
  "this agent's web chat, which every person who opens the agent sees, and where you address people by name, " +
  'because the chat shows a token as text';

/**
 * The label for a web conversation that two or more people wrote in. Read from
 * the thread's rows, so every turn on it agrees and the system prompt changes once.
 * A thread that a channel keeps its own id for is that channel's, and gets none.
 */
export async function webChatLabel(threadId: string): Promise<string | undefined> {
  const thread = await prisma.conversationThread.findUnique({
    where: { id: threadId },
    select: { externalThreadId: true },
  });
  if (!thread || thread.externalThreadId) return undefined;
  return (await conversationService.hasSeveralSenders(threadId)) ? WEB_CHAT_LABEL : undefined;
}
