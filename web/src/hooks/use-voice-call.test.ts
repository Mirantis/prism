// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const startVoiceAudio = vi.fn();

vi.mock('@/lib/voice-audio', () => ({
  VOICE_SAMPLE_RATE: 24_000,
  startVoiceAudio: (...args: unknown[]) => startVoiceAudio(...args),
}));

import { useVoiceCall, type UseVoiceCallOptions } from './use-voice-call';
import type { VoiceStartOptions } from './use-websocket';

/** The audio side of a call, as `startVoiceAudio` hands it over. */
function fakeAudio() {
  return {
    enqueue: vi.fn(),
    clear: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

const HELLO_FORMAT = { encoding: 'pcm16', sampleRate: 24_000, channels: 1 };

describe('useVoiceCall', () => {
  let audio: ReturnType<typeof fakeAudio>;
  let sendVoiceStart: Mock<(options: VoiceStartOptions) => boolean>;
  let sendVoiceStop: Mock<() => void>;
  let sendVoiceAudio: Mock<(frame: ArrayBuffer) => void>;
  /** What the hook passed to `startVoiceAudio`, so a test can feed it a frame. */
  let captured: { onFrame: (f: ArrayBuffer) => void; onSpeaking?: (s: boolean) => void };

  beforeEach(() => {
    audio = fakeAudio();
    sendVoiceStart = vi.fn<(options: VoiceStartOptions) => boolean>(() => true);
    sendVoiceStop = vi.fn<() => void>();
    sendVoiceAudio = vi.fn<(frame: ArrayBuffer) => void>();
    startVoiceAudio.mockReset();
    startVoiceAudio.mockImplementation(async (opts: typeof captured) => {
      captured = opts;
      return audio;
    });
  });

  function render(overrides: Partial<UseVoiceCallOptions> = {}) {
    const props: UseVoiceCallOptions = {
      sendVoiceStart,
      sendVoiceStop,
      sendVoiceAudio,
      threadId: 't1',
      isConnected: true,
      ...overrides,
    };
    return renderHook((p: UseVoiceCallOptions) => useVoiceCall(p), { initialProps: props });
  }

  /** Start a call and take it live, the way the runtime does. */
  async function renderLive() {
    const utils = render();
    act(() => utils.result.current.start());
    await waitFor(() => expect(sendVoiceStart).toHaveBeenCalled());
    act(() => utils.result.current.handleEvent({ type: 'state', state: 'live' }));
    expect(utils.result.current.status).toBe('live');
    return utils;
  }

  it('opens the microphone before it asks for a session', async () => {
    const { result } = render();

    act(() => result.current.start());

    expect(result.current.status).toBe('starting');
    // The order matters: a denied microphone must not leave the runtime holding a
    // session nobody can talk to.
    expect(startVoiceAudio).toHaveBeenCalledTimes(1);
    expect(sendVoiceStart).not.toHaveBeenCalled();

    await waitFor(() => expect(sendVoiceStart).toHaveBeenCalledWith({ threadId: 't1' }));
    expect(result.current.error).toBeNull();
  });

  it('goes live and streams the microphone', async () => {
    const { result } = await renderLive();

    const frame = new Int16Array([1, 2]).buffer;
    captured.onFrame(frame);

    expect(sendVoiceAudio).toHaveBeenCalledWith(frame);
    expect(result.current.error).toBeNull();
  });

  it('plays the agent audio and reports it as speech', async () => {
    const { result } = await renderLive();

    const frame = new Int16Array([3, 4]).buffer;
    act(() => result.current.handleAudio(frame));
    expect(audio.enqueue).toHaveBeenCalledWith(frame);

    act(() => captured.onSpeaking?.(true));
    expect(result.current.isSpeaking).toBe(true);
  });

  it('drops what has not played when the agent is interrupted', async () => {
    const { result } = await renderLive();
    act(() => captured.onSpeaking?.(true));

    act(() => result.current.handleEvent({ type: 'clear' }));

    expect(audio.clear).toHaveBeenCalledTimes(1);
    expect(result.current.isSpeaking).toBe(false);
    // A barge-in is not the end of the call.
    expect(result.current.status).toBe('live');
  });

  it('releases the microphone when the user ends the call', async () => {
    const { result } = await renderLive();

    act(() => result.current.stop());

    expect(sendVoiceStop).toHaveBeenCalledTimes(1);
    // Released on the click, not when the runtime answers: the recording indicator is
    // what the user is watching.
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('returns to idle when the runtime says the session ended', async () => {
    const { result } = await renderLive();

    act(() => result.current.handleEvent({ type: 'state', state: 'ended' }));

    expect(result.current.status).toBe('idle');
    expect(audio.stop).toHaveBeenCalledTimes(1);
    // An ending the runtime reported is not a failure, so there is nothing to say.
    expect(result.current.error).toBeNull();
  });

  describe('refusals reach the user as words', () => {
    it('a second voice chat', async () => {
      const { result } = render();
      act(() => result.current.start());
      await waitFor(() => expect(sendVoiceStart).toHaveBeenCalled());

      const refusal = 'There is already a voice chat running. End that one first.';
      act(() => result.current.handleEvent({ type: 'error', error: refusal }));

      expect(result.current.error).toBe(refusal);
      // Back to a control that can be pressed again, with the microphone released:
      // a refusal arrives with no `ended` behind it.
      expect(result.current.status).toBe('idle');
      expect(audio.stop).toHaveBeenCalledTimes(1);
    });

    it('a meeting call already running', async () => {
      const { result } = render();
      act(() => result.current.start());
      await waitFor(() => expect(sendVoiceStart).toHaveBeenCalled());

      const refusal = `I'm in a meeting call right now. That has to end before I can talk here.`;
      act(() => result.current.handleEvent({ type: 'error', error: refusal }));

      expect(result.current.error).toBe(refusal);
      expect(result.current.status).toBe('idle');
    });

    it('a session that failed to start', async () => {
      const { result } = render();
      act(() => result.current.start());
      await waitFor(() => expect(sendVoiceStart).toHaveBeenCalled());

      const refusal = 'Could not start the voice chat: the model refused the session';
      act(() => result.current.handleEvent({ type: 'error', error: refusal }));

      expect(result.current.error).toBe(refusal);
      expect(result.current.status).toBe('idle');
    });

    it('a denied microphone, which the runtime never hears about', async () => {
      const denied = new Error('Permission denied');
      denied.name = 'NotAllowedError';
      startVoiceAudio.mockRejectedValueOnce(denied);

      const { result } = render();
      act(() => result.current.start());

      await waitFor(() => expect(result.current.status).toBe('idle'));
      expect(result.current.error).toBe(
        'The microphone is blocked. Allow it in the browser, then start the call again.',
      );
      // Nothing was asked of the runtime, so nothing has to be told to end.
      expect(sendVoiceStart).not.toHaveBeenCalled();
      expect(sendVoiceStop).not.toHaveBeenCalled();
    });

    it('a microphone that failed for another reason', async () => {
      startVoiceAudio.mockRejectedValueOnce(new Error('Requested device not found'));

      const { result } = render();
      act(() => result.current.start());

      await waitFor(() => expect(result.current.error).toBe('Could not open the microphone.'));
      expect(result.current.status).toBe('idle');
    });

    it('a socket that is not connected', () => {
      const { result } = render({ isConnected: false });

      act(() => result.current.start());

      expect(result.current.error).toBe('Not connected to the agent right now.');
      expect(startVoiceAudio).not.toHaveBeenCalled();
      expect(result.current.status).toBe('idle');
    });

    it('a connection that dropped mid-call', async () => {
      const { result, rerender } = await renderLive();

      rerender({
        sendVoiceStart,
        sendVoiceStop,
        sendVoiceAudio,
        threadId: 't1',
        isConnected: false,
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.error).toBe('The connection dropped, so the call ended.');
      expect(audio.stop).toHaveBeenCalledTimes(1);
    });

    it('an audio format this browser cannot play', async () => {
      const { result } = render();
      act(() => result.current.start());
      await waitFor(() => expect(sendVoiceStart).toHaveBeenCalled());

      act(() =>
        result.current.handleEvent({
          type: 'hello',
          format: { ...HELLO_FORMAT, sampleRate: 48_000 },
        }),
      );

      expect(result.current.error).toBe('The agent offered audio this browser cannot play.');
      expect(result.current.status).toBe('idle');
      // The runtime is told, since it opened a session that is now unwanted.
      expect(sendVoiceStop).toHaveBeenCalledTimes(1);
    });

    it('clears the last refusal when the next call starts', async () => {
      const { result } = render();
      act(() => result.current.start());
      await waitFor(() => expect(sendVoiceStart).toHaveBeenCalled());
      act(() => result.current.handleEvent({ type: 'error', error: 'no' }));
      expect(result.current.error).toBe('no');

      act(() => result.current.start());

      expect(result.current.error).toBeNull();
    });
  });

  it('accepts the format the runtime states and keeps the call', async () => {
    const { result } = await renderLive();

    act(() => result.current.handleEvent({ type: 'hello', format: HELLO_FORMAT }));

    expect(result.current.status).toBe('live');
    expect(result.current.error).toBeNull();
    expect(sendVoiceStop).not.toHaveBeenCalled();
  });

  describe('muting the microphone', () => {
    it('stops the frames leaving while the call runs on', async () => {
      const { result } = await renderLive();

      act(() => result.current.toggleMute());

      captured.onFrame(new Int16Array([1, 2]).buffer);
      expect(sendVoiceAudio).not.toHaveBeenCalled();
      expect(result.current.isMuted).toBe(true);
      // The session, the claim on it and the microphone all stay as they were: the
      // runtime is told nothing, so there is nothing for it to end.
      expect(result.current.status).toBe('live');
      expect(sendVoiceStop).not.toHaveBeenCalled();
      expect(audio.stop).not.toHaveBeenCalled();
    });

    it('lets the frames out again, on the session that was already open', async () => {
      const { result } = await renderLive();
      act(() => result.current.toggleMute());
      captured.onFrame(new Int16Array([1, 2]).buffer);

      act(() => result.current.toggleMute());

      const frame = new Int16Array([3, 4]).buffer;
      captured.onFrame(frame);
      expect(sendVoiceAudio).toHaveBeenCalledTimes(1);
      expect(sendVoiceAudio).toHaveBeenCalledWith(frame);
      expect(result.current.isMuted).toBe(false);
      // The microphone was never released and no second session was asked for, so
      // unmuting costs neither a permission prompt nor a new call.
      expect(startVoiceAudio).toHaveBeenCalledTimes(1);
      expect(sendVoiceStart).toHaveBeenCalledTimes(1);
    });

    it('keeps playing the agent while the microphone is muted', async () => {
      const { result } = await renderLive();
      act(() => result.current.toggleMute());

      const frame = new Int16Array([5, 6]).buffer;
      act(() => result.current.handleAudio(frame));

      // Only one direction is muted.
      expect(audio.enqueue).toHaveBeenCalledWith(frame);
    });

    it('does not outlive the call it was made in', async () => {
      const { result } = await renderLive();
      act(() => result.current.toggleMute());

      act(() => result.current.stop());
      expect(result.current.isMuted).toBe(false);

      act(() => result.current.start());
      await waitFor(() => expect(sendVoiceStart).toHaveBeenCalledTimes(2));
      captured.onFrame(new Int16Array([7, 8]).buffer);

      expect(sendVoiceAudio).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses a second start while a call is running', async () => {
    const { result } = await renderLive();

    act(() => result.current.start());

    // One call per client, enforced here so the runtime is never asked twice.
    expect(startVoiceAudio).toHaveBeenCalledTimes(1);
    expect(sendVoiceStart).toHaveBeenCalledTimes(1);
  });

  it('releases the microphone if the call is ended while it is still starting', async () => {
    let resolveAudio: ((a: typeof audio) => void) | undefined;
    startVoiceAudio.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAudio = resolve as (a: typeof audio) => void;
        }),
    );

    const { result } = render();
    act(() => result.current.start());
    act(() => result.current.stop());
    expect(result.current.status).toBe('idle');

    // The permission dialog was answered after the user gave up. The microphone it
    // opened has to go, and no session may be asked for.
    await act(async () => {
      resolveAudio!(audio);
      await Promise.resolve();
    });

    await waitFor(() => expect(audio.stop).toHaveBeenCalledTimes(1));
    expect(sendVoiceStart).not.toHaveBeenCalled();
  });

  /**
   * The speaker, not the call. The runtime goes on sending and the model goes on
   * generating; what this has to do is stop the sound at once, which means dropping what
   * the playback already holds rather than letting the buffer drain.
   */
  describe('silencing what the agent says', () => {
    it('drops what is queued and refuses more until it is turned back on', async () => {
      const { result } = await renderLive();

      act(() => result.current.handleAudio(new ArrayBuffer(8)));
      expect(audio.enqueue).toHaveBeenCalledTimes(1);

      act(() => result.current.setPlaybackMuted(true));
      expect(audio.clear).toHaveBeenCalledTimes(1);

      act(() => result.current.handleAudio(new ArrayBuffer(8)));
      expect(audio.enqueue).toHaveBeenCalledTimes(1);

      act(() => result.current.setPlaybackMuted(false));
      act(() => result.current.handleAudio(new ArrayBuffer(8)));
      expect(audio.enqueue).toHaveBeenCalledTimes(2);
    });

    it('clears once, however often it is told the same thing', async () => {
      const { result } = await renderLive();

      act(() => result.current.setPlaybackMuted(true));
      act(() => result.current.setPlaybackMuted(true));

      expect(audio.clear).toHaveBeenCalledTimes(1);
    });

    /** The desktop's sound rides the same playback, so it goes quiet with the rest. */
    it('silences the desktop the agent is working on too', async () => {
      const { result } = await renderLive();
      act(() => result.current.setPlaybackMuted(true));

      act(() => result.current.handleComputerAudio(new ArrayBuffer(8)));

      expect(audio.enqueue).not.toHaveBeenCalled();
    });
  });

});
