/**
 * send_message and list_message_targets: what the tools pass to the outbound
 * message service, and which invocation modes have them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tool } from 'ai';

const { mockOutbound, mockGetChannelContext } = vi.hoisted(() => ({
  mockOutbound: { listTargets: vi.fn(), send: vi.fn() },
  mockGetChannelContext: vi.fn(),
}));

vi.mock('../../services/outbound-message.service', () => ({
  outboundMessageService: mockOutbound,
  SEND_MESSAGE_TOOL_NAME: 'send_message',
}));
vi.mock('../../services/conversation.service', () => ({
  conversationService: { getChannelContext: mockGetChannelContext },
}));

import { getSendMessageTools } from '../send-message';
import { filterToolsByMode } from '../../lib/tool-collection';

type Executable = { execute: (input: Record<string, unknown>, options: unknown) => Promise<unknown> };

function run(tool: Tool, input: Record<string, unknown>): Promise<unknown> {
  return (tool as unknown as Executable).execute(input, { toolCallId: 'call-1', messages: [] });
}

const RELEASE = {
  key: 'slack:C0RELEASE',
  platform: 'slack',
  kind: 'channel',
  conversationId: 'C0RELEASE',
  name: 'release',
  isMain: false,
};

describe('Requirement: the message tools act for the run that calls them', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOutbound.listTargets.mockResolvedValue([RELEASE]);
    mockOutbound.send.mockResolvedValue({ target: RELEASE, messageId: '1712345678.000100' });
  });

  it("lists the agent's linked targets", async () => {
    const tools = getSendMessageTools('user-1', 'agent-1');

    expect(await run(tools.list_message_targets, {})).toEqual({
      targets: [{ target: 'slack:C0RELEASE', platform: 'slack', kind: 'channel', name: 'release', main: false }],
    });
    expect(mockOutbound.listTargets).toHaveBeenCalledWith('agent-1');
  });

  it('sends with the conversation the reply of a Slack turn goes to', async () => {
    mockGetChannelContext.mockResolvedValue({
      channel: 'slack',
      channelId: 'C0GENERAL',
      threadTs: '1712345678.000001',
      threadId: 'thread-1',
    });
    const tools = getSendMessageTools('user-1', 'agent-1', 'thread-1', 'slack', 'C0GENERAL');

    const result = await run(tools.send_message, { target: '#release', text: 'Release v2 is out.' });

    expect(mockGetChannelContext).toHaveBeenCalledWith('thread-1', 'slack', 'C0GENERAL');
    expect(mockOutbound.send).toHaveBeenCalledWith({
      agentId: 'agent-1',
      userId: 'user-1',
      target: '#release',
      thread: undefined,
      text: 'Release v2 is out.',
      origin: { platform: 'slack', conversationId: 'C0GENERAL', thread: '1712345678.000001' },
    });
    expect(result).toEqual({ sent: true, target: 'slack:C0RELEASE', name: 'release', messageId: '1712345678.000100' });
  });

  it('sends with no reply destination from a web turn or a run with no thread', async () => {
    await run(getSendMessageTools('user-1', 'agent-1', 'thread-1', 'websocket').send_message, {
      target: 'slack:C0RELEASE',
      text: 'Hi',
    });
    await run(getSendMessageTools('user-1', 'agent-1').send_message, { target: 'slack:C0RELEASE', text: 'Hi' });

    expect(mockGetChannelContext).not.toHaveBeenCalled();
    expect(mockOutbound.send.mock.calls.map(([input]) => input.origin)).toEqual([undefined, undefined]);
  });

  it('lets a refusal reach the agent as the tool error', async () => {
    mockOutbound.send.mockRejectedValue(new Error('"slack:C0RANDOM" is not a channel or DM linked to this agent'));

    await expect(
      run(getSendMessageTools('user-1', 'agent-1').send_message, { target: 'slack:C0RANDOM', text: 'Hi' }),
    ).rejects.toThrow('is not a channel or DM linked to this agent');
  });
});

describe('Requirement: every mode that stores its tool calls has the message tools', () => {
  const tools = getSendMessageTools('user-1', 'agent-1');

  it.each(['chat', 'heartbeat', 'cron', 'webhook', 'goal', 'meeting'])('%s mode keeps them', (mode) => {
    const filtered = filterToolsByMode(tools, mode);

    expect(Object.keys(filtered).sort()).toEqual(['list_message_targets', 'send_message']);
  });

  it('subagent mode drops them, because the parent run stores only the subagent text', () => {
    expect(filterToolsByMode(tools, 'subagent')).toEqual({});
  });
});
