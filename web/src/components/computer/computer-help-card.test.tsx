// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComputerHelp, ComputerStatus } from '@/types';

const { mockComputerRequest } = vi.hoisted(() => ({ mockComputerRequest: vi.fn() }));
vi.mock('@/api/computer', () => ({ computerRequest: mockComputerRequest }));

import { useComputerStatusFeed } from '@/hooks/use-computer-status';
import { ComputerHelpCard } from './computer-help-card';

const help: ComputerHelp = {
  type: 'computer_help',
  id: 'help-1',
  reason: 'Sign in to the invoicing site.',
  status: 'waiting',
};

function status(over: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    available: true,
    running: true,
    starting: false,
    paused: false,
    controller: null,
    owner: null,
    waiting: [],
    help: [help],
    ...over,
  };
}

/** A `computer` frame, delivered the way the chat socket delivers one. */
let writeStatus: ((next: ComputerStatus) => void) | undefined;

function Harness() {
  writeStatus = useComputerStatusFeed();
  return <ComputerHelpCard help={help} />;
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe('ComputerHelpCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeStatus = undefined;
    mockComputerRequest.mockResolvedValue(status());
  });

  it('shows the help as waiting, with the two ways to resolve it', async () => {
    try {
      renderCard();

      await waitFor(() => expect(screen.getByLabelText('Computer help')).toBeTruthy());
      expect(screen.getByLabelText('Computer help').textContent).toContain('Needs your help');
      expect(screen.getByRole('button', { name: 'I’m done' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('follows a frame that resolves the help', async () => {
    try {
      renderCard();
      await waitFor(() => expect(writeStatus).toBeTypeOf('function'));
      await waitFor(() => expect(mockComputerRequest).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByLabelText('Computer help').textContent).toContain('Needs your help'),
      );

      act(() => writeStatus!(status({ help: [{ ...help, status: 'continued' }] })));

      await waitFor(() =>
        expect(screen.getByLabelText('Computer help').textContent).toContain('Ready to continue'),
      );
      expect(screen.queryByRole('button', { name: 'I’m done' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
      // The page took the resolution from the frame, so it asked the runtime nothing more.
      expect(mockComputerRequest).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('holds a frame that arrives while a request is in flight', async () => {
    try {
      let answer: (value: ComputerStatus) => void = () => {};
      mockComputerRequest.mockReturnValueOnce(
        new Promise<ComputerStatus>((resolve) => {
          answer = resolve;
        }),
      );
      renderCard();
      await waitFor(() => expect(mockComputerRequest).toHaveBeenCalledTimes(1));

      // The desktop resolves the help while the mount request is still open.
      act(() => writeStatus!(status({ help: [{ ...help, status: 'continued' }] })));
      await waitFor(() =>
        expect(screen.getByLabelText('Computer help').textContent).toContain('Ready to continue'),
      );

      // The request answers with the state as it was before the frame. The frame is
      // the newer reading and stays, where the answer would sit until the next change.
      await act(async () => {
        answer(status());
        // The answer is committed and rendered over several microtasks, so the
        // assertion has to wait for that rather than read the cache before it lands.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.getByLabelText('Computer help').textContent).toContain('Ready to continue');
      expect(screen.getByLabelText('Computer help').textContent).not.toContain('Needs your help');
    } finally {
      cleanup();
    }
  });
});
