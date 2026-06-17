/**
 * Thread title generation.
 *
 * The synchronous title (conversation.service.addMessage) is just the first 3
 * words of the user's message, truncated. This upgrades it to a proper short
 * title via a cheap model (Haiku) — a direct LLM inference call, no tools and
 * no `invoke`, mirroring the heartbeat classification gate. Fire-and-forget
 * from the WS gateway after the placeholder is pushed; fail-open (a failure
 * leaves the placeholder in place).
 */

import { generateText } from 'ai';
import { getClassificationModel } from '../lib/classification';
import { isLangfuseEnabled } from '../lib/langfuse';
import { conversationService } from './conversation.service';
import { logger } from '../logger';

const SYSTEM_PROMPT = `You write a very short title for a chat conversation based on the user's first message.
Reply with ONLY the title — at most 3 words, no quotes, no punctuation, no preamble.`;

/** Trim, strip wrapping quotes/trailing punctuation, keep the first 3 words. */
function clampTitle(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+/, '')
    .replace(/["'`.!?]+$/, '')
    .trim();
  const title = cleaned.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  return title || null;
}

/**
 * Ask the cheap model for a short title for `message`. Returns the clamped
 * title, or null when the message is empty or the call fails.
 */
async function generateThreadTitle(message: string): Promise<string | null> {
  const text = message.trim();
  if (!text) return null;
  try {
    const result = await generateText({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user' as const, content: text }],
      maxOutputTokens: 24,
      temperature: 0,
      ...(isLangfuseEnabled() && {
        experimental_telemetry: { isEnabled: true, functionId: 'thread-title' },
      }),
    });
    return clampTitle(result.text);
  } catch (error) {
    logger.error({ err: error }, '[ThreadTitle] generation failed');
    return null;
  }
}

export const threadTitleService = {
  /**
   * Generate a short title for the thread's first message and persist it.
   * Returns the saved title, or null when nothing was generated/saved (so the
   * caller can skip broadcasting). Never throws.
   */
  async generateAndSave(
    agentId: string,
    userId: string,
    threadId: string,
    message: string,
  ): Promise<string | null> {
    const title = await generateThreadTitle(message);
    if (!title) return null;
    await conversationService.updateThreadTitle(agentId, userId, threadId, title);
    logger.info('[ThreadTitle] Set thread %s title to "%s"', threadId, title);
    return title;
  },
};
