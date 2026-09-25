/**
 * The instructions for a live voice session, one set per model.
 *
 * The backend gets the agent's own system prompt, from the same pipeline `invoke()` uses,
 * plus how to work behind a voice — so Soul, User, Agent Guide, Memory and Skills all
 * carry over, which is what makes the call the agent rather than a generic assistant
 * wearing its name. The voice gets the agent's name and Soul, so it sounds like the agent,
 * plus how to talk and when to hand over. Conversation history is left out: a call is its
 * own context.
 *
 * Every session owner builds its instructions here, so a meeting and a voice chat differ
 * in what they pass and nowhere else.
 */

import { contextService } from '../context.service';
import { buildSystemPromptParts } from '../../prompts/context-builder';
import { getMeetingBackendInstructions, getMeetingVoiceInstructions } from '../../prompts/meeting-prompt';
import {
  getVoiceChatBackendInstructions,
  getVoiceChatVoiceInstructions,
} from '../../prompts/voice-chat-prompt';

/**
 * Which call the prompt describes.
 *
 * A meeting is a room on a platform. A voice chat is the agent and one client, and what
 * that client gave it decides what its prompt says it has.
 */
export type VoiceCall =
  | { kind: 'meeting'; platform: string }
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
  /** The backend's: the agent's system prompt and how to work behind the voice. */
  backendInstructions: string;
  /** The name the prompt introduces the agent by — the one people in the call will say. */
  agentName: string;
  /** From the same context, so the tool set matches the prompt built beside it. */
  lockedIn: boolean;
}

export async function buildVoiceInstructions(input: VoiceInstructionsInput): Promise<VoiceInstructions> {
  const context = await contextService.getAgentContext(input.userId, {
    agentId: input.agentId,
    includeConversation: false,
  });
  const parts = await buildSystemPromptParts(context, 'meeting');
  const call = input.call;
  const voice =
    call.kind === 'meeting'
      ? getMeetingVoiceInstructions({ agentName: context.agentName, platform: call.platform })
      : getVoiceChatVoiceInstructions({
          agentName: context.agentName,
          computer: call.computer,
          userScreen: call.userScreen,
        });
  const backend =
    call.kind === 'meeting'
      ? getMeetingBackendInstructions({ agentName: context.agentName, platform: call.platform })
      : getVoiceChatBackendInstructions({
          agentName: context.agentName,
          computer: call.computer,
          userScreen: call.userScreen,
        });
  const separator = '\n\n---\n\n';
  return {
    instructions: [`# Identity\n\nYou are **${context.agentName}**.`, `# Soul\n\n${context.soulMd}`, voice].join(separator),
    backendInstructions: [...parts.map((p) => p.text), backend].join(separator),
    agentName: context.agentName,
    lockedIn: context.lockedIn,
  };
}
