// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { ApiError } from '@/api/errors';
import type { CodingAgentId, CodingAgentSignIn, CodingAgentSummary } from '@/types';

const { api } = vi.hoisted(() => ({
  api: {
    codingAgents: vi.fn(),
    startCodingAgentSignIn: vi.fn(),
    codingAgentSignIn: vi.fn(),
    sendClaudeSignInCode: vi.fn(),
  },
}));
vi.mock('@/api/runtime-client', () => ({ runtimeApi: api }));

import { CodingAgentSignInDialog } from './coding-agent-sign-in-dialog';

function attempt(over: Partial<CodingAgentSignIn> = {}): CodingAgentSignIn {
  return {
    id: 'attempt-1',
    agent: 'claude-code',
    status: 'waiting',
    url: 'https://claude.example.com/oauth/authorize?code=true',
    userCode: null,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    error: null,
    ...over,
  };
}

function row(agent: CodingAgentId, plan: string): CodingAgentSummary {
  return {
    agent,
    name: agent === 'codex' ? 'Codex' : 'Claude Code',
    available: true,
    subscription: true,
    forced: false,
    account: { plan, email: 'sam@example.com' },
    attempt: null,
  };
}

function renderDialog(agent: CodingAgentId) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CodingAgentSignInDialog agent={agent} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CodingAgentSignInDialog', () => {
  it('starts a Claude sign-in, takes the code and shows the plan it signed in to', async () => {
    api.startCodingAgentSignIn.mockResolvedValue(attempt());
    api.sendClaudeSignInCode.mockResolvedValue(attempt({ status: 'signed_in' }));
    api.codingAgents.mockResolvedValue([row('claude-code', 'Claude Max')]);
    const { onClose } = renderDialog('claude-code');

    const dialog = await screen.findByRole('dialog', { name: 'Sign in to Claude' });
    expect(dialog).toHaveAccessibleDescription(
      "Claude Code does your agent's multi-step work: research, documents, slides, spreadsheets, analysis and code. Signed in, it runs on your own Claude plan instead of the deployment's models.",
    );
    expect(await screen.findByText("Open Claude's sign-in page.")).toBeInTheDocument();
    expect(screen.getByText('Sign in and allow access.')).toBeInTheDocument();
    expect(screen.getByText('Paste the code it shows.')).toBeInTheDocument();
    expect(dialog).toHaveTextContent("You sign in on Anthropic's own page. Your password never reaches this app.");
    const link = screen.getByRole('link', { name: 'Open sign-in' });
    expect(link).toHaveAttribute('href', 'https://claude.example.com/oauth/authorize?code=true');
    expect(link).toHaveAttribute('target', '_blank');
    expect(api.startCodingAgentSignIn).toHaveBeenCalledExactlyOnceWith('claude-code');

    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: ' code-123 ' } });
    fireEvent.click(submit);

    expect(await screen.findByText('Signed in. Claude Code now runs on your Claude Max.')).toBeInTheDocument();
    expect(api.sendClaudeSignInCode).toHaveBeenCalledWith('attempt-1', 'code-123');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows Checking… while the code is checked', async () => {
    api.startCodingAgentSignIn.mockResolvedValue(attempt());
    api.sendClaudeSignInCode.mockReturnValue(new Promise(() => {}));
    renderDialog('claude-code');

    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: 'code-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Checking…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
  });

  it('shows why a sign-in failed, and gets a new link', async () => {
    api.startCodingAgentSignIn
      .mockResolvedValueOnce(attempt())
      .mockResolvedValueOnce(attempt({ id: 'attempt-2', url: 'https://claude.example.com/second' }));
    api.sendClaudeSignInCode.mockResolvedValue(
      attempt({ status: 'failed', error: 'That code is not valid. Get a new link and try again.' }),
    );
    renderDialog('claude-code');

    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('That code is not valid. Get a new link and try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Get a new link' }));

    expect(await screen.findByRole('link', { name: 'Open sign-in' })).toHaveAttribute(
      'href',
      'https://claude.example.com/second',
    );
    expect(api.startCodingAgentSignIn).toHaveBeenCalledTimes(2);
  });

  it('resumes the sign-in under way for the agent, wherever it was started', async () => {
    api.codingAgents.mockResolvedValue([{ ...row('claude-code', 'Claude Max'), subscription: false, account: null, attempt: attempt() }]);
    renderDialog('claude-code');

    expect(await screen.findByLabelText('Code')).toBeInTheDocument();
    expect(api.startCodingAgentSignIn).not.toHaveBeenCalled();
  });

  it('shows a sign-in the runtime no longer knows as expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.startCodingAgentSignIn.mockResolvedValue(attempt({ agent: 'codex', userCode: 'ABCD-1234' }));
    api.codingAgentSignIn.mockRejectedValue(new ApiError('Not found', {}, 404));
    renderDialog('codex');

    expect(await screen.findByTestId('coding-agent-user-code')).toHaveTextContent('ABCD-1234');
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await screen.findByText('The sign-in link expired.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get a new link' })).toBeInTheDocument();
  });

  it('shows the Codex code and reads the sign-in again every 3 seconds until it finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const waiting = attempt({
      agent: 'codex',
      url: 'https://auth.example.com/codex/device',
      userCode: 'ABCD-1234',
    });
    api.startCodingAgentSignIn.mockResolvedValue(waiting);
    api.codingAgentSignIn
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce({ ...waiting, status: 'signed_in' });
    api.codingAgents.mockResolvedValue([row('codex', 'ChatGPT Plus')]);
    renderDialog('codex');

    expect(await screen.findByRole('dialog', { name: 'Sign in to ChatGPT' })).toHaveTextContent(
      "You sign in on OpenAI's own page. Your password never reaches this app.",
    );
    expect(await screen.findByTestId('coding-agent-user-code')).toHaveTextContent('ABCD-1234');
    expect(screen.getByText("Open ChatGPT's sign-in page.")).toBeInTheDocument();
    expect(screen.getByText('Enter this code:')).toBeInTheDocument();
    expect(screen.getByText("Allow access. This updates when you're done.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open sign-in' })).toHaveAttribute('href', 'https://auth.example.com/codex/device');
    expect(screen.getByText("Waiting for you to finish on OpenAI's page…")).toBeInTheDocument();
    expect(api.codingAgentSignIn).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(api.codingAgentSignIn).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(3000));

    expect(await screen.findByText('Signed in. Codex now runs on your ChatGPT Plus.')).toBeInTheDocument();
    expect(api.codingAgentSignIn).toHaveBeenCalledTimes(2);
  });

  it('shows a sign-in being checked', async () => {
    api.codingAgents.mockResolvedValue([{ ...row('claude-code', 'Claude Max'), attempt: attempt({ status: 'checking' }) }]);
    api.codingAgentSignIn.mockReturnValue(new Promise(() => {}));
    renderDialog('claude-code');

    expect(await screen.findByText('Checking…')).toBeInTheDocument();
  });

  it('shows why a sign-in could not start', async () => {
    api.startCodingAgentSignIn.mockRejectedValue(
      new ApiError('Claude Code is not installed where this agent runs its commands.', {}, 409),
    );
    renderDialog('claude-code');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Claude Code is not installed where this agent runs its commands.'),
    );
  });
});
