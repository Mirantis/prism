import { describe, it, expect, afterEach } from 'vitest';
import { voiceSessionLock } from '../voice-session-lock';

afterEach(() => {
  voiceSessionLock.release('meeting');
  voiceSessionLock.release('voice-chat');
});

describe('the one live voice session', () => {
  it('gives the lock to the first caller and refuses the second', () => {
    expect(voiceSessionLock.tryAcquire('voice-chat')).toBe(true);
    // A Meet call while a voice chat is live is the refusal this exists for.
    expect(voiceSessionLock.tryAcquire('meeting')).toBe(false);
    expect(voiceSessionLock.holder).toBe('voice-chat');
  });

  it('refuses a second session of the same kind', () => {
    expect(voiceSessionLock.tryAcquire('voice-chat')).toBe(true);
    expect(voiceSessionLock.tryAcquire('voice-chat')).toBe(false);
  });

  it('frees the lock for the other owner once the holder lets go', () => {
    voiceSessionLock.tryAcquire('meeting');
    voiceSessionLock.release('meeting');

    expect(voiceSessionLock.holder).toBeNull();
    expect(voiceSessionLock.tryAcquire('voice-chat')).toBe(true);
  });

  it('ignores a release from anything but the holder', () => {
    voiceSessionLock.tryAcquire('voice-chat');

    // Every exit path releases, and several of them run for a session that has already
    // ended — so a stray release must not hand the live session's voice away.
    voiceSessionLock.release('meeting');
    voiceSessionLock.release('meeting');

    expect(voiceSessionLock.holder).toBe('voice-chat');
  });

  it('takes a repeated release from the holder as one', () => {
    voiceSessionLock.tryAcquire('meeting');
    voiceSessionLock.release('meeting');
    voiceSessionLock.tryAcquire('voice-chat');
    // The meeting's second release site, running late. The voice chat keeps the lock.
    voiceSessionLock.release('meeting');

    expect(voiceSessionLock.holder).toBe('voice-chat');
  });
});
