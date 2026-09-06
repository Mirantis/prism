// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { AgentDetails } from '@/types';

const { mockUpdateAgentGuide } = vi.hoisted(() => ({ mockUpdateAgentGuide: vi.fn() }));
vi.mock('@/api/runtime-client', () => ({
  runtimeApi: { updateAgentGuide: mockUpdateAgentGuide },
}));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1' }),
}));

import { AgentGuideEditor } from './agent-guide-editor';

afterEach(cleanup);

function details(agentMd: string): AgentDetails {
  return { agentMd, lockedIn: false, verbose: false } as AgentDetails;
}

function renderEditor(d: AgentDetails) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <AgentGuideEditor details={d} />
    </QueryClientProvider>,
  );
  return {
    ...utils,
    rerenderWith: (next: AgentDetails) =>
      utils.rerender(
        <QueryClientProvider client={client}>
          <AgentGuideEditor details={next} />
        </QueryClientProvider>,
      ),
  };
}

const box = () => screen.getByRole('textbox', { name: 'Agent guide' });
const note = () => screen.getByRole('textbox', { name: 'What changed (optional)' });
const saveButton = () => screen.getByRole('button', { name: /^Save/ });

/** Type into the box the way a controlled textarea sees it. */
function edit(value: string): void {
  fireEvent.change(box(), { target: { value } });
}

describe('AgentGuideEditor', () => {
  it('shows the stored document', () => {
    renderEditor(details('# Agent Guide\n- be brief'));
    expect(box()).toHaveValue('# Agent Guide\n- be brief');
  });

  it('cannot save an untouched document', () => {
    renderEditor(details('# Agent Guide'));
    expect(saveButton()).toBeDisabled();
  });

  it('PATCHes the edited document', async () => {
    mockUpdateAgentGuide.mockResolvedValue({ agentMd: '# Agent Guide!' });
    renderEditor(details('# Agent Guide'));

    edit('# Agent Guide!');
    saveButton().click();

    await waitFor(() => expect(mockUpdateAgentGuide).toHaveBeenCalledWith('# Agent Guide!', ''));
  });

  it('sends the note about what changed and clears it after the save', async () => {
    mockUpdateAgentGuide.mockResolvedValue({ agentMd: '# Agent Guide!' });
    renderEditor(details('# Agent Guide'));

    edit('# Agent Guide!');
    fireEvent.change(note(), { target: { value: 'Added the review rule.' } });
    saveButton().click();

    await waitFor(() =>
      expect(mockUpdateAgentGuide).toHaveBeenCalledWith('# Agent Guide!', 'Added the review rule.'),
    );
    await waitFor(() => expect(note()).toHaveValue(''));
  });

  it('marks unsaved changes and clears the mark on revert', async () => {
    renderEditor(details('# Agent Guide'));

    edit('# Agent Guide more');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    screen.getByRole('button', { name: 'Revert' }).click();

    await waitFor(() => expect(box()).toHaveValue('# Agent Guide'));
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('surfaces a failed save and keeps the draft', async () => {
    mockUpdateAgentGuide.mockRejectedValue(new Error('runtime unreachable'));
    renderEditor(details('# Agent Guide'));

    edit('# Agent Guide!');
    saveButton().click();

    await waitFor(() => expect(screen.getByText('runtime unreachable')).toBeInTheDocument());
    expect(box()).toHaveValue('# Agent Guide!');
  });

  // A refetch must not wipe what someone is typing, and must refresh a box
  // they have not touched.
  it('keeps a touched draft when the stored document changes', () => {
    const { rerenderWith } = renderEditor(details('# Agent Guide'));

    edit('# Agent Guide mine');
    rerenderWith(details('# Agent Guide (from elsewhere)'));

    expect(box()).toHaveValue('# Agent Guide mine');
  });

  it('adopts the stored document into an untouched box', () => {
    const { rerenderWith } = renderEditor(details('# Agent Guide'));

    rerenderWith(details('# Agent Guide (from elsewhere)'));

    expect(box()).toHaveValue('# Agent Guide (from elsewhere)');
  });
});
