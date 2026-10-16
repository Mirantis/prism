// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { socketUrl } = vi.hoisted(() => ({
  socketUrl: vi.fn((computerId: string) => `ws://localhost/api/computer?computer=${computerId}`),
}));
vi.mock('@/api/runtime-client', () => ({ computerWebSocketUrl: socketUrl }));
vi.mock('@/lib/screen-canvas', () => ({
  canDecodeVideo: () => true,
  ScreenCanvas: class {
    openVideo = vi.fn();
    openPictures = vi.fn();
    video = vi.fn();
    picture = vi.fn();
    onclose: (() => void) | null = null;
  close = vi.fn();
  },
}));

/** The socket the hook opened, with what the page sent on it. */
let socket: FakeSocket;

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = '';
  sent: string[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  send = (data: string) => this.sent.push(data);

  constructor() {
    socket = this;
  }
}

vi.stubGlobal('WebSocket', FakeSocket);

const { useComputerScreen } = await import('./use-computer-screen');

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('computer viewing', () => {
  it('opens independently of voice and receives ownership updates', () => {
    const { result } = renderHook(() => useComputerScreen({ enabled: true, onAudio: vi.fn() }));
    act(() => socket.onmessage?.({ data: JSON.stringify({
      type: 'computer_state', clientId: 'viewer', paused: true, controller: 'viewer', owner: null, waiting: [],
    }) } as MessageEvent));
    expect(result.current.clientId).toBe('viewer');
    expect(result.current.state?.paused).toBe(true);
    expect(socket.sent).toEqual([]);
  });

  it('clears control and reconnects after losing the connection', () => {
    const { result, unmount } = renderHook(() => useComputerScreen({ enabled: true, onAudio: vi.fn() }));
    const first = socket;
    act(() => first.onmessage?.({ data: JSON.stringify({
      type: 'computer_state', clientId: 'viewer', paused: true, controller: 'viewer', owner: null, waiting: [],
    }) } as MessageEvent));
    act(() => first.onclose?.());
    expect(result.current.clientId).toBeNull();
    expect(result.current.state).toBeNull();
    expect(result.current.hasScreen).toBe(false);
    act(() => vi.advanceTimersByTime(2000));
    expect(socket).not.toBe(first);
    unmount();
    expect(socket.close).toHaveBeenCalled();
  });

  it('clears control when viewing stops', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useComputerScreen({ enabled, onAudio: vi.fn() }),
      { initialProps: { enabled: true } },
    );
    act(() => socket.onmessage?.({ data: JSON.stringify({
      type: 'computer_state', clientId: 'viewer', paused: true, controller: 'viewer', owner: null, waiting: [],
    }) } as MessageEvent));
    rerender({ enabled: false });
    expect(result.current.clientId).toBeNull();
    expect(result.current.state).toBeNull();
  });

  it('opens the socket of the computer it shows, and a new one when that changes', () => {
    const { rerender } = renderHook(
      ({ computerId }) => useComputerScreen({ enabled: true, computerId, onAudio: vi.fn() }),
      { initialProps: { computerId: undefined as string | undefined } },
    );
    expect(socketUrl).toHaveBeenLastCalledWith('local');
    const first = socket;
    rerender({ computerId: 'laptop' });
    expect(socketUrl).toHaveBeenLastCalledWith('laptop');
    expect(first.close).toHaveBeenCalled();
    expect(socket).not.toBe(first);
  });

  it('takes the picture down when a remote computer disconnects', () => {
    const { result } = renderHook(() =>
      useComputerScreen({ enabled: true, computerId: 'laptop', onAudio: vi.fn() }),
    );
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'screen', data: 'AAAA' }) } as MessageEvent));
    expect(result.current.hasScreen).toBe(true);
    act(() => socket.onmessage?.({ data: JSON.stringify({
      type: 'computer_state', clientId: 'viewer', connection: 'disconnected', screen: false, paused: false,
      controller: null, owner: null, waiting: [],
    }) } as MessageEvent));
    expect(result.current.hasScreen).toBe(false);
    expect(result.current.state?.connection).toBe('disconnected');
  });

  it('takes the picture down when a connected computer stops sending its screen', () => {
    const { result } = renderHook(() =>
      useComputerScreen({ enabled: true, computerId: 'laptop', onAudio: vi.fn() }),
    );
    const state = (screen: boolean) =>
      act(() => socket.onmessage?.({ data: JSON.stringify({
        type: 'computer_state', clientId: 'viewer', connection: 'connected', screen, paused: false,
        controller: null, owner: null, waiting: [],
      }) } as MessageEvent));
    state(true);
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'screen', data: 'AAAA' }) } as MessageEvent));
    expect(result.current.hasScreen).toBe(true);
    state(false);
    expect(result.current.hasScreen).toBe(false);
  });
});
