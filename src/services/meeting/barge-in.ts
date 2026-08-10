/**
 * Interruption policy: when a human starts talking over the bot, what happens.
 *
 * The naive version — cancel the response the instant voice activity is detected
 * — is the classic meeting-bot failure. A cough, a chair scrape, or an "mm-hm"
 * of agreement kills the bot mid-sentence, and it never finishes a thought.
 * The other naive version — waiting to be sure before reacting — leaves the bot
 * talking over someone for half a second, which reads as rude and makes people
 * talk louder.
 *
 * So the two decisions are separated:
 *
 * - **Go quiet immediately.** On the first hint of speech, playback pauses. This
 *   is instant and free: nothing is discarded and nothing is told to the model,
 *   so it can be undone.
 * - **Commit to the interruption only if the speech persists.** After a short
 *   grace period, the pause becomes a real interruption: unplayed audio is
 *   dropped and the model is told how much of its turn was actually heard. If the
 *   speech stops inside the grace period, playback simply resumes — from the
 *   listener's side, the bot paused for a beat mid-sentence.
 *
 * In a meeting the bot always yields to humans; the grace period tunes *what
 * counts as a human wanting the floor*, never whether they get it.
 */

/**
 * How long speech must continue before the bot gives up its turn.
 *
 * 500 ms is long enough to rule out a cough or a one-syllable backchannel and
 * short enough that a real interjection only overlaps by a pause.
 */
export const BACKCHANNEL_GRACE_MS = 500;

export interface BargeInHandlers {
  /** Go quiet, keeping unplayed audio for a possible resume. */
  pausePlayback: () => void;
  /** Undo the pause — the speech turned out to be a backchannel. */
  resumePlayback: () => void;
  /**
   * Give up the turn: drop unplayed audio and tell the model what was heard.
   * Returns nothing; the caller wires it to `flush()` + `interrupt(playedMs)`.
   */
  commitInterrupt: () => void;
  /** Whether the bot currently has audio to play (i.e. is mid-utterance). */
  isSpeaking: () => boolean;
}

/**
 * Tracks one speaker's overlap with the bot and decides when to yield.
 *
 * Deliberately not aware of *who* is speaking: the meeting audio is one mixed
 * mono bus, so any human voice is simply "a human wants the floor".
 */
export class BargeInPolicy {
  private graceTimer: NodeJS.Timeout | null = null;
  /** True from the pause until either resume or commit. */
  private pending = false;
  /** True once the current utterance has been given up on. */
  private committed = false;

  constructor(
    private readonly handlers: BargeInHandlers,
    private readonly graceMs: number = BACKCHANNEL_GRACE_MS,
  ) {}

  /** Voice activity detected. Goes quiet at once; commits only if it lasts. */
  onSpeechStarted(): void {
    // Not talking over anyone — nothing to yield.
    if (!this.handlers.isSpeaking()) return;
    if (this.pending || this.committed) return;

    this.pending = true;
    this.handlers.pausePlayback();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      // Still overlapping after the grace period: this is a real interruption.
      if (this.pending) this.commit();
    }, this.graceMs);
  }

  /** Voice activity ended. Inside the grace period this undoes the pause. */
  onSpeechStopped(): void {
    if (!this.pending) return;
    this.clearTimer();
    this.pending = false;
    this.handlers.resumePlayback();
  }

  /**
   * A new utterance has begun (fresh response item), so the previous decision no
   * longer applies. Called by the session runner when the model starts speaking
   * again — including the response it generates *because* it was interrupted.
   */
  onUtteranceStarted(): void {
    this.clearTimer();
    this.pending = false;
    this.committed = false;
  }

  /**
   * Commit now, without waiting out the grace period.
   *
   * Used when the model starts a new response while a pause is pending: the old
   * audio is stale and must be dropped before the new utterance plays, or the two
   * would be spliced together.
   */
  commitIfPending(): void {
    if (this.pending) this.commit();
  }

  private commit(): void {
    this.clearTimer();
    this.pending = false;
    this.committed = true;
    this.handlers.commitInterrupt();
  }

  private clearTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /** Release the pending timer. Safe to call more than once. */
  dispose(): void {
    this.clearTimer();
    this.pending = false;
  }
}
