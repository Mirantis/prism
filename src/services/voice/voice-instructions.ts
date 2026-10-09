/**
 * The session instructions for a live voice session: the agent's own system prompt,
 * plus how to behave in a call.
 *
 * Same pipeline `invoke()` uses, so Soul, User, Agent Guide, Memory and Skills all carry
 * over — that is what makes the voice the agent rather than a generic assistant wearing
 * its name. Conversation history is left out: a call is its own context, and a whole
 * thread would bloat a session that pays per audio token. What the agent recorded in
 * the hours before the call opens the session, so a call picks up where the last
 * conversation stopped.
 *
 * Every session owner builds its instructions here, so a meeting and a voice chat differ
 * in what they pass and nowhere else.
 */

import { contextService } from '../context.service';
import {
  buildRecentMemories,
  buildSystemPromptParts,
  recentMemoryContent,
} from '../../prompts/context-builder';
import { getMeetingInstructions } from '../../prompts/meeting-prompt';
import { getVoiceChatInstructions } from '../../prompts/voice-chat-prompt';
import type { ResponseMode } from '../meeting/response-policy';

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
  /**
   * What the agent recorded shortly before the call, in the fenced form a chat turn
   * gets, or null when nothing is recent. It holds text the agent stored from whatever
   * it read, so the session receives it as a user item and never as instructions.
   */
  openingContext: string | null;
}

export async function buildVoiceInstructions(input: VoiceInstructionsInput): Promise<VoiceInstructions> {
  const context = await contextService.getAgentContext(input.userId, {
    agentId: input.agentId,
    includeConversation: false,
  });
  const parts = await buildSystemPromptParts(context, 'meeting');
  // A session reads no history, so it always opens a conversation.
  const recent = await buildRecentMemories(context);
  const call =
    input.call.kind === 'meeting'
      ? getMeetingInstructions({
          agentName: context.agentName,
          platform: input.call.platform,
          responseMode: input.responseMode,
        })
      : getVoiceChatInstructions({
          agentName: context.agentName,
          // A voice chat is never `auto`: that mode resolves from a participant count,
          // and one mixed microphone yields none.
          responseMode: input.responseMode === 'addressed' ? 'addressed' : 'open',
          computer: input.call.computer,
          userScreen: input.call.userScreen,
        });
  return {
    instructions: [parts.map((p) => p.text).join('\n\n---\n\n'), call].join('\n\n---\n\n'),
    agentName: context.agentName,
    lockedIn: context.lockedIn,
    openingContext: recent ? recentMemoryContent(recent.text) : null,
  };
}
