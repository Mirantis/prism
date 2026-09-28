/**
 * The recorded session in `fixtures/v2-session.json` is what every client's
 * tests read, so it has to be what this contract says. Recorded from a real
 * runtime: two clients on one conversation, a resend, a reconnect that resumes,
 * refused requests and a client from before protocol 2.
 */

import { describe, it, expect } from 'vitest';
import session from './fixtures/v2-session.json';
import { clientFrame, helloFrame, CLOSE_CODES } from './chat-protocol';

type Entry = { client: string; direction: 'sent' | 'received' | 'closed'; frame?: any; code?: number };
const log = session.log as Entry[];

describe('The recorded v2 session', () => {
  it('holds only requests the contract accepts, apart from the ones sent to be refused', () => {
    const sent = log.filter((e) => e.direction === 'sent').map((e) => e.frame);
    const refusedOnPurpose = new Set(['send-bad']);
    for (const frame of sent) {
      if (frame.type === 'chat') continue; // the client from before protocol 2
      const schema = frame.type === 'hello' ? helloFrame : clientFrame;
      const parsed = schema.safeParse(frame);
      expect(parsed.success, JSON.stringify(frame)).toBe(!refusedOnPurpose.has(frame.id));
    }
  });

  it('numbers every client’s events without a gap, and resumes from the cursor it names', () => {
    for (const client of ['web', 'phone']) {
      const entries = log.filter((e) => e.client === client && e.direction !== 'closed');
      let expected = 0;
      let resumeFrom: number | undefined;
      for (const { direction, frame } of entries) {
        if (direction === 'sent' && frame.type === 'hello') resumeFrom = frame.payload.resume?.seq;
        if (direction !== 'received') continue;
        // Replay starts after the cursor the client sent, not after the last event
        // it happened to receive.
        if (frame.type === 'welcome') expected = (frame.payload.resumed ? resumeFrom! : frame.payload.seq) + 1;
        if (typeof frame.seq !== 'number') continue;
        expect(frame.seq).toBe(expected);
        expected = frame.seq + 1;
      }
    }
  });

  it('shows a person’s own message to every client, before its reply, under their id', () => {
    for (const client of ['web', 'phone']) {
      // Upserted by id, as a client does: a resend shows the stored message again.
      const byId = new Map<string, any>();
      for (const e of log) {
        if (e.client === client && e.frame?.type === 'message') byId.set(e.frame.payload.id, e.frame.payload);
      }
      const messages = [...byId.values()];
      expect(messages.map((m) => m.role)).toEqual(['USER', 'AGENT', 'USER', 'AGENT']);
      expect(messages[0]).toMatchObject({ id: session.messages[0], senderId: 'ada@example.com' });
      expect(messages[1].senderId).toBeNull();
    }
  });

  it('confirms a resend as a duplicate', () => {
    const again = log.find((e) => e.frame?.re === 'send-1-again')!.frame;
    expect(again).toMatchObject({ type: 'ack', payload: { messageId: session.messages[0], duplicate: true } });
  });

  it('resumes the returning client', () => {
    const welcomes = log.filter((e) => e.client === 'phone' && e.frame?.type === 'welcome');
    expect(welcomes.map((e) => e.frame.payload.resumed)).toEqual([false, true]);
  });

  it('closes a client from before protocol 2 with the update code', () => {
    expect(log.find((e) => e.client === 'old-client' && e.direction === 'closed')?.code).toBe(
      CLOSE_CODES.protocolUnsupported,
    );
  });
});
