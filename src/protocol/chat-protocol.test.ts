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

  it('numbers every client’s events without a gap, across the reconnect', () => {
    for (const client of ['web', 'phone']) {
      const received = log.filter((e) => e.client === client && e.direction === 'received').map((e) => e.frame);
      const welcomes = received.filter((f) => f.type === 'welcome');
      const seqs = received.filter((f) => typeof f.seq === 'number').map((f) => f.seq);
      let expected = welcomes[0].payload.seq + 1;
      for (const seq of seqs) {
        expect(seq).toBe(expected);
        expected = seq + 1;
      }
    }
  });

  it('shows a person’s own message to every client, before its reply', () => {
    for (const client of ['web', 'phone']) {
      const messages = log
        .filter((e) => e.client === client && e.frame?.type === 'message')
        .map((e) => e.frame.payload);
      expect(messages.map((m) => m.role)).toEqual(['USER', 'AGENT', 'USER', 'AGENT']);
      expect(messages[0].senderName).toBe('Ada Example');
      expect(messages[0].id).toBe(session.messages[0]);
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
