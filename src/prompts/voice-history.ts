/**
 * The text conversation a voice call continues, as the user item that opens the call.
 *
 * Only the words are sent: a call pays per token and speaks, so tool calls and their
 * results stay in the thread. The newest messages are kept, each one cut, so the item
 * stays at a few thousand tokens however long the thread is.
 */

import { COMPACTED_HISTORY_TOOL_NAME } from '../tools/conversation-history';
import { breakTag, type ConversationMessage } from './context-builder';

const TAG = 'conversation-so-far';

/** Messages from the end of the thread. With the cut below, about 5,000 tokens at most. */
export const VOICE_HISTORY_MESSAGES = 20;

/** Each message is cut to this many characters, from its start. */
export const VOICE_HISTORY_MESSAGE_CHARS = 1_000;

/** The compaction summary is cut to this many characters, from its end, which is the newest part. */
export const VOICE_HISTORY_SUMMARY_CHARS = 8_000;

export interface VoiceHistoryInput {
  compactionSummary: string | null;
  messages: ConversationMessage[];
  /** Whether `read_compacted_history` can read this thread's compacted messages. */
  historyReadable: boolean;
}

/** The fenced block, or null when the thread holds nothing to continue. */
export function voiceHistoryContent(input: VoiceHistoryInput): string | null {
  const lines = input.messages
    .filter((m) => !m.internalStep && m.role !== 'SYSTEM' && m.content.trim() !== '')
    .slice(-VOICE_HISTORY_MESSAGES)
    .map((m) => `${m.role === 'USER' ? 'User' : 'Agent'}: ${cutEnd(m.content.trim(), VOICE_HISTORY_MESSAGE_CHARS)}`);
  const summary = input.compactionSummary?.trim() || null;
  if (lines.length === 0 && summary === null) return null;

  const lookup = summary !== null && input.historyReadable
    ? ` ${COMPACTED_HISTORY_TOOL_NAME} reads the summarized messages word for word.`
    : '';
  const body = [
    summary === null ? null : `Earlier, summarized:\n${cutStart(summary, VOICE_HISTORY_SUMMARY_CHARS)}`,
    lines.length === 0 ? null : lines.join('\n\n'),
  ].filter((part): part is string => part !== null).join('\n\n');
  return `<${TAG}>\nYour text conversation with your user before this call, newest last.${lookup}\n\n${breakTag(body, TAG)}\n</${TAG}>`;
}

function cutEnd(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function cutStart(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}
