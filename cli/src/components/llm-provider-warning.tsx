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
    <Box borderStyle="round" borderColor="yellow" paddingX={2} marginBottom={1} flexDirection="column">
      <Text color="yellow" bold>
        ⚠ No LLM provider is configured
      </Text>
      <Text>
        The agent cannot answer messages. Set {status.missingSettings.join(' and ')} for the{' '}
        {status.provider} provider, or choose another provider with LLM_PROVIDER, then restart
        Prism.
      </Text>
    </Box>
  );
};
