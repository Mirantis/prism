// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { ApiError } from '@/api/errors';
import type { DocumentRevisionHistory, DocumentRevisionSummary } from '@/types';

const { mockDocumentRevisions, mockDocumentRevision, mockRestore } = vi.hoisted(() => ({
  mockDocumentRevisions: vi.fn(),
  mockDocumentRevision: vi.fn(),
  mockRestore: vi.fn(),
}));
vi.mock('@/api/runtime-client', () => ({
  runtimeApi: {
    documentRevisions: mockDocumentRevisions,
    documentRevision: mockDocumentRevision,
    restoreDocumentRevision: mockRestore,
  },
}));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1' }),
}));

import { DocumentHistory } from './document-history';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const NEWER = '# Soul\n\nBe direct.\n';
const OLDER = '# Soul\n\nBe terse.\n';

function revision(overrides: Partial<DocumentRevisionSummary> = {}): DocumentRevisionSummary {
  return {
    id: 'rev-2',
    actor: 'agent',
    method: 'replace',
    reason: 'Sharpened the tone.',
    contentHash: 'aaaa',
    createdAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  };
}

const TWO_REVISIONS = [
  revision(),
  revision({
    id: 'rev-1',
    actor: 'user',
    method: 'seed',
    reason: 'Created with the agent.',
    contentHash: 'bbbb',
    createdAt: '2026-09-01T08:30:00.000Z',
  }),
];

function history(overrides: Partial<DocumentRevisionHistory> = {}): DocumentRevisionHistory {
  return {
    field: 'soulMd',
    bound: 500,
    drifted: false,
    liveHash: 'aaaa',
    revisions: TWO_REVISIONS,
    ...overrides,
  };
}

function renderHistory(live = NEWER) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DocumentHistory field="soulMd" live={live} />
    </QueryClientProvider>,
  );
}

/** The revision rows, newest first, without the header row. */
function rows(): HTMLElement[] {
  return screen.getAllByRole('row').slice(1);
}

/** Click the row's Restore button and confirm in the dialog. */
async function restoreRow(index: number): Promise<void> {
  const row = await waitFor(() => rows()[index]);
  within(row).getByRole('button', { name: 'Restore' }).click();
  const dialog = await screen.findByRole('alertdialog');
  within(dialog).getByRole('button', { name: 'Restore' }).click();
}

describe('DocumentHistory', () => {
  it('lists the revisions newest first', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: NEWER });
    renderHistory();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent('Sharpened the tone.');
    expect(rows()[0]).toHaveTextContent('replace');
    expect(rows()[1]).toHaveTextContent('Created with the agent.');
    expect(rows()[1]).toHaveTextContent('seed');
  });

  it('shows the added and removed lines between the newest two revisions', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockImplementation((_field: string, id: string) =>
      Promise.resolve({ ...revision({ id }), content: id === 'rev-2' ? NEWER : OLDER }),
    );
    renderHistory();

    await waitFor(() => expect(screen.getByText('- Be terse.')).toBeInTheDocument());
    expect(screen.getByText('+ Be direct.')).toBeInTheDocument();
    expect(mockDocumentRevision).toHaveBeenCalledWith('soulMd', 'rev-1');
    expect(mockDocumentRevision).toHaveBeenCalledWith('soulMd', 'rev-2');
  });

  it('restores a revision against the newest revision id', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: NEWER });
    mockRestore.mockResolvedValue({ field: 'soulMd', content: OLDER, revision: revision() });
    renderHistory();

    await restoreRow(1);

    await waitFor(() =>
      expect(mockRestore).toHaveBeenCalledWith('soulMd', 'rev-1', 'rev-2'),
    );
  });

  it('asks the reader to reload when the document changed since the list was read', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: NEWER });
    mockRestore.mockRejectedValue(
      new ApiError('the document changed since this history was read', {}, 409),
    );
    renderHistory();

    await restoreRow(1);

    await waitFor(() =>
      expect(
        screen.getByText('Someone else changed this document; reload the history.'),
      ).toBeInTheDocument(),
    );
  });

  it('warns about a change made outside the app only while the document has drifted', async () => {
    mockDocumentRevisions.mockResolvedValue(history({ drifted: true }));
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: OLDER });
    renderHistory();

    await waitFor(() =>
      expect(screen.getByText('This document was changed outside the app')).toBeInTheDocument(),
    );

    cleanup();
    mockDocumentRevisions.mockResolvedValue(history());
    renderHistory();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      screen.queryByText('This document was changed outside the app'),
    ).not.toBeInTheDocument();
  });

  it('states the retention bound', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: NEWER });
    renderHistory();

    await waitFor(() =>
      expect(
        screen.getByText('This document keeps its newest 500 revisions.'),
      ).toBeInTheDocument(),
    );
  });

  it('says so when the document has no revision yet', async () => {
    mockDocumentRevisions.mockResolvedValue(history({ revisions: [], liveHash: 'cccc' }));
    renderHistory();

    await waitFor(() =>
      expect(screen.getByText(/No revisions yet/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(mockDocumentRevision).not.toHaveBeenCalled();
  });
});
