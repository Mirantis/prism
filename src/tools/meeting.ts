/**
 * Tools for joining and leaving live voice meetings.
 *
 * The join tool is named per platform (`join_google_meet`) rather than generically:
 * a Teams or Zoom provider would add its own, and a single `join_meeting` taking a
 * URL would leave the model guessing which platforms are actually supported. Leave
 * and status are generic because there is only ever one active call, whatever it
 * runs on.
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
 * A live call keeps them: `join_google_meet` inside a meeting harmlessly reports
 * that it is already in one, and `leave_meeting`/`meeting_status` are how the
 * agent ends and inspects the call it is in.
 */
export const MEETING_TOOL_NAMES = ['join_google_meet', 'leave_meeting', 'meeting_status'] as const;

export interface MeetingToolsInput {
  userId: string;
  agentId: string;
  /** Where join progress is reported; the calling turn's thread. */
  threadId?: string;
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
  const pathEntries = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const binary of AUDIO_STACK_BINARIES) {
    const found = await Promise.all(
      pathEntries.map(async (dir) => {
        try {
          await fs.access(`${dir}/${binary}`);
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
    join_google_meet: tool({
      description:
        'Join a Google Meet call as a live voice participant — you will speak and listen in ' +
        'real time. Returns as soon as the request to join is in; a host must admit you, and ' +
        'progress is reported in this conversation. Only one call at a time.',
      inputSchema: z.object({
        url: z.string().describe('The Google Meet link, e.g. https://meet.google.com/abc-defg-hij'),
        displayName: z
          .string()
          .optional()
          .describe('Name shown to the other participants. Defaults to your own name.'),
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
      execute: async ({ url, displayName, responseMode }) => {
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
          displayName,
          responseMode,
        });

        return {
          success: result.state !== 'idle',
          state: result.state,
          message: result.message,
        };
      },
    }),

    leave_meeting: tool({
      description: 'Leave the meeting call you are currently in.',
      inputSchema: z.object({}),
      execute: async () => {
        const { message } = await meetingBotService.leave();
        return { success: true, message };
      },
    }),

    meeting_status: tool({
      description:
        'Check whether you are in a meeting call, and how it is going (state, how long, ' +
        'how many times you have spoken or used a tool, and whether you are currently ' +
        'answering everything or only when addressed).',
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
