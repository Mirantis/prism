import React from 'react';
import { Box, Text } from 'ink';
import { TuiStatus } from '../tui-adapter.js';

interface Props {
  modelId: string;
  status: TuiStatus;
  detail?: string;
}

// Map Bedrock model IDs like "us.anthropic.claude-opus-4-7" or
// "us.anthropic.claude-sonnet-4-5-20250929-v1:0" to a short display name
// (e.g. "Opus 4.7", "Sonnet 4.5"). Falls back to the raw id when the pattern
// doesn't match — keeps the status bar honest for unknown / non-Claude models.
function prettifyModelId(id: string): string {
  const m = id.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (!m) return id;
  const [, family, major, minor] = m;
  const titled = family.charAt(0).toUpperCase() + family.slice(1);
  return `${titled} ${major}.${minor}`;
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
