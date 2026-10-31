/**
 * How the web chat appears in the agent's system prompt, for the channel
 * participation instructions it gets once a second person writes there.
 */

import { conversationService } from './conversation.service';

export const WEB_CHAT_LABEL =
  "this agent's web chat, which every person who opens the agent sees, and where you address people by name, " +
  'because the chat shows a token as text';

/**
 * The label for a web conversation that two or more people wrote in. Read from
 * the thread's rows, so every turn on it agrees and the system prompt changes once.
 */
export async function webChatLabel(threadId: string): Promise<string | undefined> {
  return (await conversationService.hasSeveralSenders(threadId)) ? WEB_CHAT_LABEL : undefined;
}
