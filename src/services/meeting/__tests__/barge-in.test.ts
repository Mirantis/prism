import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BargeInPolicy, BACKCHANNEL_GRACE_MS } from '../barge-in';

function makeHandlers(speaking = true) {
  const calls: string[] = [];
  let isSpeaking = speaking;
  return {
    calls,
    setSpeaking: (v: boolean) => {
      isSpeaking = v;
    },
    handlers: {
      pausePlayback: () => calls.push('pause'),
      resumePlayback: () => calls.push('resume'),
      commitInterrupt: () => calls.push('commit'),
      isSpeaking: () => isSpeaking,
    },
  };
}

describe('BargeInPolicy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('goes quiet immediately when a human starts talking over the bot', () => {
    const { calls, handlers } = makeHandlers();
    const policy = new BargeInPolicy(handlers);

    policy.onSpeechStarted();

    // The pause is instant; the interruption is not yet committed.
    expect(calls).toEqual(['pause']);
  });

  it('resumes instead of interrupting when the speech was a backchannel', () => {
    const { calls, handlers } = makeHandlers();
    const policy = new BargeInPolicy(handlers);

    policy.onSpeechStarted();
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS - 100);
    policy.onSpeechStopped();
    vi.advanceTimersByTime(1000);

    // An "mm-hm" must not cost the bot its sentence.
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('commits the interruption when the speech persists past the grace period', () => {
    const { calls, handlers } = makeHandlers();
    const policy = new BargeInPolicy(handlers);

    policy.onSpeechStarted();
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS + 1);

    expect(calls).toEqual(['pause', 'commit']);
  });

  it('does nothing when the bot is not speaking', () => {
    const { calls, handlers } = makeHandlers(false);
    const policy = new BargeInPolicy(handlers);

    policy.onSpeechStarted();
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS + 1);

    // Someone talking while the bot is silent is just conversation.
    expect(calls).toEqual([]);
  });

  it('ignores a second speech-start while a decision is pending', () => {
    const { calls, handlers } = makeHandlers();
    const policy = new BargeInPolicy(handlers);

    policy.onSpeechStarted();
    policy.onSpeechStarted();
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS + 1);

    expect(calls).toEqual(['pause', 'commit']);
  });

  it('does not commit twice for one utterance', () => {
    const { calls, handlers } = makeHandlers();
    const policy = new BargeInPolicy(handlers);

    policy.onSpeechStarted();
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS + 1);
    policy.onSpeechStarted();
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS + 1);

    expect(calls.filter((c) => c === 'commit')).toHaveLength(1);
  });

  it('re-arms for the next utterance', () => {
    const { calls, handlers } = makeHandlers();
    const policy = new BargeInPolicy(handlers);

    policy.onSpeechStarted();
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS + 1);
    policy.onUtteranceStarted();
    policy.onSpeechStarted();
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS + 1);

    expect(calls.filter((c) => c === 'commit')).toHaveLength(2);
  });

  it('commits a pending pause on demand so stale audio is dropped first', () => {
    const { calls, handlers } = makeHandlers();
    const policy = new BargeInPolicy(handlers);

    policy.onSpeechStarted();
    policy.commitIfPending();

    // Committed early — a new utterance is about to queue behind it.
    expect(calls).toEqual(['pause', 'commit']);
    // And the pending timer must not fire a second commit.
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS + 1);
    expect(calls.filter((c) => c === 'commit')).toHaveLength(1);
  });

  it('commitIfPending is a no-op when nothing is pending', () => {
    const { calls, handlers } = makeHandlers();
    const policy = new BargeInPolicy(handlers);

    policy.commitIfPending();

    expect(calls).toEqual([]);
  });

  it('cancels a pending decision on dispose', () => {
    const { calls, handlers } = makeHandlers();
    const policy = new BargeInPolicy(handlers);

    policy.onSpeechStarted();
    policy.dispose();
    vi.advanceTimersByTime(BACKCHANNEL_GRACE_MS + 1);

    expect(calls).toEqual(['pause']);
  });
});
