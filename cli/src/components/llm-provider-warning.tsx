import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { ApiClient, LlmProviderStatus } from '../api-client.js';

interface Props {
  api: Pick<ApiClient, 'getLlmProvider'>;
}

/**
 * Shown under the header while the LLM provider lacks a setting, because the
 * agent cannot answer until it has one. Asked once, when the session starts.
 */
export const LlmProviderWarning: React.FC<Props> = ({ api }) => {
  const [status, setStatus] = useState<LlmProviderStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getLlmProvider()
      .then((answer) => {
        if (!cancelled) setStatus(answer);
      })
      .catch(() => {
        // A runtime that cannot answer shows no warning; chat reports its own errors.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!status || status.missingSettings.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="yellow"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={2}
      marginBottom={1}
    >
      <Text bold color="yellow">Connect a model provider</Text>
      <Text>Your agent needs a provider connection to reply.</Text>
      <Box flexDirection="column" marginY={1}>
        <Text>Required for <Text bold>{status.provider}</Text></Text>
        {status.missingSettings.map((setting) => (
          <Text key={setting} bold>{setting}</Text>
        ))}
      </Box>
      <Text dimColor>Switch providers with LLM_PROVIDER. Restart Prism after editing environment variables.</Text>
    </Box>
  );
};
