/**
 * Thread Reply Classifier
 *
 * Decides what the bot does with a reply that does not mention it, in a chat
 * thread the bot takes part in: answer it or leave it. Each channel adapter
 * decides first whether the bot takes part in the thread, and then asks here
 * about the last line of the transcript.
 */

import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { trackEvent } from '../lib/telemetry';
import { getClassificationRequest } from '../lib/classification';
import { callModelForObject } from '../lib/model-call';
import type { LlmCallPurpose } from './llm-call.service';

export type ThreadAction = { action: 'respond' } | { action: 'ignore' };

/** One message of the thread, oldest first; the last one is judged. */
export interface ThreadLine {
  fromBot: boolean;
  /** Who wrote it, as the channel identifies people. */
  author: string;
  text: string;
}

export type ThreadPlatform = 'slack' | 'teams';

const PLATFORMS: Record<
  ThreadPlatform,
  { name: string; purpose: LlmCallPurpose; failureEvent: string }
> = {
  slack: {
    name: 'Slack',
    purpose: 'slack-thread-gate',
    failureEvent: 'slack thread classification failed',
  },
  teams: {
    name: 'Microsoft Teams',
    purpose: 'teams-thread-gate',
    failureEvent: 'teams thread classification failed',
  },
};

/** The newest lines of the thread the classifier reads. */
export const THREAD_TRANSCRIPT_LINES = 10;

const threadClassificationSchema = z.object({
  action: z.enum(['respond', 'no_reply']),
});

/**
 * Telemetry-safe description of a thrown value: the kind of failure and the
 * HTTP status the AI SDK reports (`APICallError.statusCode`). Never the message,
 * which can quote the request, and so the transcript, back.
 */
function errorShape(error: unknown): Record<string, string> {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return {
    'error.name': error instanceof Error ? error.name : typeof error,
    ...(typeof status === 'number' ? { 'error.status': String(status) } : {}),
  };
}

/**
 * The label name and the "whoever in the thread asks it" sentence set where the
 * respond boundary falls: an edit here changes which messages the bot answers, so
 * compare it on sample threads before shipping it.
 */
function systemPrompt(platformName: string): string {
  return [
    `You classify replies in a ${platformName} thread where an AI assistant bot takes part. You get the recent messages of the thread, oldest first, and decide what the bot does with the last one.`,
    '',
    'Return a JSON object with:',
    '- action: "respond" if the last message needs the bot to answer or to act: a question, a request, an instruction, an approval, an authorization, a go-ahead ("approved", "yes please", "go ahead", "merge it"), or a correction of what the bot said or did. An instruction counts even when it asks for no answer, because the bot answers it by doing the work. A question about what the bot said or did needs the bot, whoever in the thread asks it.',
    '- action: "no_reply" if the last message needs nothing from the bot: one human answers or thanks another, or the message is an aside that names no work for the bot.',
    '',
    'When you are unsure whether the last message asks the bot for something, choose "respond". A wrong "respond" makes the bot answer, and possibly act on, a message that was not for it; a wrong "no_reply" drops an instruction, and the user has to send it again.',
  ].join('\n');
}

class ThreadReplyClassifierService {
  /**
   * Owns each platform's `failureEvent`. Worth an event because the
   * failure mode is degradation rather than an outage: a failed call answers
   * `respond`, so a classifier that has stopped working looks exactly like a
   * chatty bot and shows up nowhere else.
   */
  async classify(input: {
    platform: ThreadPlatform;
    agentId: string;
    lines: ThreadLine[];
  }): Promise<ThreadAction> {
    const { agentId, lines } = input;
    const platform = PLATFORMS[input.platform];
    try {
      const transcript = lines
        .slice(-THREAD_TRANSCRIPT_LINES)
        .map((line) => `${line.fromBot ? '[Bot]' : `[User:${line.author}]`}: ${line.text}`)
        .join('\n');

      // One provider build for both the model and its structured-output
      // options. Whatever the active vendor needs is forwarded as-is. Getting it
      // wrong is invisible: the catch below answers `respond`, so the bot would
      // answer every threaded message instead of ignoring any.
      const { model, providerOptions, samplingParams } = getClassificationRequest();

      const { object } = await callModelForObject({ purpose: platform.purpose }, {
        model,
        schema: threadClassificationSchema,
        // temperature: 0 on the vendors that accept it, omitted elsewhere.
        ...samplingParams,
        providerOptions,
        // Traced by nobody, and stated rather than left to a default: once a
        // telemetry integration is registered every call is traced with its
        // prompt recorded, and this prompt is a transcript of a chat channel.
        experimental_telemetry: { isEnabled: false },
        system: systemPrompt(platform.name),
        prompt: transcript,
      });

      // The prompt's label is `no_reply`, not `ignore`: with `ignore` the model
      // left more questions to the bot unanswered.
      return { action: object.action === 'respond' ? 'respond' : 'ignore' };
    } catch (error) {
      // Under `err`, not interpolated into the message: a string built from
      // `error.message` is the one shape the redacting serializer cannot see.
      logger.warn({ err: error }, 'Thread classification failed, falling back to respond');
      // Props stay to ids, the active model and the error's shape, never the
      // transcript or the message text the classifier ran on.
      trackEvent(platform.failureEvent, null, {
        'agent.id': agentId,
        'llm.provider': config.llmProvider,
        'llm.classification_model': config.classificationModelId,
        ...errorShape(error),
      });
      return { action: 'respond' };
    }
  }
}

export const threadReplyClassifierService = new ThreadReplyClassifierService();
