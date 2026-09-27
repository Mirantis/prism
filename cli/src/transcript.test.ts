import { describe, expect, it } from 'vitest';
import { appendLocal, ChatEntry, markFailed, upsertMessage, withHistory } from './transcript.js';
import type { TuiMessage } from './tui-adapter.js';

function msg(id: string, createdAt: string, overrides: Partial<TuiMessage> = {}): TuiMessage {
  return {
    id,
    threadId: 't1',
    role: 'AGENT',
    content: id,
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    createdAt,
    ...overrides,
  };
}

const ids = (entries: ChatEntry[]) => entries.map((e) => e.message.id);

describe('the transcript', () => {
  it("takes the runtime's copy of a message in place of the row drawn before it was confirmed", () => {
    let entries = appendLocal([], msg('u1', '2026-09-27T08:38:51.000Z', { role: 'USER', content: 'hi' }));
    entries = upsertMessage(entries, msg('u1', '2026-09-27T08:38:51.086Z', { role: 'USER', content: 'hi' }));

    expect(entries).toEqual([
      { kind: 'message', message: msg('u1', '2026-09-27T08:38:51.086Z', { role: 'USER', content: 'hi' }) },
    ]);
  });

  it("puts the stored copy of my message after someone else's that was stored first", () => {
    let entries = appendLocal([], msg('mine', '2026-09-27T08:38:52.000Z', { role: 'USER' }));
    entries = upsertMessage(entries, msg('theirs', '2026-09-27T08:38:50.000Z', { role: 'USER' }));
    entries = upsertMessage(entries, msg('mine', '2026-09-27T08:38:51.000Z', { role: 'USER' }));

    expect(ids(entries)).toEqual(['theirs', 'mine']);
  });

  it('replaces a message that changed in place', () => {
    let entries = upsertMessage([], msg('a1', '2026-09-27T08:00:00.000Z', { content: 'waiting' }));
    entries = upsertMessage(entries, msg('a2', '2026-09-27T08:00:01.000Z'));
    entries = upsertMessage(entries, msg('a1', '2026-09-27T08:00:00.000Z', { content: 'answered' }));

    expect(entries.map((e) => e.message.content)).toEqual(['answered', 'a2']);
  });

  it('orders stored messages by createdAt, then by id', () => {
    let entries = upsertMessage([], msg('b', '2026-09-27T08:00:02.000Z'));
    entries = upsertMessage(entries, msg('c', '2026-09-27T08:00:01.000Z'));
    entries = upsertMessage(entries, msg('a', '2026-09-27T08:00:01.000Z'));

    expect(ids(entries)).toEqual(['a', 'c', 'b']);
  });

  it('keeps a local line where it was drawn, whatever its clock says', () => {
    let entries = upsertMessage([], msg('a1', '2026-09-27T08:00:05.000Z'));
    entries = appendLocal(entries, msg('notice', '2026-09-27T08:00:00.000Z', { role: 'SYSTEM' }));
    entries = upsertMessage(entries, msg('a2', '2026-09-27T08:00:06.000Z'));

    expect(ids(entries)).toEqual(['a1', 'notice', 'a2']);
  });

  it("takes the stored history and keeps the lines only this client has", () => {
    let entries = upsertMessage([], msg('gone', '2026-09-27T08:00:00.000Z'));
    entries = appendLocal(entries, msg('notice', '2026-09-27T08:00:02.500Z', { role: 'SYSTEM' }));
    entries = appendLocal(entries, msg('pending', '2026-09-27T08:00:04.000Z', { role: 'USER' }));

    const next = withHistory(entries, [
      msg('a3', '2026-09-27T08:00:03.000Z'),
      msg('a1', '2026-09-27T08:00:01.000Z'),
    ]);

    expect(ids(next)).toEqual(['a1', 'notice', 'a3', 'pending']);
  });

  it('drops a local row the history has stored', () => {
    const entries = appendLocal([], msg('u1', '2026-09-27T08:00:04.000Z', { role: 'USER' }));

    const next = withHistory(entries, [msg('u1', '2026-09-27T08:00:04.100Z', { role: 'USER' })]);

    expect(next).toEqual([{ kind: 'message', message: msg('u1', '2026-09-27T08:00:04.100Z', { role: 'USER' }) }]);
  });

  it('marks a refused message with the reason', () => {
    const entries = appendLocal([], msg('u1', '2026-09-27T08:00:04.000Z', { role: 'USER' }));

    expect(markFailed(entries, 'u1', 'There is no such conversation.')[0]).toMatchObject({
      local: true,
      failed: 'There is no such conversation.',
    });
  });
});
