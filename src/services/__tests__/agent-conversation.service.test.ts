import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';

const { state, failStore } = vi.hoisted(() => ({ state: new Map<string, string>(), failStore: { on: false } }));

vi.mock('../../lib/prisma', () => ({ default: {} }));
vi.mock('../conversation.service', () => ({ conversationService: {} }));
vi.mock('../runtime-state.service', () => ({
  runtimeStateService: {
    get: async (key: string) => state.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (failStore.on) throw new Error('database is locked');
      state.set(key, value);
    },
  },
}));

import { agentConversationService } from '../agent-conversation.service';

const MESSAGE_AGENT = 'lens__lens-agents-client__message_agent';
const CONVERSATION = '0f0f0f0f-0000-4000-8000-0000000000c1';
const sent = (text: string) => ({ content: [{ type: 'text', text }] });
const tool = (result: unknown) => ({ description: 'd', inputSchema: { type: 'object' }, execute: vi.fn(async () => result) }) as unknown as Tool;
const run = (tools: Record<string, Tool>, name: string) =>
  (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute({ to: 'writer' }, { toolCallId: 'c1' });

beforeEach(() => {
  state.clear();
  failStore.on = false;
});

describe('agentConversationService.withSentConversations', () => {
  it('keeps the conversation a message_agent call answers in the thread, and returns the result unchanged', async () => {
    const result = sent(`{"conversationId":"${CONVERSATION}"}\nSent to the Writer.`);
    const tools = agentConversationService.withSentConversations({ [MESSAGE_AGENT]: tool(result) }, 'thread-a');

    expect(await run(tools, MESSAGE_AGENT)).toBe(result);
    expect(state.get(`agentConversation:${CONVERSATION}`)).toBe('thread-a');
  });

  it('keeps nothing for an answer without a conversation, such as an error', async () => {
    const tools = agentConversationService.withSentConversations({ [MESSAGE_AGENT]: tool(sent('No agent is called writer.')) }, 'thread-a');

    await run(tools, MESSAGE_AGENT);
    expect(state.size).toBe(0);
  });

  it('returns the result when the conversation cannot be kept', async () => {
    failStore.on = true;
    const result = sent(`{"conversationId":"${CONVERSATION}"}\nSent to the Writer.`);
    const tools = agentConversationService.withSentConversations({ [MESSAGE_AGENT]: tool(result) }, 'thread-a');

    expect(await run(tools, MESSAGE_AGENT)).toBe(result);
  });

  it('leaves the tools untouched without a thread, and every other tool in its place', () => {
    const tools = { kubectl: tool('pods'), [MESSAGE_AGENT]: tool(sent('{}')) };

    expect(agentConversationService.withSentConversations(tools, undefined)).toBe(tools);
    const wrapped = agentConversationService.withSentConversations(tools, 'thread-a');
    expect(Object.keys(wrapped)).toEqual(['kubectl', MESSAGE_AGENT]);
    expect(wrapped.kubectl).toBe(tools.kubectl);
    expect(wrapped[MESSAGE_AGENT]).not.toBe(tools[MESSAGE_AGENT]);
  });
});
