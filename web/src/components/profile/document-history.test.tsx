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
    matchesCurrent: true,
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
    matchesCurrent: false,
    createdAt: '2026-09-01T08:30:00.000Z',
  }),
];

/** The same two, with the newest no longer holding what the document reads. */
const DRIFTED_REVISIONS = [
  { ...TWO_REVISIONS[0], matchesCurrent: false },
  TWO_REVISIONS[1],
];

function history(overrides: Partial<DocumentRevisionHistory> = {}): DocumentRevisionHistory {
  return {
    field: 'soulMd',
    bound: 500,
    drifted: false,
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
  return Array.from(document.querySelectorAll<HTMLElement>('[data-revision-id]'));
}

/** Click the row's Restore button and confirm in the dialog. */
async function restoreRow(index: number): Promise<void> {
  await waitFor(() => expect(rows()[index]).toBeDefined());
  rows()[index].click();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Restore this version' })).toBeEnabled());
  screen.getByRole('button', { name: 'Restore this version' }).click();
  const dialog = await screen.findByRole('alertdialog');
  within(dialog).getByRole('button', { name: 'Restore version' }).click();
}

describe('DocumentHistory', () => {
  it('disables restoration when selected content matches the current document', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: NEWER });
    renderHistory();
    (await screen.findByRole('button', { name: /Sharpened the tone/ })).click();
    await screen.findByText('This version matches the current document.');
    expect(screen.getByRole('button', { name: 'Restore this version' })).toBeDisabled();
  });

  it('marks the revisions that hold what the document reads now', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: NEWER });
    renderHistory();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent('Matches current document');
    expect(rows()[1]).not.toHaveTextContent('Matches current document');
  });

  it('compares unrecorded content against the newest saved revision', async () => {
    mockDocumentRevisions.mockResolvedValue(history({ drifted: true, revisions: DRIFTED_REVISIONS }));
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: NEWER });
    renderHistory('# Soul\n\nAn unrecorded edit.\n');
    await screen.findByText('+ An unrecorded edit.');
    expect(screen.getByText('- Be direct.')).toBeInTheDocument();
    expect(mockDocumentRevision).toHaveBeenCalledWith('soulMd', 'rev-2');
  });

  it('lists the revisions newest first', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: OLDER });
    renderHistory();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent('Sharpened the tone.');
    expect(rows()[0]).toHaveTextContent('Replaced');
    expect(rows()[1]).toHaveTextContent('Initial version');
    expect(rows()[1]).toHaveTextContent('You');
  });

  it('compares the selected revision with the current document', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockImplementation((_field: string, id: string) =>
      Promise.resolve({ ...revision({ id }), content: id === 'rev-2' ? NEWER : OLDER }),
    );
    renderHistory();

    (await screen.findByRole('button', { name: /Initial version/ })).click();
    await waitFor(() => expect(screen.getByText('- Be terse.')).toBeInTheDocument());
    expect(screen.getByText('+ Be direct.')).toBeInTheDocument();
    expect(mockDocumentRevision).toHaveBeenCalledWith('soulMd', 'rev-1');
    expect(mockDocumentRevision).not.toHaveBeenCalledWith('soulMd', 'rev-2');
  });

  it('restores a revision against the newest revision id', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: OLDER });
    mockRestore.mockResolvedValue({ field: 'soulMd', content: OLDER, revision: revision() });
    renderHistory();

    await restoreRow(1);

    await waitFor(() =>
      expect(mockRestore).toHaveBeenCalledWith('soulMd', 'rev-1', 'rev-2'),
    );
  });

  it('asks the reader to reload when the document changed since the list was read', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: OLDER });
    mockRestore.mockRejectedValue(
      new ApiError('the document changed since this history was read', {}, 409),
    );
    renderHistory();

    await restoreRow(1);

    await waitFor(() =>
      expect(
        screen.getByText('This document changed. Refresh the history before restoring.'),
      ).toBeInTheDocument(),
    );
  });

  it('warns about a change made outside the app only while the document has drifted', async () => {
    mockDocumentRevisions.mockResolvedValue(history({ drifted: true, revisions: DRIFTED_REVISIONS }));
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: OLDER });
    renderHistory();

    await waitFor(() =>
      expect(screen.getByText('Current document has unrecorded changes')).toBeInTheDocument(),
    );

    cleanup();
    mockDocumentRevisions.mockResolvedValue(history());
    renderHistory();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      screen.queryByText('Current document has unrecorded changes'),
    ).not.toBeInTheDocument();
  });

  it('states the retention bound', async () => {
    mockDocumentRevisions.mockResolvedValue(history());
    mockDocumentRevision.mockResolvedValue({ ...revision(), content: OLDER });
    renderHistory();

    await waitFor(() =>
      expect(
        screen.getByText('Keeps the latest 500 versions.'),
      ).toBeInTheDocument(),
    );
  });

  it('says so when the document has no revision yet', async () => {
    mockDocumentRevisions.mockResolvedValue(history({ revisions: [] }));
    renderHistory();

    await waitFor(() =>
      expect(screen.getByText(/No saved versions yet/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(mockDocumentRevision).not.toHaveBeenCalled();
  });
});
