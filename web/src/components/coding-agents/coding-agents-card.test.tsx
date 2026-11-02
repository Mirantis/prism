// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { CodingAgentSignIn, CodingAgentSummary } from '@/types';

const { api } = vi.hoisted(() => ({
  api: {
    codingAgents: vi.fn(),
    startCodingAgentSignIn: vi.fn(),
    codingAgentSignIn: vi.fn(),
    sendClaudeSignInCode: vi.fn(),
    signOutCodingAgent: vi.fn(),
  },
}));
vi.mock('@/api/runtime-client', () => ({ runtimeApi: api }));

import { CodingAgentsCard } from './coding-agents-card';

const claude: CodingAgentSummary = {
  agent: 'claude-code',
  name: 'Claude Code',
  available: true,
  subscription: false,
  account: null,
  attempt: null,
};
const codex: CodingAgentSummary = { ...claude, agent: 'codex', name: 'Codex' };

const waiting: CodingAgentSignIn = {
  id: 'attempt-1',
  agent: 'claude-code',
  status: 'waiting',
  url: 'https://claude.example.com/oauth/authorize',
  userCode: null,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  error: null,
};

function renderCard(props: Parameters<typeof CodingAgentsCard>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CodingAgentsCard {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('CodingAgentsCard', () => {
  it('says what each coding agent runs on, with the action that changes it', async () => {
    api.codingAgents.mockResolvedValue([
      claude,
      { ...codex, available: false },
    ]);
    renderCard();

    const claudeRow = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(claudeRow).toHaveTextContent("Uses the deployment's models");
    expect(within(claudeRow).getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    const codexRow = screen.getByRole('listitem', { name: 'Codex' });
    expect(codexRow).toHaveTextContent('Not available on this agent');
    expect(within(codexRow).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the subscription a coding agent is signed in to, and one that was signed out', async () => {
    api.codingAgents.mockResolvedValue([
      { ...claude, subscription: true, account: { plan: 'Claude Max', email: 'sam@example.com' } },
      { ...codex, subscription: true },
    ]);
    renderCard();

    const claudeRow = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(claudeRow).toHaveTextContent('Your Claude Max · sam@example.com');
    expect(within(claudeRow).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    const codexRow = screen.getByRole('listitem', { name: 'Codex' });
    expect(codexRow).toHaveTextContent('Signed out. Coding tasks fail until you sign in again.');
    expect(within(codexRow).getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('links the terms that limit a subscription to its subscriber', async () => {
    api.codingAgents.mockResolvedValue([claude, codex]);
    renderCard();

    expect(await screen.findByRole('link', { name: "Anthropic's" })).toHaveAttribute(
      'href',
      'https://code.claude.com/docs/en/legal-and-compliance',
    );
    expect(screen.getByRole('link', { name: "OpenAI's" })).toHaveAttribute(
      'href',
      'https://openai.com/policies/row-terms-of-use/',
    );
    expect(screen.getByText(/only on an agent nobody else uses/)).toHaveTextContent(
      "Use your own Claude or ChatGPT subscription only on an agent nobody else uses. Anthropic's and OpenAI's terms let only the subscriber use it, and a shared agent can get your account blocked.",
    );
  });

  it('signs out after the person confirms', async () => {
    const signedIn = { ...claude, subscription: true, account: { plan: 'Claude Max', email: 'sam@example.com' } };
    api.codingAgents.mockResolvedValue([signedIn, codex]);
    api.signOutCodingAgent.mockResolvedValue(claude);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Sign out of Claude?' });
    expect(confirm).toHaveTextContent("Coding tasks go back to the deployment's models.");
    fireEvent.click(within(confirm).getByRole('button', { name: 'Sign out' }));

    await waitFor(() =>
      expect(screen.getByRole('listitem', { name: 'Claude Code' })).toHaveTextContent("Uses the deployment's models"),
    );
    expect(api.signOutCodingAgent).toHaveBeenCalledExactlyOnceWith('claude-code');
  });

  it('starts a sign-in from a row', async () => {
    api.codingAgents.mockResolvedValue([claude, codex]);
    api.startCodingAgentSignIn.mockResolvedValue(waiting);
    renderCard();

    const row = await screen.findByRole('listitem', { name: 'Claude Code' });
    fireEvent.click(within(row).getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('dialog', { name: 'Sign in to Claude' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Code')).toBeInTheDocument();
    expect(api.startCodingAgentSignIn).toHaveBeenCalledExactlyOnceWith('claude-code');
  });

  it("resumes the sign-in a row has open", async () => {
    api.codingAgents.mockResolvedValue([{ ...claude, attempt: waiting }, codex]);
    renderCard();

    const row = await screen.findByRole('listitem', { name: 'Claude Code' });
    fireEvent.click(within(row).getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByLabelText('Code')).toBeInTheDocument();
    expect(api.startCodingAgentSignIn).not.toHaveBeenCalled();
  });

  it('opens the sign-in a link names, and reports when it closes', async () => {
    api.codingAgents.mockResolvedValue([claude, codex]);
    api.startCodingAgentSignIn.mockResolvedValue(waiting);
    const onSignInClosed = vi.fn();
    renderCard({ signIn: { agent: 'claude-code' }, onSignInClosed });

    expect(await screen.findByLabelText('Code')).toBeInTheDocument();
    expect(api.startCodingAgentSignIn).toHaveBeenCalledExactlyOnceWith('claude-code');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSignInClosed).toHaveBeenCalled();
  });
});
