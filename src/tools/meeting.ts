/**
 * Tools for joining and leaving live voice meetings.
 *
 * All three are platform-agnostic. The join tool was `join_meeting` first, on the
 * reasoning that the name is the model's only signal of which platforms work — but
 * the platform is already decided by the URL (`findProvider` matches on the host),
 * and the alternative scales badly: a per-platform *leave* would mean
 * `leave_google_meet` and `leave_msteams_meeting` doing the identical thing to the
 * same single-call state. The supported platforms belong in the description, which
 * is read at the same moment as the name and can say more.
 *
 * Registered only when the container can actually host a call — the browser and
 * audio toolchain on PATH plus an OpenAI key. Offering a tool that always answers
 * "not available here" wastes tokens on every turn and invites the model to promise
 * something it can't do.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import { meetingBotService } from '../services/meeting/meeting-bot.service';
import { AUDIO_STACK_BINARIES } from '../services/meeting/audio-stack';
import { isBrowserAvailable } from '../services/meeting/browser-stack';
import { isRealtimeConfigured } from '../services/meeting/openai-endpoint';
import { logger } from '../logger';

/**
 * Tool names, exported so every autonomous mode can drop them in one place.
 *
 * A live call keeps them: `join_meeting` inside a meeting harmlessly reports
 * that it is already in one, and the other three are how the agent ends the call it is
 * in, inspects it, and finds out who it is talking to.
 */
export const MEETING_TOOL_NAMES = [
  'join_meeting',
  'leave_meeting',
  'meeting_speaker',
  'meeting_status',
] as const;

export interface MeetingToolsInput {
  userId: string;
  agentId: string;
  /** Where join progress is reported; the calling turn's thread. */
  threadId?: string;
  /** The channel the join was requested from, so status notes route back there. */
  originChannel?: 'slack' | 'websocket';
  /** The Slack channel id of that request, when the origin is Slack. */
  originChannelId?: string;
}

/**
 * Whether this host can run a voice meeting.
 *
 * Checked once at startup (see `index.ts`) rather than per turn, so the tool set
 * stays byte-identical across requests — the provider's prompt cache covers the
 * tools block, and a set that changes shape mid-conversation misses it.
 */
export async function isMeetingSupported(): Promise<boolean> {
  if (!isRealtimeConfigured()) return false;
  if (!(await isBrowserAvailable())) return false;

  const { promises: fs } = await import('fs');
  const path = await import('path');
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const binary of AUDIO_STACK_BINARIES) {
    const found = await Promise.all(
      pathEntries.map(async (dir) => {
        try {
          await fs.access(path.join(dir, binary));
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (!found.some(Boolean)) {
      logger.info(`[Meeting] Voice meetings unavailable: ${binary} is not on PATH`);
      return false;
    }
  }
  return true;
}

export function getMeetingTools(input: MeetingToolsInput): Record<string, Tool> {
  return {
    join_meeting: tool({
      description:
        'Join a video call as a live voice participant — you will speak and listen in real ' +
        'time. Google Meet links are supported today; the platform is taken from the URL. ' +
        'Returns as soon as the request to join is in; a host must admit you, and progress ' +
        'is reported in this conversation. Only one call at a time.',
      inputSchema: z.object({
        url: z
          .string()
          .describe('The meeting link — a Google Meet URL, e.g. https://meet.google.com/abc-defg-hij'),
        responseMode: z
          .enum(['auto', 'open', 'addressed'])
          .optional()
          .describe(
            'How much you speak up. "auto" (the default, and almost always right) reads the ' +
            'room: with one other person you answer everything, with more you wait to be ' +
            'addressed by name. "open" always answers every utterance — only for a call you ' +
            'know stays one-to-one. "addressed" always waits to be named.',
          ),
      }),
      execute: async ({ url, responseMode }) => {
        const provider = meetingBotService.findProvider(url);
        if (!provider) {
          return {
            success: false,
            error:
              `"${url}" is not a Google Meet link. Meeting links look like ` +
              'https://meet.google.com/abc-defg-hij.',
          };
        }

        const result = await meetingBotService.join({
          url,
          userId: input.userId,
          agentId: input.agentId,
          threadId: input.threadId,
          originChannel: input.originChannel,
          originChannelId: input.originChannelId,
          responseMode,
        });

        return {
          // `leaving` is a refusal, not a join: the previous call's browser is still
          // being released and nothing was started. Reporting it as a success invites
          // the model to tell the room it has joined a call it is not in — the message
          // says otherwise, but a structured flag is the stronger signal of the two.
          success: result.state !== 'idle' && result.state !== 'leaving',
          state: result.state,
          message: result.message,
        };
      },
    }),

    leave_meeting: tool({
      description:
        'Leave the call you are currently in, whichever platform it is on. ' +
        'There is only ever one, so this needs no arguments.',
      inputSchema: z.object({}),
      execute: async () => {
        const { message } = await meetingBotService.leave();
        return { success: true, message };
      },
    }),

    meeting_speaker: tool({
      description:
        'Find out who is speaking in the call, and who said the thing you are answering. ' +
        'The meeting audio reaches you as one mixed channel with no speaker labels, so this ' +
        'is the only way you can know — but the runtime reads it off the platform, so it is ' +
        'instant and costs nothing. Use it when a name matters: who asked you something, ' +
        'who to answer, who is in the room. It tells you plainly when it cannot say, and ' +
        'when the voice was a group of people sharing one microphone rather than one person.',
      inputSchema: z.object({}),
      execute: async () => ({ success: true, ...meetingBotService.speakerReport() }),
    }),

    meeting_status: tool({
      description:
        'Check whether you are in a call and how it is going, whichever platform it is on: ' +
        'state, which platform, how long, how many times you have spoken or used a tool, and ' +
        'whether you are currently answering everything or only when addressed.',
      inputSchema: z.object({}),
      execute: async () => {
        const status = meetingBotService.status();
        return {
          success: true,
          inMeeting: status.state !== 'idle',
          ...status,
        };
      },
    }),
  };
}
