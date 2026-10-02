// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { AgentDetails, DocumentField } from '@lensapp/prism-client';

const { mockUpdateWorkspaceDoc } = vi.hoisted(() => ({ mockUpdateWorkspaceDoc: vi.fn() }));
vi.mock('@/api/runtime-client', () => ({
  runtimeApi: { updateWorkspaceDoc: mockUpdateWorkspaceDoc },
}));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1' }),
}));

import { DocumentEditor } from './document-editor';

afterEach(cleanup);

function details(field: DocumentField, content: string): AgentDetails {
  return { [field]: content, lockedIn: false, verbose: false } as unknown as AgentDetails;
}

function renderEditor(field: DocumentField, label: string, d: AgentDetails) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <DocumentEditor field={field} label={label} details={d} />
    </QueryClientProvider>,
  );
  return {
    ...utils,
    rerenderWith: (next: AgentDetails) =>
      utils.rerender(
        <QueryClientProvider client={client}>
          <DocumentEditor field={field} label={label} details={next} />
        </QueryClientProvider>,
      ),
  };
}

const box = (label: string) => screen.getByRole('textbox', { name: `${label} document` });
const note = () => screen.getByRole('textbox', { name: 'What changed (optional)' });
const saveButton = () => screen.getByRole('button', { name: /^Save/ });

/** Type into the box the way a controlled textarea sees it. */
function edit(label: string, value: string): void {
  fireEvent.change(box(label), { target: { value } });
}

// Every document is edited through the same component, so the field-dependent
// behaviour is asserted for the guide and for one the agent also maintains.
const CASES: Array<[DocumentField, string]> = [
  ['agentMd', 'Agent'],
  ['soulMd', 'Soul'],
];

describe('DocumentEditor', () => {
  it.each(CASES)('shows the stored %s document', (field, label) => {
    renderEditor(field, label, details(field, '# Stored\n- be brief'));
    expect(box(label)).toHaveValue('# Stored\n- be brief');
  });

  it.each(CASES)('PATCHes the edited %s document', async (field, label) => {
    mockUpdateWorkspaceDoc.mockResolvedValue({ field, content: '# Stored!' });
    renderEditor(field, label, details(field, '# Stored'));

    edit(label, '# Stored!');
    saveButton().click();

    await waitFor(() =>
      expect(mockUpdateWorkspaceDoc).toHaveBeenCalledWith(field, '# Stored!', ''),
    );
  });

  it('cannot save an untouched document', () => {
    renderEditor('soulMd', 'Soul', details('soulMd', '# Soul'));
    expect(saveButton()).toBeDisabled();
  });

  it('sends the note about what changed and clears it after the save', async () => {
    mockUpdateWorkspaceDoc.mockResolvedValue({ field: 'soulMd', content: '# Soul!' });
    renderEditor('soulMd', 'Soul', details('soulMd', '# Soul'));

    edit('Soul', '# Soul!');
    fireEvent.change(note(), { target: { value: 'Sharpened the tone.' } });
    saveButton().click();

    await waitFor(() =>
      expect(mockUpdateWorkspaceDoc).toHaveBeenCalledWith('soulMd', '# Soul!', 'Sharpened the tone.'),
    );
    await waitFor(() => expect(note()).toHaveValue(''));
  });

  it('marks unsaved changes and clears the mark on revert', async () => {
    renderEditor('soulMd', 'Soul', details('soulMd', '# Soul'));

    edit('Soul', '# Soul more');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    screen.getByRole('button', { name: 'Revert' }).click();

    await waitFor(() => expect(box('Soul')).toHaveValue('# Soul'));
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('surfaces a failed save and keeps the draft', async () => {
    mockUpdateWorkspaceDoc.mockRejectedValue(new Error('runtime unreachable'));
    renderEditor('soulMd', 'Soul', details('soulMd', '# Soul'));

    edit('Soul', '# Soul!');
    saveButton().click();

    await waitFor(() => expect(screen.getByText('runtime unreachable')).toBeInTheDocument());
    expect(box('Soul')).toHaveValue('# Soul!');
  });

  // A refetch must not wipe what someone is typing, and must refresh a box
  // they have not touched.
  it('keeps a touched draft when the stored document changes', () => {
    const { rerenderWith } = renderEditor('soulMd', 'Soul', details('soulMd', '# Soul'));

    edit('Soul', '# Soul mine');
    rerenderWith(details('soulMd', '# Soul (from elsewhere)'));

    expect(box('Soul')).toHaveValue('# Soul mine');
  });

  it('adopts the stored document into an untouched box', () => {
    const { rerenderWith } = renderEditor('soulMd', 'Soul', details('soulMd', '# Soul'));

    rerenderWith(details('soulMd', '# Soul (from elsewhere)'));

    expect(box('Soul')).toHaveValue('# Soul (from elsewhere)');
  });
});
