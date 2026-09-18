/**
 * The username and password for a sign-in the agent asked for.
 *
 * What is typed here goes to the runtime, which enters it in the agent's browser and
 * submits the form. The agent is stopped while that happens and is given neither value,
 * and nothing is written to the conversation.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';
import { ApiClient, ApiError } from '../api-client.js';

export interface SignInRequest {
  id: string;
  reason: string;
  /** Where the credentials are typed, when the runtime named it. */
  site?: string;
}

interface Props {
  api: ApiClient;
  request: SignInRequest;
  onClose: () => void;
}

export const SignInPanel: React.FC<Props> = ({ api, request, onClose }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [focusedField, setFocusedField] = useState<0 | 1>(0);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!password) {
      setErrorMsg('A password is required.');
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await api.signInForComputer(request.id, { username, password });
      setUsername('');
      setPassword('');
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  useInput((_input, key) => {
    if (submitting) return;
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.tab || key.upArrow || key.downArrow) setFocusedField((field) => (field === 0 ? 1 : 0));
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Prism needs a sign-in
      </Text>
      <Text>{request.reason}</Text>
      <Box marginTop={1}>
        <Box width={12}>
          <Text color={focusedField === 0 ? 'cyan' : undefined} bold={focusedField === 0}>
            Username
          </Text>
        </Box>
        <TextInput
          key={focusedField === 0 ? 'username-active' : 'username'}
          value={username}
          onChange={setUsername}
          focus={focusedField === 0 && !submitting}
        />
      </Box>
      <Box>
        <Box width={12}>
          <Text color={focusedField === 1 ? 'cyan' : undefined} bold={focusedField === 1}>
            Password
          </Text>
        </Box>
        <TextInput
          key={focusedField === 1 ? 'password-active' : 'password'}
          value={password}
          onChange={setPassword}
          focus={focusedField === 1 && !submitting}
          mask="•"
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {request.site
            ? `Prism types these into ${request.site} and signs in. It never sees them.`
            : 'Prism types these into the page it is on and signs in. It never sees them.'}
        </Text>
      </Box>
      {errorMsg && <Text color="red">{errorMsg}</Text>}
      <Box marginTop={1}>
        <Text dimColor>
          {submitting ? 'signing in…' : 'tab to move · enter to sign in · esc to close'}
        </Text>
      </Box>
    </Box>
  );
};
