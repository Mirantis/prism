import { describe, it, expect } from 'vitest';
import type { ConversationMessage } from '@/types';
import { upsertIntoHistory, type LoadedThread } from './use-thread';

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
