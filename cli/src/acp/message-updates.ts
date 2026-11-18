/** A stored Prism message as the ACP session updates that show it. */

import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk';
import type { TuiMessage } from '../tui-adapter.js';

/** One tool call of an agent message, as the runtime stores it. `input` is the call's arguments as JSON. */
interface ToolCallRecord {
  tool: string;
  input: string;
  output: string;
  success: boolean;
}

/**
 * A message's tool calls, which ran before its text, then the text, then a link
 * to each file the message holds. `attachmentUrl` says where a file downloads.
 */
export function messageUpdates(message: TuiMessage, attachmentUrl: (attachmentId: string) => string): SessionUpdate[] {
  const text: ContentBlock[] = message.content ? [{ type: 'text', text: message.content }] : [];
  const files: ContentBlock[] = (message.attachments ?? [])
    // The runtime deletes a file's bytes after its retention time, and its link would then fail.
    .filter((file) => !file.expired)
    .map((file) => ({
      type: 'resource_link',
      uri: attachmentUrl(file.id),
      name: file.filename,
      mimeType: file.mediaType,
      size: file.sizeBytes,
    }));
  const calls = Array.isArray(message.toolCalls) ? (message.toolCalls as ToolCallRecord[]) : [];
  return [
    ...calls.map((call, index) => toolCallUpdate(message.id, index, call)),
    ...[...text, ...files].map(
      (content): SessionUpdate => ({
        sessionUpdate: message.role === 'USER' ? 'user_message_chunk' : 'agent_message_chunk',
        messageId: message.id,
        content,
      }),
    ),
  ];
}

function toolCallUpdate(messageId: string, index: number, call: ToolCallRecord): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: `${messageId}:${index}`,
    title: call.tool,
    status: call.success ? 'completed' : 'failed',
    rawInput: JSON.parse(call.input),
    content: [{ type: 'content', content: { type: 'text', text: call.output } }],
  };
}
