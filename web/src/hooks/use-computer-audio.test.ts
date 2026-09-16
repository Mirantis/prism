// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { startVoiceAudio } from '@/lib/voice-audio';
import { useComputerAudio } from './use-computer-audio';

vi.mock('@/lib/voice-audio', () => ({ startVoiceAudio: vi.fn() }));
const playback = {
  resume: vi.fn(),
  stop: vi.fn(async () => {}),
  enqueue: vi.fn(),
  enqueueComputer: vi.fn(),
  clear: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(startVoiceAudio).mockResolvedValue(playback);
});

it('starts desktop playback without capturing the microphone and resumes after a gesture', async () => {
  const { result, unmount } = renderHook(useComputerAudio);
  await waitFor(() =>
    expect(startVoiceAudio).toHaveBeenCalledWith(expect.objectContaining({ capture: false })),
  );
  expect(result.current.enabled).toBe(true);
  await act(async () => document.dispatchEvent(new Event('pointerdown')));
  expect(playback.resume).toHaveBeenCalled();
  act(() => result.current.toggle());
  expect(result.current.enabled).toBe(false);
  expect(playback.stop).toHaveBeenCalledOnce();
  unmount();
});

it('closes playback that finishes opening after the user mutes', async () => {
  let finish!: (audio: typeof playback) => void;
  vi.mocked(startVoiceAudio).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, unmount } = renderHook(useComputerAudio);
  act(() => result.current.toggle());
  await act(async () => finish(playback));
  expect(playback.stop).toHaveBeenCalledOnce();
  expect(result.current.enabled).toBe(false);
  unmount();
});
