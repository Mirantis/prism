/**
 * The session instructions for a live voice session: the agent's own system prompt,
 * plus how to behave in a call.
 *
 * Same pipeline `invoke()` uses, so Soul, User, Agent Guide, Memory and Skills all carry
 * over — that is what makes the voice the agent rather than a generic assistant wearing
 * its name. Conversation history is left out: a call is its own context, and a whole
 * thread would bloat a session that pays per audio token.
 *
 * Both session owners build their instructions here, so a meeting and a browser voice
 * chat differ in the two values they pass and nowhere else.
 */

import { contextService } from '../context.service';
import { buildSystemPromptParts } from '../../prompts/context-builder';
import { getMeetingInstructions } from '../../prompts/meeting-prompt';
import type { ResponseMode } from '../meeting/response-policy';

export interface VoiceInstructionsInput {
  userId: string;
  agentId: string;
  /** How the prompt names the call: the meeting platform, or plain voice. */
  platform: string;
  responseMode: ResponseMode;
}

export interface VoiceInstructions {
  instructions: string;
  /**
   * The name the prompt introduces the agent by, handed back so the caller can give the
   * same one to the gate that decides whether the agent was called — the room hears this
   * one, so it is the one people will actually say.
   */
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
  const instructions = [
    parts.map((p) => p.text).join('\n\n---\n\n'),
    getMeetingInstructions({
      agentName: context.agentName,
      platform: input.platform,
      responseMode: input.responseMode,
    }),
  ].join('\n\n---\n\n');
  return { instructions, agentName: context.agentName, lockedIn: context.lockedIn };
}
