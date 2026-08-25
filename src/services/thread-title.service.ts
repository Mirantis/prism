/**
 * Thread title generation (channel-agnostic).
 *
 * The synchronous title (conversation.service.addMessage) is just the first 3
 * words of the user's message, truncated. This upgrades it to a proper short
 * title via a cheap model (Haiku) — a direct LLM inference call, no tools and
 * no `invoke`, mirroring the heartbeat classification gate.
 *
 * `onFirstUserMessage` owns the placeholder → upgrade lifecycle and announces
 * each title via the `events` emitter. It is triggered from the conversation
 * engine (the one path every channel goes through), so nothing here knows
 * about WebSockets/Slack; transports subscribe to `events` to push updates.
 * Fail-open: a generation failure just leaves the placeholder in place.
 */

import { EventEmitter } from 'node:events';
import { generateText } from 'ai';
import { getGateRequest } from '../lib/classification';
import { langfuseTelemetry } from '../lib/telemetry';
import { conversationService } from './conversation.service';
import { logger } from '../logger';

const SYSTEM_PROMPT = `You write a very short title for a chat conversation based on the user's first message.
Reply with ONLY the title — at most 3 words, no quotes, no punctuation, no preamble.`;

/** A thread's title was (re)set — emitted as `'change'` on the service. */
export interface ThreadTitleChange {
  userId: string;
  threadId: string;
  title: string;
}

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
    const { model, providerOptions, samplingParams } = getGateRequest();
    const result = await generateText({
      model,
      providerOptions,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user' as const, content: text }],
      maxOutputTokens: 24,
      ...samplingParams,
      ...langfuseTelemetry('thread-title'),
    });
    // The title model can decline the message it was asked to summarize. The
    // finish reason is what says so: the text may be empty or may be the
    // refusal sentence, and only the second shape produced a title — cut to
    // three words and saved, a thread ended up named "I can't help".
    if (result.finishReason === 'content-filter') return null;
    return clampTitle(result.text);
  } catch (error) {
    logger.error({ err: error }, '[ThreadTitle] generation failed');
    return null;
  }
}

class ThreadTitleService {
  /**
   * Emits `'change'` ({ userId, threadId, title }: ThreadTitleChange) whenever
   * a thread title is (re)set — first the placeholder, then the LLM upgrade.
   * Transports (e.g. the WS gateway) subscribe to push the update to clients;
   * the generation here stays channel-agnostic.
   */
  readonly events = new EventEmitter();

  /**
   * React to the first user message that named a thread: announce the
   * placeholder title immediately, then asynchronously upgrade it to a proper
   * short title and announce that too. Fire-and-forget — never blocks the
   * turn; a generation failure just keeps the placeholder.
   */
  onFirstUserMessage(
    agentId: string,
    userId: string,
    threadId: string,
    message: string,
    placeholderTitle: string,
  ): void {
    this.events.emit('change', { userId, threadId, title: placeholderTitle } as ThreadTitleChange);
    void this.generateAndSave(agentId, userId, threadId, message)
      .then((title) => {
        if (title) this.events.emit('change', { userId, threadId, title } as ThreadTitleChange);
      })
      .catch((err) => logger.error({ err }, '[ThreadTitle] upgrade failed'));
  }

  /**
   * Generate a short title for the thread's first message and persist it.
   * Returns the saved title, or null when nothing was generated/saved. Never
   * throws.
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
  }
}

export const threadTitleService = new ThreadTitleService();
