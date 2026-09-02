/**
 * The one live voice session in the runtime.
 *
 * The agent has one voice, so a Google Meet call and a browser voice chat exclude each
 * other. Both owners take this lock rather than keeping a guard each, which is what makes
 * the refusal correct in both directions.
 */

/** Which owner holds a voice session. */
export type VoiceSessionKind = 'meeting' | 'voice-chat';

class VoiceSessionLock {
  private held: VoiceSessionKind | null = null;

  /** What holds the lock, or `null` when the runtime has no voice session. */
  get holder(): VoiceSessionKind | null {
    return this.held;
  }

  /** Take the lock, or answer `false` because something already holds it. */
  tryAcquire(kind: VoiceSessionKind): boolean {
    if (this.held !== null) return false;
    this.held = kind;
    return true;
  }

  /**
   * Let go of the lock, if `kind` is what holds it.
   *
   * Idempotent, and ignores a release from the other owner: each owner calls this from
   * every one of its exit paths, and several of those paths run for a session that has
   * already ended.
   */
  release(kind: VoiceSessionKind): void {
    if (this.held === kind) this.held = null;
  }
}

export const voiceSessionLock = new VoiceSessionLock();
