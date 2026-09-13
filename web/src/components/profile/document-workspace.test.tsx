// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { AgentDetails, DocumentField } from '@/types';

vi.mock('@/api/runtime-client', () => ({
  runtimeApi: {
    updateWorkspaceDoc: vi.fn(),
    documentRevisions: vi.fn().mockResolvedValue({
      field: 'soulMd',
      drifted: false,
      bound: 500,
      revisions: [],
    }),
    documentRevision: vi.fn(),
    restoreDocumentRevision: vi.fn(),
  },
}));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1' }),
}));

import { DocumentWorkspace } from './document-workspace';

afterEach(cleanup);

// The tabs the Profile page renders, in its order.
const TABS: Array<[DocumentField, string]> = [
  ['agentMd', 'Agent'],
  ['soulMd', 'Soul'],
  ['userMd', 'User'],
  ['heartbeatMd', 'Heartbeat'],
  ['memoryMd', 'Memory'],
  ['visionMd', 'Vision'],
  ['bootstrapMd', 'Bootstrap'],
];

function renderTab(field: DocumentField, label: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const details = { [field]: `# ${label}` } as unknown as AgentDetails;
  render(
    <QueryClientProvider client={client}>
      <DocumentWorkspace field={field} label={label} details={details} />
    </QueryClientProvider>,
  );
}

describe('DocumentWorkspace', () => {
  it.each(TABS)('offers an editable %s box with a save', (field, label) => {
    renderTab(field, label);

    const box = screen.getByRole('textbox', { name: `${label} document` });
    expect(box).toHaveValue(`# ${label}`);
    expect(box).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: /^Save/ })).toBeInTheDocument();
  });
});
