// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Recording the screen the user is sharing.
 *
 * What is worth pinning is every way a recording ends, because each one leaves somebody
 * waiting: the user pressing stop, the length limit, the browser's own stop button, and
 * the page being left. The last hands nothing over on purpose — the call it was made for
 * is going with the page.
 */

import { MAX_RECORDING_MS, useScreenRecording } from './use-screen-recording';
import type { PageFrame } from './use-computer-screen';

/** The shared screen, with the track the browser would hand over. */
function fakeStream() {
  const track = {
    kind: 'video',
    listeners: {} as Record<string, () => void>,
    stop() {},
    addEventListener(name: string, handler: () => void) {
      this.listeners[name] = handler;
    },
    removeEventListener(name: string) {
      delete this.listeners[name];
    },
  };
  return {
    track,
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream & { track: typeof track };
}

/** What the next sample of the screen reads as, one byte a pixel before the grey step. */
let pixel = 10;

function stubCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4).fill(pixel),
        }),
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/jpeg;base64,PICTURE',
  );
}

describe('useScreenRecording', () => {
  let stream: ReturnType<typeof fakeStream>;
  let send: ReturnType<typeof vi.fn<(frame: PageFrame) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    pixel = 10;
    stream = fakeStream();
    send = vi.fn<(frame: PageFrame) => void>();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    // jsdom's video has no size, and a sample of a video with no size is skipped.
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { value: 1920, configurable: true });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { value: 1080, configurable: true });
    stubCanvas();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The frame types sent so far, in order. */
  function sentTypes(): string[] {
    return send.mock.calls.map((call) => call[0].type);
  }

  it('tells the runtime a recording began, then hands over the pictures and the end', () => {
    const view = renderHook(() => useScreenRecording(send));

    act(() => view.result.current.start(stream));
    expect(send).toHaveBeenCalledWith({ type: 'recording_started' });
    expect(view.result.current.recording).toBe(true);

    act(() => vi.advanceTimersByTime(1_000));
    // A changed screen is a picture worth keeping; an unchanged one is not.
    act(() => {
      pixel = 200;
      vi.advanceTimersByTime(250);
    });

    act(() => view.result.current.stop());

    // The pictures before the end, so the runtime has them all when it hands the
    // recording over.
    expect(sentTypes()).toEqual([
      'recording_started',
      'recording_frame',
      'recording_frame',
      'recording_stopped',
    ]);
    const end = send.mock.calls.at(-1)![0] as { type: string; reason: string };
    expect(end.reason).toBe('user');
    expect(view.result.current.recording).toBe(false);
  });

  it('keeps one picture of a screen that never changes', () => {
    const view = renderHook(() => useScreenRecording(send));
    act(() => view.result.current.start(stream));

    act(() => vi.advanceTimersByTime(4_000));
    act(() => view.result.current.stop());

    expect(sentTypes().filter((type) => type === 'recording_frame')).toHaveLength(1);
  });

  it('stops itself at the length limit', () => {
    const view = renderHook(() => useScreenRecording(send));
    act(() => view.result.current.start(stream));

    act(() => vi.advanceTimersByTime(MAX_RECORDING_MS));

    const end = send.mock.calls.at(-1)![0] as { type: string; reason: string };
    expect(end.type).toBe('recording_stopped');
    expect(end.reason).toBe('limit');
    expect(view.result.current.recording).toBe(false);
  });

  it("stops when the browser's own stop button ends the share", () => {
    const view = renderHook(() => useScreenRecording(send));
    act(() => view.result.current.start(stream));

    act(() => stream.track.listeners.ended?.());

    const end = send.mock.calls.at(-1)![0] as { type: string; reason: string };
    expect(end.type).toBe('recording_stopped');
    expect(end.reason).toBe('share_ended');
  });

  it('abandons a recording when the page is left', () => {
    const view = renderHook(() => useScreenRecording(send));
    act(() => view.result.current.start(stream));
    act(() => vi.advanceTimersByTime(1_000));

    view.unmount();

    // Nothing is handed over: the call it was made for is ending with the page.
    expect(sentTypes()).toEqual(['recording_started', 'recording_cancelled']);
  });

  /**
   * The pictures travel the screen's socket, and it does not come back once it closes.
   * Carrying on would hold the microphone until the length limit against a socket that
   * will never take the hand-over.
   */
  it('drops a recording that has nowhere to go, and says why', () => {
    const view = renderHook(() => useScreenRecording(send));
    act(() => view.result.current.start(stream));
    act(() => vi.advanceTimersByTime(2_000));

    act(() => view.result.current.abandon('the screen went away'));

    expect(view.result.current.recording).toBe(false);
    expect(view.result.current.error).toBe('the screen went away');
    // No pictures and no end: nothing is claiming this recording was handed over.
    expect(sentTypes()).toEqual(['recording_started', 'recording_cancelled']);
  });

  it('has nothing to abandon when no recording is running', () => {
    const view = renderHook(() => useScreenRecording(send));

    act(() => view.result.current.abandon('nothing to drop'));

    expect(send).not.toHaveBeenCalled();
    expect(view.result.current.error).toBeNull();
  });

  it('reports elapsed time in whole seconds, so the page does not redraw four times a second', () => {
    const view = renderHook(() => useScreenRecording(send));
    act(() => view.result.current.start(stream));

    act(() => vi.advanceTimersByTime(2_500));

    expect(view.result.current.elapsedMs).toBe(2_000);
  });

  it('refuses a stream with no picture in it', () => {
    const view = renderHook(() => useScreenRecording(send));
    const soundOnly = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;

    act(() => view.result.current.start(soundOnly));

    expect(view.result.current.recording).toBe(false);
    expect(view.result.current.error).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
});
