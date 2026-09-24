// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const startVoiceAudio = vi.fn();

vi.mock('@/lib/voice-audio', () => ({
  VOICE_SAMPLE_RATE: 24_000,
  startVoiceAudio: (...args: unknown[]) => startVoiceAudio(...args),
}));

import { useDictation, type UseDictationOptions } from './use-dictation';

const HELLO_FORMAT = { encoding: 'pcm16', sampleRate: 24_000, channels: 1 };

/** 20 ms of a loud tone, as the microphone hands it over. */
function tone(): ArrayBuffer {
  const samples = new Int16Array(480);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(Math.sin(i / 3) * 20_000);
  return samples.buffer;
}

describe('useDictation', () => {
  let audio: { enqueue: Mock; clear: Mock; stop: Mock };
  let sendDictationStart: Mock<() => boolean>;
  let sendDictationStop: Mock<(commit: boolean) => void>;
  let sendAudio: Mock<(frame: ArrayBuffer) => void>;
  let onTranscript: Mock<(text: string) => void>;
  /** What the hook passed to `startVoiceAudio`, so a test can speak into it. */
  let captured: { onFrame: (f: ArrayBuffer) => void };

  beforeEach(() => {
    audio = { enqueue: vi.fn(), clear: vi.fn(), stop: vi.fn(async () => {}) };
    sendDictationStart = vi.fn(() => true);
    sendDictationStop = vi.fn();
    sendAudio = vi.fn();
    onTranscript = vi.fn();
    startVoiceAudio.mockReset();
    startVoiceAudio.mockImplementation(async (opts: typeof captured) => {
      captured = opts;
      return audio;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function render(overrides: Partial<UseDictationOptions> = {}) {
    const props: UseDictationOptions = {
      sendDictationStart,
      sendDictationStop,
      sendAudio,
      isConnected: true,
      onTranscript,
      ...overrides,
    };
    return renderHook((p: UseDictationOptions) => useDictation(p), { initialProps: props });
  }

  async function renderRecording(overrides: Partial<UseDictationOptions> = {}) {
    const utils = render(overrides);
    act(() => utils.result.current.start());
    await waitFor(() => expect(utils.result.current.status).toBe('recording'));
    return utils;
  }

  it('opens the microphone before it asks the runtime to transcribe', async () => {
    const { result } = render();

    act(() => result.current.start());
    expect(result.current.status).toBe('starting');
    expect(sendDictationStart).not.toHaveBeenCalled();

    await waitFor(() => expect(result.current.status).toBe('recording'));
    expect(sendDictationStart).toHaveBeenCalledTimes(1);
    expect(result.current.startedAt).not.toBeNull();
  });

  it('streams the microphone while recording', async () => {
    await renderRecording();
    const frame = tone();

    act(() => captured.onFrame(frame));

    expect(sendAudio).toHaveBeenCalledWith(frame);
  });

  it('sends the transcript as the message once the runtime answers', async () => {
    const { result } = await renderRecording();

    act(() => result.current.send());
    expect(result.current.status).toBe('transcribing');
    expect(sendDictationStop).toHaveBeenCalledWith(true);
    expect(audio.stop).toHaveBeenCalled();

    act(() => result.current.handleEvent({ type: 'hello', format: HELLO_FORMAT }));
    act(() => result.current.handleEvent({ type: 'delta', text: 'Check ' }));
    act(() => result.current.handleEvent({ type: 'result', text: '  Check the staging pods.  ' }));

    expect(onTranscript).toHaveBeenCalledWith('Check the staging pods.');
    expect(result.current.status).toBe('idle');
  });

  it('sends nothing for a recording with no speech, and says so', async () => {
    const { result } = await renderRecording();

    act(() => result.current.send());
    act(() => result.current.handleEvent({ type: 'result', text: '' }));

    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.error).toBe('No speech was heard.');
  });

  it('discards a recording and ignores a result that arrives anyway', async () => {
    const { result } = await renderRecording();

    act(() => result.current.cancel());
    expect(sendDictationStop).toHaveBeenCalledWith(false);
    expect(result.current.status).toBe('idle');

    act(() => result.current.handleEvent({ type: 'result', text: 'too late' }));
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('stops the runtime when a transcript is abandoned while it is on its way', async () => {
    const { result } = await renderRecording();

    act(() => result.current.send());
    act(() => result.current.cancel());

    expect(sendDictationStop.mock.calls).toEqual([[true], [false]]);
  });

  it('gives up on a transcript that never arrives, and stops the runtime', async () => {
    const { result } = await renderRecording({ resultTimeoutMs: 20 });

    act(() => result.current.send());

    await waitFor(() => expect(result.current.error).toBe('The transcript did not arrive. Try again.'));
    expect(sendDictationStop).toHaveBeenLastCalledWith(false);
  });

  it('says why the runtime refused, and releases the microphone', async () => {
    const { result } = await renderRecording();

    act(() =>
      result.current.handleEvent({
        type: 'error',
        error: 'Dictation needs a managed voice provider for this agent.',
      }),
    );

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBe('Dictation needs a managed voice provider for this agent.');
    expect(audio.stop).toHaveBeenCalled();
  });

  it('refuses a format this browser does not record', async () => {
    const { result } = await renderRecording();

    act(() =>
      result.current.handleEvent({ type: 'hello', format: { ...HELLO_FORMAT, sampleRate: 48_000 } }),
    );

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBe('The agent asked for audio this browser does not record.');
  });

  it('tells the runtime nothing when the microphone is blocked', async () => {
    const blocked = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    startVoiceAudio.mockRejectedValueOnce(blocked);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = render();

    act(() => result.current.start());

    await waitFor(() =>
      expect(result.current.error).toBe(
        'The microphone is blocked. Allow it in the browser, then try again.',
      ),
    );
    expect(sendDictationStart).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('refuses to start while disconnected', () => {
    const { result } = render({ isConnected: false });

    act(() => result.current.start());

    expect(startVoiceAudio).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Not connected to the agent right now.');
  });

  it('ends the dictation when the connection drops', async () => {
    const { result, rerender } = await renderRecording();

    rerender({
      sendDictationStart,
      sendDictationStop,
      sendAudio,
      isConnected: false,
      onTranscript,
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBe('The connection dropped, so the dictation ended.');
    expect(audio.stop).toHaveBeenCalled();
  });

  it('scrolls the waveform with the loudest reading since the last tick', async () => {
    const { result } = await renderRecording();

    act(() => captured.onFrame(tone()));

    await waitFor(() => expect(result.current.levels.at(-1)).toBeGreaterThan(0.5));
    expect(result.current.levels).toHaveLength(64);
  });

  it('scrolls through silence too, so a pause draws as a flat stretch', async () => {
    const { result } = await renderRecording();

    act(() => captured.onFrame(tone()));
    await waitFor(() => expect(result.current.levels.at(-1)).toBeGreaterThan(0.5));
    // No frames at all: the next ticks still move the loud reading left.
    await waitFor(() => expect(result.current.levels.at(-1)).toBe(0));
    expect(result.current.levels.some((level) => level > 0.5)).toBe(true);
  });

  it('ignores a prompt that fails after its press was cancelled and another began', async () => {
    let rejectFirst: (err: Error) => void = () => {};
    startVoiceAudio.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectFirst = reject)),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = render();

    act(() => result.current.start());
    act(() => result.current.cancel());
    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe('recording'));

    await act(async () => rejectFirst(new Error('device claimed')));

    expect(result.current.status).toBe('recording');
    expect(result.current.error).toBeNull();
  });
});
