import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { renderMarkdown } from '../markdown.js';
import { TuiMessage } from '../tui-adapter.js';
import { formatFileSize } from '../attachments.js';
import { ChatEntry } from '../transcript.js';

/** Mirrors `ToolOutputTruncation` in the runtime's src/types.ts. */
interface ToolOutputTruncation {
  totalChars: number;
  keptChars: number;
  omittedChars: number;
}

interface ToolCall {
  tool: string;
  input: string;
  /** The model-facing view of the result, which is what was stored. */
  output: string;
  success: boolean;
  timestamp: string;
  /** Present only when that view was cut. */
  truncated?: ToolOutputTruncation;
}

function isToolCallArray(x: unknown): x is ToolCall[] {
  return (
    Array.isArray(x) &&
    x.every(
      (c) =>
        c !== null &&
        typeof c === 'object' &&
        'tool' in (c as object) &&
        'input' in (c as object) &&
        'output' in (c as object),
    )
  );
}

function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return String(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (truncated ${s.length - max} more chars)`;
}

interface Props {
  agentName: string;
  /** The name the runtime gave this connection. A USER message by anyone else is labelled with its sender. */
  selfName: string | null;
  entries: ChatEntry[];
  expandedMessageId: string | null;
}

function toolCallSummary(toolCalls: unknown): string | null {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const names = toolCalls
    .map((c) => (c && typeof c === 'object' && 'tool' in c ? String((c as { tool: unknown }).tool) : null))
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return `· used ${toolCalls.length} tool(s)`;
  return `· used ${names.join(', ')}`;
}

/** "You", unless someone else wrote it: another person in the same conversation. */
function userLabel(senderName: string | null | undefined, selfName: string | null): string {
  if (!senderName || senderName === selfName) return 'You';
  return senderName;
}

interface MessageRowProps {
  agentName: string;
  selfName: string | null;
  message: TuiMessage;
  expanded: boolean;
  failed?: string;
}

const MessageRow: React.FC<MessageRowProps> = ({ agentName, selfName, message, expanded, failed }) => {
  const isUser = message.role === 'USER';
  const isAgent = message.role === 'AGENT';
  const prefixColor = isUser ? 'cyan' : isAgent ? 'magenta' : 'yellow';
  const prefixLabel = isUser
    ? userLabel(message.senderName, selfName)
    : isAgent
      ? agentName
      : message.role;
  const summary = isAgent ? toolCallSummary(message.toolCalls) : null;
  const body = isAgent ? renderMarkdown(message.content) : message.content;
  const calls = isAgent && isToolCallArray(message.toolCalls) ? message.toolCalls : [];
  const hasCalls = calls.length > 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={prefixColor}>{`▌ ${prefixLabel}`}</Text>
        {message.triggeredBy === 'HEARTBEAT' && <Text dimColor> · heartbeat</Text>}
        {message.triggeredBy === 'CRON_TASK' && <Text dimColor> · cron</Text>}
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        <Text>{body}</Text>
        {failed && <Text color="red">{`✗ not sent: ${failed}`}</Text>}
        {Array.isArray(message.attachments) && message.attachments.length > 0 && (
          <Text dimColor>
            {message.attachments
              .map(
                (a) =>
                  `· 📎 ${a.filename} (${a.expired ? 'expired' : formatFileSize(a.sizeBytes)})`,
              )
              .join(' ')}
            {isAgent ? '  · /save to download' : ''}
          </Text>
        )}
        {summary && (
          <Text dimColor>
            {summary}
            {hasCalls && (expanded ? '  · ctrl+o to collapse' : '  · ctrl+o to expand')}
          </Text>
        )}
        {hasCalls && expanded && (
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            {calls.map((c, i) => (
              <Box key={i} flexDirection="column" marginBottom={1}>
                <Text bold color={c.success ? 'green' : 'red'}>
                  {c.success ? '✓' : '✗'} {c.tool}
                </Text>
                <Text dimColor>input</Text>
                <Text>{truncate(c.input, 1200)}</Text>
                <Text dimColor>
                  output
                  {c.truncated
                    ? ` (cut — ${c.truncated.keptChars} of ${c.truncated.totalChars} chars)`
                    : ''}
                </Text>
                <Text>{truncate(c.output, 1600)}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
};

export const MessageList: React.FC<Props> = ({ agentName, selfName, entries, expandedMessageId }) => {
  // Only render the most recent N entries — the parent <Box> is bound by the
  // terminal height anyway, but limiting keeps re-render cost low for long
  // sessions.
  const visible = useMemo(() => entries.slice(-50), [entries]);

  return (
    <Box flexDirection="column">
      {visible.map((entry) => (
        <MessageRow
          key={entry.message.id}
          agentName={agentName}
          selfName={selfName}
          message={entry.message}
          expanded={entry.message.id === expandedMessageId}
          failed={entry.failed}
        />
      ))}
    </Box>
  );
};
