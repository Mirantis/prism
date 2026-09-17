// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerHelp, ComputerStatus } from '@/types';
import { ChatComputerPanel } from './chat-computer-panel';

const { computerRequest, state } = vi.hoisted(() => ({
  computerRequest: vi.fn(async () => ({})),
  state: { status: null as ComputerStatus | null },
}));

vi.mock('@/api/computer', () => ({ computerRequest }));
vi.mock('@/hooks/use-computer-status', () => ({
  useComputerStatus: () => ({ data: state.status }),
}));
vi.mock('@/hooks/use-computer-screen', () => ({
  useComputerScreen: () => ({
    clientId: '00000000-0000-4000-8000-000000000001',
    state: state.status,
    screenRef: { current: null },
    hasScreen: true,
    lastFrame: null,
    message: null,
    sendInput: vi.fn(),
  }),
}));
vi.mock('@/components/voice/screen-view', () => ({
  ScreenView: ({
    onTakeControl,
    onRelease,
  }: {
    onTakeControl: () => Promise<boolean>;
    onRelease: () => void;
  }) => (
    <div>
      <button onClick={() => void onTakeControl()}>Take control</button>
      <button onClick={onRelease}>Release control</button>
    </div>
  ),
}));
vi.mock('./computer-help-card', () => ({
  ComputerHelpCard: ({ help }: { help: ComputerHelp }) => (
    <div aria-label="Computer help">Help {help.id}</div>
  ),
}));

const help: ComputerHelp = {
  type: 'computer_help',
  id: '00000000-0000-4000-8000-000000000002',
  reason: 'Sign in',
  status: 'waiting',
};

function status(helpStatus: ComputerHelp['status']): ComputerStatus {
  return {
    available: true,
    running: true,
    starting: false,
    paused: false,
    controller: null,
    owner: null,
    waiting: [],
    help: [{ ...help, status: helpStatus }],
  };
}

describe('chat computer panel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    computerRequest.mockClear();
    state.status = status('waiting');
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens at 50% width, controls the request, and closes after 1.2 seconds', async () => {
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChatComputerPanel requests={[help]} />
      </QueryClientProvider>,
    );

    const panel = screen.getByLabelText('Computer help panel');
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(panel.style.width).toBe('50vw');
    expect(panel.className).toContain('transition-transform');
    expect(panel.className).toContain('duration-[1200ms]');
    expect(panel.className).not.toContain('opacity');

    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    await act(async () => {});
    expect(computerRequest).toHaveBeenCalledWith('/control', {
      clientId: '00000000-0000-4000-8000-000000000001',
      helpId: help.id,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Release control' }));
    await act(async () => {});
    expect(computerRequest).toHaveBeenCalledWith(`/help/${help.id}`, {
      action: 'continue',
      clientId: '00000000-0000-4000-8000-000000000001',
    });

    state.status = status('continued');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ChatComputerPanel requests={[help]} />
      </QueryClientProvider>,
    );
    expect(panel.getAttribute('data-state')).toBe('closed');
    expect(panel.style.width).toBe('50vw');
    expect(panel.className).toContain('translate-x-full');
    act(() => vi.advanceTimersByTime(1199));
    expect(screen.queryByLabelText('Computer help panel')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByLabelText('Computer help panel')).toBeNull();
  });

  it('supports keyboard resizing', () => {
    const queryClient = new QueryClient();
    render(
      <div style={{ width: 1000 }}>
        <QueryClientProvider client={queryClient}>
          <ChatComputerPanel requests={[help]} />
        </QueryClientProvider>
      </div>,
    );
    const panel = screen.getByLabelText('Computer help panel');
    Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: 600 });
    vi.spyOn(panel.parentElement!, 'getBoundingClientRect').mockReturnValue({
      width: 1000,
    } as DOMRect);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize computer panel' }), {
      key: 'ArrowLeft',
    });
    expect(panel.style.width).toBe('632px');
  });

  it('closes from the header and reopens from history', () => {
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChatComputerPanel requests={[help]} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close computer panel' }));
    expect(screen.getByLabelText('Computer help panel').getAttribute('data-state')).toBe(
      'closed',
    );
    act(() => vi.advanceTimersByTime(1200));
    expect(screen.queryByLabelText('Computer help panel')).toBeNull();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ChatComputerPanel
          requests={[help]}
          reopenRequest={{ id: help.id, token: 1 }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('Computer help panel').getAttribute('data-state')).toBe(
      'open',
    );
  });

  it('reopens an older waiting request from its history marker', () => {
    const older = { ...help, id: '00000000-0000-4000-8000-000000000003' };
    const newer = { ...help, id: '00000000-0000-4000-8000-000000000004' };
    state.status = { ...status('waiting'), help: [older, newer] };
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChatComputerPanel requests={[older, newer]} />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText('Computer help').textContent).toContain(newer.id);
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ChatComputerPanel
          requests={[older, newer]}
          reopenRequest={{ id: older.id, token: 1 }}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText('Computer help').textContent).toContain(older.id);
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    expect(computerRequest).toHaveBeenCalledWith('/control', {
      clientId: '00000000-0000-4000-8000-000000000001',
      helpId: older.id,
    });
  });
});
