import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { renderMarkdown } from '../markdown.js';
import { TuiMessage } from '../tui-adapter.js';

export type ChatEntry = { kind: 'message'; message: TuiMessage };

interface ToolCall {
  tool: string;
  input: string;
  output: string;
  success: boolean;
  timestamp: string;
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

interface MessageRowProps {
  agentName: string;
  message: TuiMessage;
  expanded: boolean;
}

const MessageRow: React.FC<MessageRowProps> = ({ agentName, message, expanded }) => {
  const isUser = message.role === 'USER';
  const isAgent = message.role === 'AGENT';
  const prefixColor = isUser ? 'cyan' : isAgent ? 'magenta' : 'yellow';
  const prefixLabel = isUser ? 'You' : isAgent ? agentName : message.role;
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
                <Text dimColor>output</Text>
                <Text>{truncate(c.output, 1600)}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
};

export const MessageList: React.FC<Props> = ({ agentName, entries, expandedMessageId }) => {
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
          message={entry.message}
          expanded={entry.message.id === expandedMessageId}
        />
      ))}
    </Box>
  );
};
