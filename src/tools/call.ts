/**
 * Tools for a live voice call on the agent's computer: connecting its voice to the call,
 * and ending that.
 *
 * The call itself is the call app's. The agent joins it with the computer tools, in a
 * browser tab or in an installed client, and uses the app's own controls for mute, chat,
 * screen share and hang-up. These two tools only connect and disconnect the voice, so
 * they work the same in every app.
 *
 * Registered only where a call can run: the computer's desktop and a voice credential.
 * Both are fixed at startup, so the tools block stays byte-identical across requests.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import { callService } from '../services/call/call.service';
import { isRealtimeConfigured } from '../services/meeting/openai-endpoint';
import { hasComputer } from '../services/computer/supported';

export const JOIN_CALL_TOOL_NAME = 'join_call';
export const LEAVE_CALL_TOOL_NAME = 'leave_call';

/**
 * Both call tools. A voice chat drops them, and so do the modes whose trigger is not the
 * user's own intent; see `filterToolsByMode`.
 */
export const CALL_TOOL_NAMES = [JOIN_CALL_TOOL_NAME, LEAVE_CALL_TOOL_NAME] as const;

export interface CallToolsInput {
  userId: string;
  agentId: string;
  /** The calling turn's thread. */
  threadId?: string;
}

/** Whether this host can carry a call: a computer with its desktop, and a voice. */
export function isCallSupported(): boolean {
  return isRealtimeConfigured() && hasComputer();
}

export function getCallTools(input: CallToolsInput): Record<string, Tool> {
  return {
    [JOIN_CALL_TOOL_NAME]: tool({
      description:
        'Take part by voice in the call that is running on your computer: you will hear the ' +
        'call and speak in it in real time. Get into the call first with the computer tools, ' +
        'in whatever app it runs in — open the link in your browser, or the installed app; ' +
        'turn the camera off; press join. Then call this at once, also while you wait in a ' +
        'lobby to be let in: your voice listens and waits until it hears people, so there is ' +
        'no need to wait for admission or to check back later. It ' +
        'reports whether the call app is using your microphone (`micCaptured`); when it is ' +
        'not, nobody hears you, so unmute in the app or choose PrismMicrophone there. Only ' +
        'one call at a time.',
      inputSchema: z.object({}),
      execute: async () => callService.join({ userId: input.userId, agentId: input.agentId }),
    }),

    [LEAVE_CALL_TOOL_NAME]: tool({
      description:
        'Stop taking part by voice in the call on your computer. This does not hang up: ' +
        "press the call app's leave or hang-up button with the computer tools first.",
      inputSchema: z.object({}),
      execute: async () => callService.leave(),
    }),
  };
}
