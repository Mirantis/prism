/**
 * The instructions for a live voice session: the voice's, and the rules its backend runs
 * add to the agent's system prompt.
 *
 * Each backend run is an ordinary `voice` invoke, so it gets the agent's own system prompt
 * — Soul, User, Agent Guide, Memory, Skills — and these rules on top, which say how to
 * work behind a voice. The voice gets the agent's name and Soul, so it sounds like the
 * agent, plus how to talk and when to hand over.
 *
 * Every session owner builds its instructions here, so a call and a voice chat differ in
 * what they pass and nowhere else.
 */

import { contextService } from '../context.service';
import { getCallBackendInstructions, getCallVoiceInstructions } from '../../prompts/call-prompt';
import {
  getVoiceChatBackendInstructions,
  getVoiceChatVoiceInstructions,
} from '../../prompts/voice-chat-prompt';

/**
 * Which call the prompt describes.
 *
 * A call is a room in an app on the agent's computer. A voice chat is the agent and one
 * client, and what that client gave it decides what its prompt says it has.
 */
export type VoiceCall =
  | {
      kind: 'call';
      /** The program the call runs in, as the desktop names it. */
      app: string;
      /** The size of the picture `computer_screen` gives of the desktop. */
      desktop: { width: number; height: number };
    }
  | {
      kind: 'voice-chat';
      /** The computer the session opened, and the desktop around it where there is one. */
      computer: { desktop: { width: number; height: number } | null } | null;
      /** Whether this client can share its own screen with the agent. */
      userScreen: boolean;
    };

export interface VoiceInstructionsInput {
  userId: string;
  agentId: string;
  call: VoiceCall;
}

export interface VoiceInstructions {
  /** The voice model's. */
  instructions: string;
  /** The backend runs' session rules, which `invoke()` appends to the system prompt. */
  sessionInstructions: string;
}

export async function buildVoiceInstructions(input: VoiceInstructionsInput): Promise<VoiceInstructions> {
  const context = await contextService.getAgentContext(input.userId, {
    agentId: input.agentId,
    includeConversation: false,
  });
  const call = input.call;
  const voice =
    call.kind === 'call'
      ? getCallVoiceInstructions({ agentName: context.agentName, app: call.app, desktop: call.desktop })
      : getVoiceChatVoiceInstructions({
          agentName: context.agentName,
          computer: call.computer,
          userScreen: call.userScreen,
        });
  const backend =
    call.kind === 'call'
      ? getCallBackendInstructions({ agentName: context.agentName, app: call.app, desktop: call.desktop })
      : getVoiceChatBackendInstructions({
          agentName: context.agentName,
          computer: call.computer,
          userScreen: call.userScreen,
        });
  const separator = '\n\n---\n\n';
  return {
    instructions: [`# Identity\n\nYou are **${context.agentName}**.`, `# Soul\n\n${context.soulMd}`, voice].join(separator),
    sessionInstructions: backend,
  };
}
