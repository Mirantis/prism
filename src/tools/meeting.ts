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
import { missingBinary } from '../lib/has-binary';
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

/**
 * The tools that act on the call's screen, dropped by the same modes and for the same
 * reason: what the room is watching is not for an autonomous run to move.
 */
export const MEETING_SCREEN_TOOL_NAMES = [
  'share_screen',
  'stop_screen_share',
  'browse',
  'see_screen',
] as const;

/**
 * Every tool here, which is what a voice chat drops.
 *
 * A voice chat is a call between the agent and one client, not a room: it has no
 * participants to name, no chat panel to post into, and its microphone is the client's
 * own to mute. Each of these would answer that there is no call to act on, so declaring
 * them costs tokens and invites the model to offer what it cannot do.
 */
export const MEETING_TOOL_NAMES = [
  ...MEETING_MEMBERSHIP_TOOL_NAMES,
  ...MEETING_SCREEN_TOOL_NAMES,
  'set_microphone',
  'meeting_speaker',
  'send_meeting_chat',
  'meeting_status',
] as const;

export interface MeetingToolsInput {
  userId: string;
  agentId: string;
  /** The calling turn's thread. */
  threadId?: string;
  /**
   * Whether these tools are being built for the meeting's own model.
   *
   * Only `see_screen` reads it, and only because the picture it takes can be delivered
   * to the model in the call and to nobody else. A chat turn that calls it during a
   * live call gets the page in words instead.
   */
  inMeetingSession?: boolean;
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

  const missing = await missingBinary(...AUDIO_STACK_BINARIES);
  if (missing) {
    logger.info(`[Meeting] Voice meetings unavailable: ${missing} is not on PATH`);
    return false;
  }
  return true;
}

export function getMeetingTools(input: MeetingToolsInput): Record<string, Tool> {
  return {
    join_meeting: tool({
      description:
        'Join a video call as a live voice participant — you will speak and listen in real ' +
        'time. Google Meet links are supported today; the platform is taken from the URL. ' +
        'Returns once the request to join is in, or once the attempt has failed, which it ' +
        'names a step for; a host still has to admit you, so call meeting_status to find out ' +
        'whether you got in. Only one call at a time.',
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
          // Absent unless the join failed short of asking to be let in. It says which
          // part failed — a dead link and a container with no microphone are both
          // "could not join", and only one of them is worth trying again.
          step: result.step,
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

    share_screen: tool({
      description:
        'Start sharing your screen in the call you are in, so the room can see it. Use ' +
        'this tool to show something in the browser or demonstrate UI features of an ' +
        'application. What they see is the whole screen your browser runs on, so open ' +
        'the page with `browse` first — whatever is in front is what shows. It takes ' +
        'several seconds. Stop it with `stop_screen_share`.',
      inputSchema: z.object({}),
      execute: async () => meetingBotService.startScreenShare(),
    }),

    stop_screen_share: tool({
      description:
        'Stop sharing your screen, staying in the call. Says so plainly when you were ' +
        'not sharing anything.',
      inputSchema: z.object({}),
      execute: async () => meetingBotService.stopScreenShare(),
    }),

    browse: tool({
      description:
        'Use a web browser: open a page, click things, type, scroll, and work in several ' +
        'tabs. It runs beside the meeting, on the same screen `share_screen` presents — ' +
        'so this is how you put something in front of the room, and how you look ' +
        'something up on the web in a call. Every command answers with where the page is, ' +
        'what it says, the names of the links, buttons and fields on it, and the list of ' +
        'open tabs. Click and type by those names, and switch tabs by those numbers. ' +
        'One command per call, and only while you are in a meeting.',
      inputSchema: z.object({
        action: z
          .enum([
            'navigate',
            'click',
            'type',
            'press',
            'scroll',
            'read',
            'new_tab',
            'switch_tab',
            'close_tab',
          ])
          .describe(
            '"navigate" opens a URL in the tab you are in, "click" presses something, ' +
            '"type" enters text, "press" sends one key (Enter, Escape, PageDown), ' +
            '"scroll" moves the page, "read" just reports where you are. "new_tab" opens ' +
            'another tab (pass a url to land on a page), "switch_tab" moves to a tab by ' +
            'number, "close_tab" closes one. The tab you are in is the tab the room sees.',
          ),
        url: z
          .string()
          .optional()
          .describe('For "navigate", and for a "new_tab" that should open a page.'),
        tab: z
          .number()
          .optional()
          .describe(
            'For "switch_tab" and "close_tab": the tab number from the last answer. ' +
            '"close_tab" without one closes the tab you are in.',
          ),
        target: z
          .string()
          .optional()
          .describe(
            'For "click", and optionally for "type": the words on the link, button or ' +
            'field, as they came back in the last reading. A CSS selector also works.',
          ),
        text: z.string().optional().describe('For "type": what to enter.'),
        key: z.string().optional().describe('For "press": the key name, e.g. Enter.'),
        amount: z
          .number()
          .optional()
          .describe('For "scroll": pixels to scroll, negative to go up. Defaults to 600.'),
      }),
      execute: async (command) => meetingBotService.browse(command),
    }),

    see_screen: tool({
      description:
        'See what your screen is showing right now — a picture of it, plus the text ' +
        'and controls of the page. This is the same screen the room sees while you are ' +
        'sharing, so use it to check that what you meant to show is up, to find your way ' +
        'around a page `browse` reported oddly, or to answer a question about what is on ' +
        'screen. Takes a couple of seconds.',
      inputSchema: z.object({}),
      execute: async () => meetingBotService.lookAtScreen({ toSession: input.inMeetingSession }),
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
