// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import '@testing-library/jest-dom/vitest';
import type { WebhookRunDetail, WebhookRunPage, WebhookRunSummary } from '@/types';

const { mockListWebhookRuns, mockGetWebhookRun } = vi.hoisted(() => ({
  mockListWebhookRuns: vi.fn(),
  mockGetWebhookRun: vi.fn(),
}));

vi.mock('@/api/runtime-client', () => ({
  runtimeApi: { listWebhookRuns: mockListWebhookRuns, getWebhookRun: mockGetWebhookRun },
}));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1', userId: 'user-1', name: 'Test Agent' }),
}));
// The link needs a router; the test asserts on where it points.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ params, children }: { params: { threadId: string }; children: ReactNode }) => (
    <a href={`/chat/${params.threadId}`}>{children}</a>
  ),
}));

import { WebhookRunList } from './webhook-run-list';

function run(id: string, over: Partial<WebhookRunSummary> = {}): WebhookRunSummary {
  return {
    id,
    name: `hook-${id}`,
    event: 'push',
    status: 'completed',
    error: null,
    createdAt: '2026-10-05T09:00:00.000Z',
    finishedAt: '2026-10-05T09:00:42.000Z',
    message: { id: `msg-${id}`, threadId: 'thread-1', threadTitle: 'Alerts', inWebChat: true },
    coalescedInto: null,
    ...over,
  };
}

function page(runs: WebhookRunSummary[], nextCursor: string | null): WebhookRunPage {
  return { items: runs, nextCursor };
}

function detail(summary: WebhookRunSummary, over: Partial<WebhookRunDetail> = {}): WebhookRunDetail {
  return {
    ...summary,
    delivered: {
      content: 'All clear.',
      toolCalls: [{ tool: 'shell_exec', input: '{"command":"uptime"}', output: '"up"', success: true }],
    },
    ...over,
  };
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WebhookRunList />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockListWebhookRuns.mockReset();
  mockGetWebhookRun.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('WebhookRunList', () => {
  it('says so when no webhook has run', async () => {
    mockListWebhookRuns.mockResolvedValue(page([], null));

    renderList();

    expect(await screen.findByTestId('activity-webhook-runs-empty')).toBeInTheDocument();
  });

  it('reports a failed read rather than calling the list empty', async () => {
    mockListWebhookRuns.mockRejectedValue(new Error('boom'));

    renderList();

    expect(await screen.findByTestId('activity-webhook-runs-error')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-webhook-runs-empty')).not.toBeInTheDocument();
  });

  it('names each run, its event and its result', async () => {
    mockListWebhookRuns.mockResolvedValue(
      page(
        [
          run('a'),
          run('b', { status: 'failed' }),
          run('c', { status: 'budget_exceeded' }),
          run('d', { status: 'delivered', event: 'unknown' }),
          run('e', { status: 'running', finishedAt: null, message: null }),
        ],
        null,
      ),
    );

    renderList();

    const rows = await screen.findAllByTestId('activity-webhook-run');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('hook-a'),
      expect.stringContaining('hook-b'),
      expect.stringContaining('hook-c'),
      expect.stringContaining('hook-d'),
      expect.stringContaining('hook-e'),
    ]);
    expect(rows[0]).toHaveTextContent('push');
    expect(rows[0]).toHaveTextContent('Completed');
    expect(rows[1]).toHaveTextContent('Failed');
    expect(rows[2]).toHaveTextContent('Spending limit reached');
    expect(rows[3]).toHaveTextContent('Delivered');
    // An event the sender did not name is not shown as one.
    expect(rows[3]).not.toHaveTextContent('unknown');
    expect(rows[4]).toHaveTextContent('Running');
  });

  it('loads the next page on request, and offers no more after the last', async () => {
    mockListWebhookRuns
      .mockResolvedValueOnce(page([run('a')], 'a'))
      .mockResolvedValueOnce(page([run('b')], null));

    renderList();

    fireEvent.click(await screen.findByTestId('activity-webhook-runs-more'));

    await waitFor(() => expect(screen.getAllByTestId('activity-webhook-run')).toHaveLength(2));
    expect(mockListWebhookRuns).toHaveBeenLastCalledWith({ limit: 10, cursor: 'a' });
    expect(screen.queryByTestId('activity-webhook-runs-more')).not.toBeInTheDocument();
  });

  it('shows what a finished run delivered, its tool calls and its conversation', async () => {
    const summary = run('a');
    mockListWebhookRuns.mockResolvedValue(page([summary], null));
    mockGetWebhookRun.mockResolvedValue(detail(summary));

    renderList();
    fireEvent.click(await screen.findByTestId('activity-webhook-run'));

    expect(await screen.findByTestId('activity-webhook-run-message')).toHaveTextContent('All clear.');
    expect(screen.getAllByTestId('activity-webhook-run-tool-call')).toHaveLength(1);
    expect(screen.getByText('Open conversation')).toHaveAttribute('href', '/chat/thread-1');
    expect(screen.getByText('Took 42s')).toBeInTheDocument();
    expect(mockGetWebhookRun).toHaveBeenCalledWith('a');
  });

  it('offers no conversation link for a message kept in a Slack or Teams thread', async () => {
    const summary = run('a', {
      message: { id: 'msg-a', threadId: 'thread-s', threadTitle: null, inWebChat: false },
    });
    mockListWebhookRuns.mockResolvedValue(page([summary], null));
    mockGetWebhookRun.mockResolvedValue(detail(summary));

    renderList();
    fireEvent.click(await screen.findByTestId('activity-webhook-run'));

    expect(await screen.findByTestId('activity-webhook-run-message')).toBeInTheDocument();
    expect(screen.queryByText('Open conversation')).not.toBeInTheDocument();
  });

  it('shows the error of a failed run that delivered nothing', async () => {
    const summary = run('a', { status: 'failed', error: 'database is locked', message: null });
    mockListWebhookRuns.mockResolvedValue(page([summary], null));
    mockGetWebhookRun.mockResolvedValue(detail(summary, { delivered: null }));

    renderList();
    fireEvent.click(await screen.findByTestId('activity-webhook-run'));

    expect(await screen.findByText('database is locked')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-webhook-run-message')).not.toBeInTheDocument();
  });

  it('marks an event an earlier event\'s run handled, and shows that run', async () => {
    const lead = run('a', { event: 'pull_request_review' });
    const member = run('b', { event: 'pull_request_review_comment', message: null, coalescedInto: 'a' });
    mockListWebhookRuns.mockResolvedValue(page([member, lead], null));
    mockGetWebhookRun.mockResolvedValue(detail(lead));

    renderList();
    const rows = await screen.findAllByTestId('activity-webhook-run');
    expect(rows[0]).toHaveTextContent('Handled with an earlier event');
    expect(rows[1]).not.toHaveTextContent('Handled with an earlier event');
    fireEvent.click(rows[0]);

    expect(await screen.findByTestId('activity-webhook-run-message')).toHaveTextContent('All clear.');
    expect(screen.getByText(/Handled in one run with the pull_request_review event/)).toBeInTheDocument();
    expect(mockGetWebhookRun).toHaveBeenCalledWith('a');
  });

  it('reads nothing more for a run that has not finished', async () => {
    mockListWebhookRuns.mockResolvedValue(
      page([run('a', { status: 'queued', finishedAt: null, message: null })], null),
    );

    renderList();
    fireEvent.click(await screen.findByTestId('activity-webhook-run'));

    expect(await screen.findByText('The run has not finished.')).toBeInTheDocument();
    expect(mockGetWebhookRun).not.toHaveBeenCalled();
  });
});
