import { describe, it, expect } from 'vitest';
import type { ConversationMessage } from '@/types';
import { HISTORY_PAGE, keepOlderPages, loadHistory, upsertIntoHistory, type LoadedThread } from './use-thread';

function message(id: string, createdAt: string): ConversationMessage {
  return {
    id,
    threadId: 't1',
    role: 'AGENT',
    content: id,
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    isCompacted: false,
    createdAt,
  };
}

function thread(messages: ConversationMessage[], hasOlder: boolean): LoadedThread {
  return {
    id: 't1',
    agentId: 'a1',
    userId: 'u1',
    externalThreadId: null,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000Z',
    messages,
    hasOlder,
  };
}

const loaded = [message('m-51', '2026-10-20T09:00:00.000Z'), message('m-52', '2026-10-20T09:01:00.000Z')];

describe('a live message in a conversation loaded a page at a time', () => {
  it('joins the end of the history', () => {
    const next = upsertIntoHistory(thread(loaded, true), message('m-53', '2026-10-20T09:02:00.000Z'));
    expect(next.messages.map((m) => m.id)).toEqual(['m-51', 'm-52', 'm-53']);
  });

  it('replaces the copy it changes', () => {
    const edited = { ...message('m-51', '2026-10-20T09:00:00.000Z'), content: 'answered' };
    const next = upsertIntoHistory(thread(loaded, true), edited);
    expect(next.messages.map((m) => m.content)).toEqual(['answered', 'm-52']);
  });

  it('waits for its page when it is older than the history loaded so far', () => {
    const older = message('m-7', '2026-10-19T09:00:00.000Z');
    expect(upsertIntoHistory(thread(loaded, true), older).messages.map((m) => m.id)).toEqual(['m-51', 'm-52']);
    expect(upsertIntoHistory(thread(loaded, false), older).messages.map((m) => m.id)).toEqual(['m-7', 'm-51', 'm-52']);
  });
});

describe('loading a conversation again', () => {
  // 120 messages, oldest first, and a reader of one page at a time like the runtime's.
  const history = Array.from({ length: 120 }, (_, i) =>
    message(`m-${i + 1}`, new Date(Date.UTC(2026, 9, 20, 9, 0, i)).toISOString()),
  );
  const pages: Array<string | undefined> = [];
  async function readPage(before?: string) {
    pages.push(before);
    const end = before ? history.findIndex((m) => m.id === before) : history.length;
    return { ...thread([], false), messages: history.slice(Math.max(0, end - HISTORY_PAGE), end) };
  }

  it('reads as many messages as the reader had loaded', async () => {
    pages.length = 0;
    const loaded = await loadHistory(readPage, 2 * HISTORY_PAGE);
    expect(loaded.messages.map((m) => m.id)).toEqual(history.slice(20).map((m) => m.id));
    expect(loaded.hasOlder).toBe(true);
    expect(pages).toEqual([undefined, 'm-71']);
  });

  it('reads the newest page alone the first time', async () => {
    pages.length = 0;
    const loaded = await loadHistory(readPage, 0);
    expect(loaded.messages).toHaveLength(HISTORY_PAGE);
    expect(pages).toEqual([undefined]);
  });

  it('stops at the first message', async () => {
    const loaded = await loadHistory(readPage, 500);
    expect(loaded.messages.map((m) => m.id)).toEqual(history.map((m) => m.id));
    expect(loaded.hasOlder).toBe(false);
  });
});

describe('a reload that ends while an older page arrives', () => {
  const older = [message('m-1', '2026-10-20T08:00:00.000Z'), message('m-2', '2026-10-20T08:01:00.000Z')];
  const reloaded = [message('m-51', '2026-10-20T09:00:00.000Z'), message('m-52', '2026-10-20T09:01:00.000Z')];

  it('keeps the page the reader scrolled into, ahead of the reload', () => {
    const cached = thread([...older, ...loaded], false);
    const next = keepOlderPages(cached, thread(reloaded, true));
    expect(next.messages.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-51', 'm-52']);
    expect(next.hasOlder).toBe(false);
  });

  it('takes the reload as it is when the cache gained nothing older', () => {
    const next = keepOlderPages(thread(loaded, true), thread(reloaded, true));
    expect(next.messages.map((m) => m.id)).toEqual(['m-51', 'm-52']);
    expect(keepOlderPages(undefined, thread(reloaded, true)).messages).toHaveLength(2);
  });

  it('takes the reload as it is when it starts at a message the cache does not hold', () => {
    const next = keepOlderPages(thread(older, true), thread(reloaded, true));
    expect(next.messages.map((m) => m.id)).toEqual(['m-51', 'm-52']);
  });
});
