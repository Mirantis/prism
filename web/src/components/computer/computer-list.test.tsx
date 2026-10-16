// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ComputerSummary } from '@/types';

const { removeComputer, renameComputer } = vi.hoisted(() => ({
  removeComputer: vi.fn(async () => undefined),
  renameComputer: vi.fn(async () => ({})),
}));
vi.mock('@/api/computer', () => ({ removeComputer, renameComputer }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ params, children, title }: { params: { threadId: string }; children: ReactNode; title?: string }) => (
    <a href={`/chat/${params.threadId}`} title={title}>{children}</a>
  ),
}));

const { ComputerList } = await import('./computer-list');

function computer(over: Partial<ComputerSummary>): ComputerSummary {
  return {
    id: 'laptop',
    kind: 'remote',
    name: 'Work laptop',
    connection: 'connected',
    platform: 'macos',
    clientVersion: '1.0.0',
    display: { width: 3024, height: 1964 },
    capabilities: ['screen', 'input'],
    problems: [],
    lastConnectedAt: '2026-10-16T09:00:00.000Z',
    lastSeenAt: '2026-10-16T09:00:00.000Z',
    owner: null,
    controller: null,
    ...over,
  };
}

const computers = [
  computer({ id: 'local', kind: 'local', name: 'This runtime', platform: 'linux', lastConnectedAt: null }),
  computer({ owner: { threadId: 'thread-1', mode: 'chat' } }),
  computer({
    id: 'desk',
    name: 'Office PC',
    platform: 'windows',
    connection: 'disconnected',
    problems: [{ capability: 'elements', message: 'Accessibility permission is not granted.' }],
  }),
  computer({ id: 'new', name: 'Spare Mac', connection: 'disconnected', lastConnectedAt: null }),
];

function renderList(onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ComputerList computers={computers} selectedId="laptop" onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return onSelect;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the list of computers', () => {
  it('says whether each one is connected, which is in use, and what each lacks', () => {
    renderList();
    const item = (name: string) => screen.getByRole('listitem', { name });
    expect(item('This runtime')).toHaveTextContent('Connected');
    expect(item('Work laptop')).toHaveTextContent('Connected');
    expect(item('Work laptop')).toHaveTextContent('macOS');
    expect(item('Work laptop')).toHaveAttribute('aria-current', 'true');
    expect(within(item('Work laptop')).getByRole('link')).toHaveAttribute('href', '/chat/thread-1');
    expect(item('Office PC')).toHaveTextContent('Not connected');
    expect(item('Office PC')).toHaveTextContent('Accessibility permission is not granted.');
    expect(item('Spare Mac')).toHaveTextContent('Never connected');
  });

  it('offers rename and remove for a remote computer, not for the runtime’s own', () => {
    renderList();
    expect(screen.queryByRole('button', { name: 'Remove This runtime' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename This runtime' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Work laptop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename Work laptop' })).toBeInTheDocument();
  });

  it('selects a computer', () => {
    const onSelect = renderList();
    fireEvent.click(within(screen.getByRole('listitem', { name: 'Office PC' })).getByText('Office PC'));
    expect(onSelect).toHaveBeenCalledWith('desk');
  });

  it('removes a computer only once the removal is confirmed', async () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Office PC' }));
    expect(removeComputer).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(removeComputer).toHaveBeenCalledWith('desk'));
  });

  it('renames a computer', async () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Work laptop' }));
    const field = await screen.findByLabelText('Name');
    fireEvent.change(field, { target: { value: 'Home laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(renameComputer).toHaveBeenCalledWith('laptop', 'Home laptop'));
  });
});
