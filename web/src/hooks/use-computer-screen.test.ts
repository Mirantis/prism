// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/api/runtime-client', () => ({
  computerWebSocketUrl: () => 'ws://localhost/api/computer',
}));
vi.mock('@/lib/screen-canvas', () => ({
  canDecodeVideo: () => true,
  ScreenCanvas: class {
    openVideo = vi.fn();
    openPictures = vi.fn();
    video = vi.fn();
    picture = vi.fn();
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
  close = vi.fn();
  send = (data: string) => this.sent.push(data);

  constructor() {
    socket = this;
  }
}

vi.stubGlobal('WebSocket', FakeSocket);

const { useComputerScreen } = await import('./use-computer-screen');

/** The sizes the page reported, as `viewport` changes on a live socket. */
function renderAt(viewport: { width: number; height: number }) {
  return renderHook(
    ({ size }) => useComputerScreen({ enabled: true, viewport: size, onAudio: vi.fn() }),
    { initialProps: { size: viewport } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('telling the runtime what size to make the screen', () => {
  it('says nothing about the size it opened with', () => {
    renderAt({ width: 1280, height: 720 });
    expect(socket.sent).toEqual([]);
  });

  it('sends a size the page changed to', () => {
    const { rerender } = renderAt({ width: 1280, height: 720 });

    act(() => rerender({ size: { width: 1920, height: 1080 } }));

    expect(socket.sent).toEqual([JSON.stringify({ type: 'viewport', width: 1920, height: 1080 })]);
  });

  it('sends the way back from fullscreen, not only the way in', () => {
    const { rerender } = renderAt({ width: 1280, height: 720 });

    // Into fullscreen and out again. The size on the way back is the one the socket
    // opened with, and comparing against that would read it as no change — leaving the
    // desktop at its fullscreen size, scaled into a smaller canvas.
    act(() => rerender({ size: { width: 1920, height: 1080 } }));
    act(() => rerender({ size: { width: 1280, height: 720 } }));

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'viewport', width: 1920, height: 1080 }),
      JSON.stringify({ type: 'viewport', width: 1280, height: 720 }),
    ]);
  });

  it('says nothing when the size settles where it already was', () => {
    const { rerender } = renderAt({ width: 1280, height: 720 });

    act(() => rerender({ size: { width: 1920, height: 1080 } }));
    act(() => rerender({ size: { width: 1920, height: 1080 } }));

    expect(socket.sent).toHaveLength(1);
  });
});
