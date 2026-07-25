import React from 'react';
import { Box, Text } from 'ink';
import { TuiStatus } from '../tui-adapter.js';

interface Props {
  modelId: string;
  status: TuiStatus;
  detail?: string;
}

// Map Bedrock model IDs like "us.anthropic.claude-opus-4-7",
// "us.anthropic.claude-opus-5" or "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
// to a short display name (e.g. "Opus 4.7", "Opus 5", "Sonnet 4.5"). The minor
// version is optional so ids without one ("claude-opus-5") render as just
// "Opus 5". The minor is bounded to 1-2 digits followed by a delimiter so a
// trailing date on a minor-less id ("claude-opus-5-20251001-v1:0") isn't
// mistaken for the minor version. Falls back to the raw id when the pattern
// doesn't match — keeps the status bar honest for unknown / non-Claude models.
function prettifyModelId(id: string): string {
  const m = id.match(/claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?=-|$))?/);
  if (!m) return id;
  const [, family, major, minor] = m;
  const titled = family.charAt(0).toUpperCase() + family.slice(1);
  return minor ? `${titled} ${major}.${minor}` : `${titled} ${major}`;
}

export const StatusBar: React.FC<Props> = ({ modelId, status, detail }) => {
  return (
    <Box marginTop={1} justifyContent="space-between">
      <Box>
        <Text color="#7c3aed">{prettifyModelId(modelId)}</Text>
      </Box>
      <Box>
        {status === 'error' && (
          <Text color="red">
            ● error{detail ? `: ${detail}` : ''}
          </Text>
        )}
      </Box>
    </Box>
  );
};
