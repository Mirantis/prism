// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * Sharing the user's own screen with the agent.
 *
 * What is worth pinning is every way a share can outlive the thing it was for: the page
 * being left while the browser's picker is still open, a share ending inside the wait for
 * its first picture, and the remount React does in development. Each of them leaves the
 * browser capturing somebody's screen with nobody watching it.
 */

import { useScreenShare } from './use-screen-share';
import type { PageFrame } from './use-computer-screen';

/** A display capture, with the tracks the browser would hand over. */
function fakeStream() {
  const track = {
    kind: 'video',
    stopped: false,
    listeners: {} as Record<string, () => void>,
    stop() {
      this.stopped = true;
    },
    addEventListener(name: string, handler: () => void) {
      this.listeners[name] = handler;
    },
  };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

describe('useScreenShare', () => {
  let stream: ReturnType<typeof fakeStream>;
  let getDisplayMedia: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn<(frame: PageFrame) => void>>;

  beforeEach(() => {
    stream = fakeStream();
    getDisplayMedia = vi.fn(async () => stream);
    send = vi.fn<(frame: PageFrame) => void>();
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
    // jsdom draws nothing, so the capture reads a video with no size and sends no picture.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('tells the runtime a share began, and stops it when asked', async () => {
    const view = renderHook(() => useScreenShare(send));

    await act(() => view.result.current.start());
    expect(send).toHaveBeenCalledWith({ type: 'user_screen_started' });
    expect(view.result.current.sharing).toBe(true);

    act(() => view.result.current.stop());
    expect(send).toHaveBeenCalledWith({ type: 'user_screen_stopped' });
    expect(stream.track.stopped).toBe(true);
  });

  it("stops when the browser's own stop button ends the track", async () => {
    const view = renderHook(() => useScreenShare(send));
    await act(() => view.result.current.start());

    act(() => stream.track.listeners.ended?.());

    expect(view.result.current.sharing).toBe(false);
    expect(send).toHaveBeenCalledWith({ type: 'user_screen_stopped' });
  });

  it('releases the capture when the page is left', async () => {
    const view = renderHook(() => useScreenShare(send));
    await act(() => view.result.current.start());

    view.unmount();

    // The track is what the browser's sharing indicator follows.
    expect(stream.track.stopped).toBe(true);
  });

  it('stops a capture the picker handed over after the page was left', async () => {
    const view = renderHook(() => useScreenShare(send));
    let hand: ((s: unknown) => void) | undefined;
    getDisplayMedia.mockImplementationOnce(() => new Promise((resolve) => {
      hand = resolve;
    }));

    const pending = view.result.current.start();
    // The picker is the user's own dialog and stays open as long as they take over it,
    // which is long enough to leave the page.
    view.unmount();
    hand?.(stream);
    await act(async () => {
      await pending;
    });

    expect(stream.track.stopped).toBe(true);
    expect(send).not.toHaveBeenCalledWith({ type: 'user_screen_started' });
  });

  it('stops a capture the page was left in the middle of starting', async () => {
    // The gap this covers is the second await, not the first: the picker has already
    // handed the stream over, and the video is still starting when the page goes. A
    // cleanup that only knows about published sessions finds nothing and leaves the
    // browser capturing the user's screen.
    let startPlaying: () => void = () => {};
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      () => new Promise<void>((resolve) => (startPlaying = resolve)),
    );

    const view = renderHook(() => useScreenShare(send));
    let starting!: Promise<MediaStream | null>;
    act(() => {
      starting = view.result.current.start();
    });
    await waitFor(() => expect(getDisplayMedia).toHaveBeenCalled());

    view.unmount();
    await act(async () => {
      startPlaying();
      await starting;
    });

    expect(stream.track.stopped).toBe(true);
    expect(send).not.toHaveBeenCalledWith({ type: 'user_screen_started' });
  });

  it('stops a capture that stop() cancelled while it was starting', async () => {
    let startPlaying: () => void = () => {};
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      () => new Promise<void>((resolve) => (startPlaying = resolve)),
    );

    const view = renderHook(() => useScreenShare(send));
    let starting!: Promise<MediaStream | null>;
    act(() => {
      starting = view.result.current.start();
    });
    await waitFor(() => expect(getDisplayMedia).toHaveBeenCalled());

    act(() => view.result.current.stop());
    await act(async () => {
      startPlaying();
      await starting;
    });

    expect(stream.track.stopped).toBe(true);
    expect(view.result.current.sharing).toBe(false);
    expect(send).not.toHaveBeenCalledWith({ type: 'user_screen_started' });
  });

  it('still shares under the double mount React makes in development', async () => {
    // StrictMode runs the effect, its cleanup, and the effect again on the same hook, to
    // shake out exactly this: state kept across an effect and only ever torn down. A flag
    // cleared on the way out and not set on the way in stays cleared for the life of the
    // page, and every share afterwards stops itself the moment the picker hands one over.
    const view = renderHook(() => useScreenShare(send), { wrapper: StrictMode });

    await act(() => view.result.current.start());

    await waitFor(() => expect(view.result.current.sharing).toBe(true));
    expect(stream.track.stopped).toBe(false);
    expect(send).toHaveBeenCalledWith({ type: 'user_screen_started' });
  });
});
