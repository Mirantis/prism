// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComputerStatus, ComputerSummary } from '@/types';

const { computerAction, viewer, screenOptions } = vi.hoisted(() => ({
  computerAction: vi.fn(async () => ({})),
  viewer: { state: null as (ComputerStatus & { connection?: 'connected' | 'disconnected' }) | null, hasScreen: true },
  screenOptions: [] as Array<{ computerId?: string }>,
}));

vi.mock('@/api/computer', () => ({ computerAction, computerRequest: vi.fn() }));
vi.mock('@/hooks/use-computer-status', () => ({ useComputerStatus: () => ({ data: viewer.state }) }));
vi.mock('@/hooks/use-computer-screen', () => ({
  useComputerScreen: (options: { computerId?: string }) => {
    screenOptions.push(options);
    return {
      clientId: '00000000-0000-4000-8000-000000000001',
      state: viewer.state,
      screenRef: { current: null },
      hasScreen: viewer.hasScreen,
      lastFrame: null,
      message: null,
      sendInput: vi.fn(),
    };
  },
}));
vi.mock('@/hooks/use-computer-audio', () => ({
  useComputerAudio: () => ({ enabled: true, error: null, toggle: vi.fn(), enqueue: vi.fn() }),
}));
vi.mock('@/hooks/use-computer-voice', () => ({
  useComputerVoice: () => ({
    status: 'idle',
    isSpeaking: false,
    isMuted: true,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    toggleMute: vi.fn(),
    setMuted: vi.fn(),
    setPlaybackMuted: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-screen-share', () => ({
  useScreenShare: () => ({ sharing: false, stream: null, error: null, start: vi.fn(), stop: vi.fn() }),
}));
vi.mock('@/hooks/use-screen-recording', () => ({
  useScreenRecording: () => ({ recording: false, elapsedMs: 0, error: null, start: vi.fn(), stop: vi.fn(), abandon: vi.fn() }),
}));
vi.mock('@/components/voice/screen-view', () => ({
  ScreenView: ({
    hasScreen,
    connecting,
    unavailable,
    onTakeControl,
  }: {
    hasScreen: boolean;
    connecting: boolean;
    unavailable?: { title: string; detail: string };
    onTakeControl: () => Promise<boolean>;
  }) => (
    <div>
      {!hasScreen && !connecting && <p>{unavailable?.title ?? 'Computer unavailable'}</p>}
      {!hasScreen && !connecting && unavailable && <p>{unavailable.detail}</p>}
      <button onClick={() => void onTakeControl()}>Take control</button>
    </div>
  ),
}));

const { ComputerView } = await import('./computer-view');

const status: ComputerStatus = {
  available: true,
  running: true,
  starting: false,
  paused: false,
  secure: false,
  controller: null,
  owner: null,
  waiting: [],
  help: [],
};

function summary(over: Partial<ComputerSummary> = {}): ComputerSummary {
  return {
    id: 'laptop',
    kind: 'remote',
    name: 'Work laptop',
    connection: 'connected',
    platform: 'macos',
    clientVersion: '1.0.0',
    display: { width: 3024, height: 1964 },
    capabilities: ['screen', 'input', 'stream'],
    problems: [],
    lastConnectedAt: '2026-10-16T09:00:00.000Z',
    lastSeenAt: null,
    owner: null,
    controller: null,
    ...over,
  };
}

function renderView(computer: ComputerSummary) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ComputerView computer={computer} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  screenOptions.length = 0;
  viewer.state = { ...status, connection: 'connected' };
  viewer.hasScreen = true;
});
afterEach(cleanup);

describe('a remote computer’s view', () => {
  it('shows that computer and leaves out what belongs to the runtime’s own desktop', () => {
    renderView(summary());
    expect(screenOptions.at(-1)?.computerId).toBe('laptop');
    expect(screen.getByRole('status')).toHaveTextContent('Ready');
    expect(screen.queryByRole('button', { name: 'Talk' })).toBeNull();
    expect(screen.queryByRole('button', { name: /sound/i })).toBeNull();
  });

  it('takes control of that computer', () => {
    renderView(summary());
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    expect(computerAction).toHaveBeenCalledWith('laptop', 'control', {
      clientId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('says it is not connected in place of the screen', () => {
    viewer.state = { ...status, connection: 'disconnected' };
    viewer.hasScreen = false;
    renderView(summary({ connection: 'disconnected' }));
    expect(screen.getByRole('status')).toHaveTextContent('Not connected');
    expect(screen.getByText('Not connected', { selector: 'p' })).toBeInTheDocument();
  });

  it('says what to allow when the computer does not share its screen', () => {
    viewer.state = { ...status, connection: 'connected', screen: false };
    viewer.hasScreen = false;
    renderView(
      summary({
        capabilities: ['screen', 'input'],
        problems: [{ capability: 'stream', message: 'Allow Prism in Screen Recording.' }],
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Screen not shared');
    expect(screen.getByText('Screen not shared', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Allow Prism in Screen Recording.')).toBeInTheDocument();
  });

  it('says when the person at the computer has it', () => {
    viewer.state = { ...status, connection: 'connected', paused: true, controller: 'local' };
    renderView(summary());
    expect(screen.getByRole('status')).toHaveTextContent('The person at Work laptop has control');
  });
});

describe('the runtime’s own computer’s view', () => {
  it('keeps sound and voice', () => {
    viewer.state = { ...status };
    renderView(summary({ id: 'local', kind: 'local', name: 'This runtime', platform: 'linux' }));
    expect(screen.getByRole('button', { name: 'Talk' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mute sound' })).toBeInTheDocument();
  });
});
