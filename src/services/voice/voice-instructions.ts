/**
 * The session instructions for a live voice session: the agent's own system prompt,
 * plus how to behave in a call.
 *
 * Same pipeline `invoke()` uses, so Soul, User, Agent Guide, Memory and Skills all carry
 * over — that is what makes the voice the agent rather than a generic assistant wearing
 * its name. A voice chat opens with the end of the text conversation it continues, in
 * words only, since the session pays per token. What the agent recorded in the hours
 * before the call follows it, so a call picks up where the last conversation stopped.
 *
 * Every session owner builds its instructions here, so a meeting and a voice chat differ
 * in what they pass and nowhere else.
 */

import { ThreadSource } from '@prisma/client';
import { contextService } from '../context.service';
import { conversationService } from '../conversation.service';
import {
  buildRecentMemories,
  buildSystemPromptParts,
  recentMemoryContent,
} from '../../prompts/context-builder';
import { getMeetingInstructions } from '../../prompts/meeting-prompt';
import { getVoiceChatInstructions } from '../../prompts/voice-chat-prompt';
import { voiceHistoryContent } from '../../prompts/voice-history';
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
      /** The conversation the call continues, already resolved for the thread mode. */
      threadId?: string;
      /** Whether the call's summary is stored in that conversation when it ends. */
      summarized?: boolean;
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
   * The end of the conversation a voice chat continues, then what the agent recorded
   * shortly before the call, each fenced, or null when there is neither. Both hold text
   * from outside the prompt, so the session receives them as a user item and never as
   * instructions.
   */
  openingContext: string | null;
}

export async function buildVoiceInstructions(input: VoiceInstructionsInput): Promise<VoiceInstructions> {
  const context = await contextService.getAgentContext(input.userId, {
    agentId: input.agentId,
    includeConversation: false,
  });
  const parts = await buildSystemPromptParts(context, 'meeting');
  // The context holds no conversation, so the recent memories are always offered.
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
          conversation: input.call.threadId !== undefined,
          summary: input.call.summarized === true,
        });
  const history = input.call.kind === 'voice-chat' && input.call.threadId
    ? await conversationHistory(input.call.threadId)
    : null;
  const opening = [history, recent ? recentMemoryContent(recent.text) : null].filter((part) => part !== null);
  return {
    instructions: [parts.map((p) => p.text).join('\n\n---\n\n'), call].join('\n\n---\n\n'),
    agentName: context.agentName,
    lockedIn: context.lockedIn,
    openingContext: opening.length > 0 ? opening.join('') : null,
  };
}

async function conversationHistory(threadId: string): Promise<string | null> {
  const thread = await conversationService.getThreadContext(threadId);
  return voiceHistoryContent({
    compactionSummary: thread.compactionSummary,
    messages: thread.messages,
    historyReadable: thread.threadSource === ThreadSource.DATABASE,
  });
}
