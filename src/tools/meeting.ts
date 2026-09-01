/**
 * Tools for a live voice meeting: joining it, leaving it, the agent's own microphone, and
 * what is happening in the room.
 *
 * All of them are platform-agnostic. The join tool was `join_meeting` first, on the
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
import {
  MEETING_CHAT_MAX_CHARS,
  meetingBotService,
} from '../services/meeting/meeting-bot.service';
import { AUDIO_STACK_BINARIES } from '../services/meeting/audio-stack';
import { isBrowserAvailable } from '../services/meeting/browser-stack';
import { isRealtimeConfigured } from '../services/meeting/openai-endpoint';
import { logger } from '../logger';

/**
 * The two that change which call the agent is in, exported so every autonomous mode can
 * drop them in one place.
 *
 * Only a person in a conversation decides that an agent joins a call or leaves one. A
 * heartbeat, a cron tick or a subagent dialling into a live call with people in it — or
 * hanging up on one — is never what the operator asked for.
 *
 * The other four read the call, set the agent's own microphone, or post one line into it,
 * so every mode keeps them. Asking "am I in a call?" costs nothing, a microphone with no
 * call answers that it has none, and a scheduled run that reports back into the room is
 * why the send is reachable outside a call in the first place.
 */
export const MEETING_MEMBERSHIP_TOOL_NAMES = ['join_meeting', 'leave_meeting'] as const;

export interface MeetingToolsInput {
  userId: string;
  agentId: string;
  /** The calling turn's thread. */
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
        'Returns as soon as the request to join is in; a host must admit you, so call ' +
        'meeting_status to find out whether you got in. Only one call at a time.',
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

    set_microphone: tool({
      description:
        'Turn your own microphone on or off in the call you are in. Off means the ' +
        'participants cannot hear you at all; on uncovers it at the platform, and the reply ' +
        'says whether the room can actually hear you. Use it when somebody asks you to mute, ' +
        'and to turn yourself back on afterwards — you stay muted until you do. It reports ' +
        'the state it read back, so a reply saying the microphone still reads muted means the ' +
        'click did not take and nobody is hearing you.',
      inputSchema: z.object({
        on: z
          .boolean()
          .describe('true turns the microphone on, false turns it off.'),
      }),
      execute: async ({ on }) => meetingBotService.setMicrophone(on),
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

    send_meeting_chat: tool({
      description:
        'Post one short plain-text message into the chat of the call you are in. Use it for ' +
        'what speech mangles: a link, an id, a command to paste. Say the rest out loud — ' +
        `speech is how you talk to the room. At most ${MEETING_CHAT_MAX_CHARS} characters, no ` +
        'formatting, no line breaks, and nobody reads the chat back to you. It needs a live ' +
        'call: with none there is nothing to post into, and it tells you so instead of ' +
        'sending. If it fails, say the content out loud instead of trying again.',
      inputSchema: z.object({
        text: z
          .string()
          .describe(
            'The message, as plain text on one line — usually a link or an identifier with a ' +
            'few words of context.',
          ),
      }),
      execute: async ({ text }) => {
        const { sent, message } = await meetingBotService.sendChatMessage(text, input.userId);
        return { success: sent, message };
      },
    }),

    meeting_status: tool({
      description:
        'Check whether you are in a call and how it is going, whichever platform it is on: ' +
        'state, which platform, how long, how many times you have spoken or used a tool, ' +
        'whether you are currently answering everything or only when addressed, and whether ' +
        'the room can hear you. `isMicLive` is true when it can, false when it cannot, and ' +
        'null when the runtime could not read your microphone at all — worth checking ' +
        'before you take silence from the room to mean nobody is there.',
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
