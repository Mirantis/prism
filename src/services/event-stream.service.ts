/**
 * Event Stream Service
 *
 * Owns the numbered stream of chat events that every connected client reads,
 * and the window of recent events a reconnecting client can have again.
 *
 * A client on a phone loses its socket every time the screen locks, and a reply
 * published in that gap used to reach nobody. So every event gets the next
 * `seq`, is kept for a while, and a client that comes back names the last `seq`
 * it saw and is sent the rest. When the gap is no longer covered the client is
 * told so, and reads history over REST instead — it is never silently behind.
 *
 * `streamId` names this process. Numbers from a previous process mean nothing
 * here, so a client that brings one after a restart is told to reload.
 *
 * The window is memory, bounded by a count and a byte budget. The runtime is one
 * process per agent, so memory is where the rest of its coordination lives too.
 */

import { randomUUID } from 'node:crypto';
import type { SequencedEvent, StreamEvent } from '../protocol/chat-protocol';

/** One event, numbered and serialized once for every socket that sends it. */
export interface StreamEntry {
  seq: number;
  event: SequencedEvent;
  /** The frame as sent on the wire. */
  frame: string;
  /** Its size in bytes, which is what the replay budgets count. */
  bytes: number;
}

export type StreamSubscriber = (entry: StreamEntry) => void;

/** How many recent events are kept for replay. */
export const REPLAY_MAX_EVENTS = 2_000;

/** How many bytes of recent events are kept for replay. */
export const REPLAY_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The most a single resume replays. A slow client past this is told to reload
 * instead: feeding it a replay it cannot drain only gets it closed for falling
 * behind, and it would reconnect and ask for the same replay again.
 */
export const REPLAY_MAX_GAP_BYTES = 2 * 1024 * 1024;

export class EventStreamService {
  private currentStreamId = randomUUID();
  private lastSeq = 0;
  private entries: StreamEntry[] = [];
  private bytes = 0;
  private readonly subscribers = new Set<StreamSubscriber>();

  constructor(
    private readonly limits = {
      maxEvents: REPLAY_MAX_EVENTS,
      maxBytes: REPLAY_MAX_BYTES,
      maxGapBytes: REPLAY_MAX_GAP_BYTES,
    },
  ) {}

  get streamId(): string {
    return this.currentStreamId;
  }

  /** The `seq` of the newest event, 0 before the first. */
  get seq(): number {
    return this.lastSeq;
  }

  /**
   * Number an event, keep it, and hand it to every subscriber.
   *
   * **Synchronous on purpose.** Nothing may run between taking a number and
   * handing the event out, or a socket registering in that gap would see a later
   * event before an earlier one. Call it only once whatever the event describes
   * is committed, so a client that reads history on the back of it finds it.
   */
  publish(event: StreamEvent): StreamEntry {
    const seq = ++this.lastSeq;
    const sequenced = { ...event, seq } as SequencedEvent;
    const frame = JSON.stringify(sequenced);
    const entry: StreamEntry = { seq, event: sequenced, frame, bytes: Buffer.byteLength(frame) };
    this.keep(entry);
    for (const subscriber of this.subscribers) subscriber(entry);
    return entry;
  }

  /**
   * The events after `seq`, when this process still has every one of them and
   * they fit one replay. `null` means the client has to reload from history.
   */
  replayAfter(streamId: string, seq: number): StreamEntry[] | null {
    if (streamId !== this.currentStreamId) return null;
    if (seq > this.lastSeq) return null;
    if (seq === this.lastSeq) return [];

    const oldest = this.entries[0]?.seq;
    // The next event the client needs has been evicted.
    if (oldest === undefined || seq + 1 < oldest) return null;

    const missed = this.entries.slice(seq + 1 - oldest);
    let size = 0;
    for (const entry of missed) {
      size += entry.bytes;
      if (size > this.limits.maxGapBytes) return null;
    }
    return missed;
  }

  /** Receive every event from now on. The returned function stops that. */
  subscribe(subscriber: StreamSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private keep(entry: StreamEntry): void {
    this.entries.push(entry);
    this.bytes += entry.bytes;
    while (
      this.entries.length > this.limits.maxEvents ||
      (this.bytes > this.limits.maxBytes && this.entries.length > 1)
    ) {
      const evicted = this.entries.shift();
      if (evicted) this.bytes -= evicted.bytes;
    }
  }

  /** Start a new stream, as a restart would. For tests. */
  resetForTests(): void {
    this.currentStreamId = randomUUID();
    this.lastSeq = 0;
    this.entries = [];
    this.bytes = 0;
    this.subscribers.clear();
  }
}

export const eventStreamService = new EventStreamService();
