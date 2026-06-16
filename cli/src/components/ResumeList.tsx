import React, { useState } from 'react';
import path from 'node:path';
import { Box, Text, useInput } from 'ink';
import { ThreadSummary } from '../tui-adapter.js';
import { formatRelativeTime } from '../relative-time.js';

interface Props {
  sessions: ThreadSummary[];
  /** The directory `prism --resume` was launched from, shown for context. */
  cwd: string;
  onSelect: (threadId: string) => void;
  onCancel: () => void;
}

// At most 5 rows on screen at once; the list scrolls (windows) past that.
const MAX_VISIBLE = 5;

// "<basename> (<branch>)" when the thread has a workspace root + branch,
// "<basename>" when only the root is known, "" when neither.
function describeWorkspace(session: ThreadSummary): string {
  if (!session.workspaceRoot) return '';
  const base = path.basename(session.workspaceRoot);
  return session.branch ? `${base} (${session.branch})` : base;
}

export const ResumeList: React.FC<Props> = ({ sessions, cwd, onSelect, onCancel }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(sessions.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const session = sessions[selectedIndex];
      if (session) onSelect(session.id);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  // Window the list around the selection so the highlighted row stays on
  // screen when there are more than MAX_VISIBLE sessions (same approach as
  // CommandPopup).
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(MAX_VISIBLE / 2)),
    Math.max(0, sessions.length - MAX_VISIBLE),
  );
  const visible = sessions.slice(start, start + MAX_VISIBLE);
  const divider = '─'.repeat(process.stdout.columns ?? 80);

  return (
    <Box flexDirection="column">
      <Text dimColor>{divider}</Text>
      <Box paddingX={2} flexDirection="column">
        <Text>
          Resume session ({selectedIndex + 1} of {sessions.length})
        </Text>
        <Text dimColor>
          {'  '}
          {cwd}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {visible.map((session, i) => {
            const selected = start + i === selectedIndex;
            const workspace = describeWorkspace(session);
            return (
              <Box key={session.id} flexDirection="column" marginBottom={1}>
                <Text color={selected ? 'cyan' : undefined} bold={selected}>
                  {selected ? '❯ ' : '  '}
                  {session.id}
                </Text>
                <Text dimColor>
                  {'  '}
                  {formatRelativeTime(session.updatedAt)}
                  {workspace ? ` · ${workspace}` : ''}
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
};
