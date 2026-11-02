// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { CodingAgentSignInBlock } from '@/types';

const { api } = vi.hoisted(() => ({
  api: {
    codingAgents: vi.fn(),
    startCodingAgentSignIn: vi.fn(),
    codingAgentSignIn: vi.fn(),
  },
}));
vi.mock('@/api/runtime-client', () => ({ runtimeApi: api }));

import { ChatCodingAgentSignIn } from './chat-coding-agent-sign-in';

const block: CodingAgentSignInBlock = {
  type: 'coding_agent_sign_in',
  id: '3b241101-e2bb-4255-8caf-4136c566a962',
  agent: 'codex',
  status: 'waiting',
};

function renderCard(item: CodingAgentSignInBlock) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatCodingAgentSignIn block={item} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('ChatCodingAgentSignIn', () => {
  it('asks for the sign-in and starts it', async () => {
    api.codingAgents.mockResolvedValue([]);
    api.startCodingAgentSignIn.mockResolvedValue({
      id: 'attempt-1',
      agent: 'codex',
      status: 'waiting',
      url: 'https://auth.example.com/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      error: null,
    });
    renderCard(block);

    expect(screen.getByLabelText('Coding agent sign-in')).toHaveTextContent('Sign in to ChatGPT for coding tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('dialog', { name: 'Sign in to ChatGPT' })).toBeInTheDocument();
    expect(await screen.findByTestId('coding-agent-user-code')).toHaveTextContent('ABCD-1234');
    expect(api.startCodingAgentSignIn).toHaveBeenCalledExactlyOnceWith('codex');
  });

  it('shows a finished sign-in with nothing to do', () => {
    renderCard({ ...block, agent: 'claude-code', status: 'signed_in' });

    expect(screen.getByRole('status', { name: 'Coding agent sign-in' })).toHaveTextContent('Signed in to Claude');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
