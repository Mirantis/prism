import React, { useMemo } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { chatColumnWidth, renderMarkdown, renderMessageParts } from '../markdown.js';
import { TuiMessage } from '../tui-adapter.js';
import type { Viewer } from '../chat-protocol.js';
import { formatFileSize } from '../attachments.js';
import { ChatEntry } from '../transcript.js';
import { parseShellRecord, SHELL_PREFIX } from '../shell-command.js';
import type { TerminalGraphics } from '../images/terminal-graphics.js';
import { DEFAULT_CELL, MAX_IMAGE_ROWS, imageColumns } from '../images/image-size.js';
import { InlineImage } from './inline-image.js';

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
  /** Who this terminal is, undefined until the runtime has said. Anyone else's message shows their name. */
  self: Viewer | undefined;
  entries: ChatEntry[];
  expandedMessageId: string | null;
  graphics: TerminalGraphics;
}

function toolCallSummary(toolCalls: unknown): string | null {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const names = toolCalls
    .map((c) => (c && typeof c === 'object' && 'tool' in c ? String((c as { tool: unknown }).tool) : null))
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return `· used ${toolCalls.length} tool(s)`;
  return `· used ${names.join(', ')}`;
}

/**
 * "You", unless someone else wrote it: another person in the same conversation,
 * or another agent of the project ("{name} · Agent", a notice its sender's name).
 * Until the runtime has said who this terminal is, a person's message is "You" —
 * the runtime stamps ours with our id, and they would otherwise read as someone else's.
 */
function userLabel(message: TuiMessage, self: Viewer | undefined): string {
  if (message.triggeredBy === 'AGENT_MESSAGE') {
    const name = message.senderName ?? message.senderId ?? 'Agent';
    return message.agentMessageKind === 'notice' ? name : `${name} · Agent`;
  }
  if (!self || !message.senderId || message.senderId === self.id) return 'You';
  return message.senderName ?? message.senderId;
}

/** The terminal's size, which the text reflows to and the images fit in. */
interface Screen {
  columns: number;
  rows: number;
  graphics: TerminalGraphics;
}

/**
 * An agent's message: its markdown. In a kitty terminal each image it places is
 * drawn at its place; any other terminal shows the image's description there.
 */
const AgentBody: React.FC<{ message: TuiMessage; screen: Screen }> = ({ message, screen }) => {
  const width = chatColumnWidth(screen.columns);
  const kitty = screen.graphics.protocol === 'kitty';
  const parts = useMemo(
    () => (kitty ? renderMessageParts(message.content, width) : null),
    [kitty, message.content, width],
  );
  const text = useMemo(() => (kitty ? null : renderMarkdown(message.content, width)), [kitty, message.content, width]);
  if (!parts) return <Text>{text}</Text>;
  const maxRows = Math.min(MAX_IMAGE_ROWS, Math.max(4, Math.floor(screen.rows / 2)));
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          // An empty Text takes no row, and a blank line between two images is one.
          <Text key={i}>{part.text || ' '}</Text>
        ) : (
          <InlineImage
            key={i}
            href={part.href}
            alt={part.alt}
            attachments={message.attachments}
            cell={screen.graphics.cell ?? DEFAULT_CELL}
            maxCols={imageColumns(screen.columns)}
            maxRows={maxRows}
          />
        ),
      )}
    </>
  );
};

interface MessageRowProps {
  agentName: string;
  self: Viewer | undefined;
  message: TuiMessage;
  expanded: boolean;
  failed?: string;
  screen: Screen;
}

const MessageRow: React.FC<MessageRowProps> = ({ agentName, self, message, expanded, failed, screen }) => {
  const isUser = message.role === 'USER';
  const isAgent = message.role === 'AGENT';
  const prefixColor = isUser ? 'cyan' : isAgent ? 'magenta' : 'yellow';
  const prefixLabel = isUser
    ? userLabel(message, self)
    : isAgent
      ? agentName
      : message.role;
  const summary = isAgent ? toolCallSummary(message.toolCalls) : null;
  const calls = isAgent && isToolCallArray(message.toolCalls) ? message.toolCalls : [];
  const hasCalls = calls.length > 0;
  const shellRun = isUser ? parseShellRecord(message.content) : null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={prefixColor}>{`▌ ${prefixLabel}`}</Text>
        {message.triggeredBy === 'HEARTBEAT' && <Text dimColor> · heartbeat</Text>}
        {message.triggeredBy === 'CRON_TASK' && <Text dimColor> · cron</Text>}
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        {shellRun ? (
          <>
            <Text bold>{`${SHELL_PREFIX} ${shellRun.command}`}</Text>
            {shellRun.exitCode !== 0 && <Text color="red">{`exit code ${shellRun.exitCode}`}</Text>}
            {shellRun.output && <Text dimColor>{truncate(shellRun.output, 1600)}</Text>}
          </>
        ) : isAgent ? (
          <AgentBody message={message} screen={screen} />
        ) : (
          <Text>{message.content}</Text>
        )}
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

export const MessageList: React.FC<Props> = ({ agentName, self, entries, expandedMessageId, graphics }) => {
  // A resize renders the messages again, so text reflows and images refit to the new width.
  const { columns, rows } = useWindowSize();
  const screen = useMemo(() => ({ columns, rows, graphics }), [columns, rows, graphics]);
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
          self={self}
          message={entry.message}
          expanded={entry.message.id === expandedMessageId}
          failed={entry.failed}
          screen={screen}
        />
      ))}
    </Box>
  );
};
