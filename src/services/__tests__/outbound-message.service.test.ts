/**
 * Outbound Message Service Tests
 *
 * The policy behind send_message: only a linked target, no broadcast, no post
 * into the conversation the run's reply already goes to, every outcome as one
 * telemetry event, and a withheld run that sent a message kept in history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAdapters, mockConversationService, mockTrackEvent, mockLoggerError, mockPublishToWebChat } = vi.hoisted(() => ({
  mockAdapters: [] as Array<Record<string, unknown>>,
  mockPublishToWebChat: vi.fn(),
  mockConversationService: {
    getOrCreateLatestThread: vi.fn(),
    getOrCreateThreadByExternalId: vi.fn(),
    getThreadSource: vi.fn(),
    writableThreadId: vi.fn(),
    addMessage: vi.fn(),
  },
  mockTrackEvent: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../message-delivery.service', () => ({
  messageDeliveryService: { getAdapters: () => mockAdapters, publishToWebChat: mockPublishToWebChat },
}));
vi.mock('../conversation.service', () => ({ conversationService: mockConversationService }));
vi.mock('../../lib/telemetry', () => ({ trackEvent: mockTrackEvent }));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mockLoggerError, debug: vi.fn() },
}));

import {
  outboundMessageService,
  MAX_SENT_MESSAGE_LENGTH,
  SEND_MESSAGE_TOOL_NAME,
  WITHHELD_RUN_TEXT,
  sentMessages,
} from '../outbound-message.service';
import { LinkedTarget, SendRefusedError } from '../channel-adapter.interface';
import type { ToolCallRecord } from '../../types';

const RELEASE: LinkedTarget = {
  key: 'slack:C0RELEASE',
  platform: 'slack',
  kind: 'channel',
  conversationId: 'C0RELEASE',
  name: 'release',
  isMain: false,
};
const GENERAL: LinkedTarget = { ...RELEASE, key: 'slack:C0GENERAL', conversationId: 'C0GENERAL', name: 'general', isMain: true };
const TEAMS_RELEASE: LinkedTarget = {
  key: 'teams:19:release@thread.tacv2',
  platform: 'teams',
  kind: 'channel',
  conversationId: '19:release@thread.tacv2',
  name: 'Release',
  isMain: true,
};

const OWN_DM: LinkedTarget = {
  key: 'slack:D0OWNER',
  platform: 'slack',
  kind: 'dm',
  conversationId: 'D0OWNER',
  name: '<@U0OWNER>',
  isMain: false,
  dmUserId: 'user-1',
};
const OTHER_DM: LinkedTarget = { ...OWN_DM, key: 'slack:D0OTHER', conversationId: 'D0OTHER', name: '<@U0OTHER>', dmUserId: 'user-2' };

const slack = {
  name: 'slack',
  displayName: 'Slack',
  listLinkedTargets: vi.fn(),
  postToTarget: vi.fn(),
};
const teams = {
  name: 'teams',
  displayName: 'Microsoft Teams',
  listLinkedTargets: vi.fn(),
  postToTarget: vi.fn(),
};
const websocket = { name: 'websocket' };

function send(fields: Partial<Parameters<typeof outboundMessageService.send>[0]> = {}) {
  return outboundMessageService.send({
    agentId: 'agent-1',
    userId: 'user-1',
    target: 'slack:C0RELEASE',
    text: 'Release v2 is out.',
    trigger: 'CRON_TASK',
    ...fields,
  });
}

function toolCall(fields: Partial<ToolCallRecord>): ToolCallRecord {
  return { tool: SEND_MESSAGE_TOOL_NAME, input: '{}', output: '{}', success: true, timestamp: '2026-10-08T00:00:00Z', ...fields };
}

describe('Requirement: the agent sends only to a linked target, and never a broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters.splice(0, mockAdapters.length, websocket, slack, teams);
    slack.listLinkedTargets.mockResolvedValue([GENERAL, RELEASE]);
    teams.listLinkedTargets.mockResolvedValue([TEAMS_RELEASE]);
    slack.postToTarget.mockResolvedValue({ messageId: '1712345678.000100' });
    teams.postToTarget.mockResolvedValue({ messageId: '1712345678901' });
  });

  describe('Scenario: listing the targets', () => {
    it('lists the targets of every adapter that can post', async () => {
      expect(await outboundMessageService.listTargets('agent-1')).toEqual([GENERAL, RELEASE, TEAMS_RELEASE]);
      expect(slack.listLinkedTargets).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('Scenario: a send to a linked target', () => {
    it('posts through the target platform adapter and reports the outcome', async () => {
      const result = await send({ thread: '1712345678.000001' });

      expect(slack.postToTarget).toHaveBeenCalledWith(RELEASE, 'Release v2 is out.', '1712345678.000001');
      expect(teams.postToTarget).not.toHaveBeenCalled();
      expect(result).toEqual({ key: RELEASE.key, name: RELEASE.name, messageId: '1712345678.000100' });
      expect(mockTrackEvent).toHaveBeenCalledWith('agent message sent', 'user-1', {
        'agent.id': 'agent-1',
        'send.outcome': 'sent',
        'send.platform': 'slack',
        'send.target_kind': 'channel',
        'send.threaded': 'true',
      });
    });

    it('resolves a unique #name to its channel', async () => {
      await send({ target: '#General' });

      expect(slack.postToTarget).toHaveBeenCalledWith(GENERAL, expect.any(String), undefined);
    });

    it('routes a Teams target to the Teams adapter', async () => {
      await send({ target: 'teams:19:release@thread.tacv2' });

      expect(teams.postToTarget).toHaveBeenCalledWith(TEAMS_RELEASE, expect.any(String), undefined);
    });

    it('allows a post to the origin channel outside the thread the reply goes to', async () => {
      await send({ origin: { platform: 'slack', conversationId: 'C0RELEASE', thread: '1712345678.000001' } });

      expect(slack.postToTarget).toHaveBeenCalled();
    });
  });

  describe('Scenario: the target conversation keeps the sent message', () => {
    it("stores the text as an agent message in the thread the adapter names, under the run's trigger", async () => {
      slack.postToTarget.mockResolvedValue({
        messageId: '1712345678.000100',
        history: { userId: 'user-2', threadKey: 'D0OTHER' },
      });
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-dm-b' });

      await send({ target: 'slack:C0RELEASE', text: 'The deploy failed. Shall I roll back?' });

      expect(mockConversationService.getOrCreateThreadByExternalId).toHaveBeenCalledWith('user-2', 'agent-1', 'D0OTHER');
      expect(mockConversationService.addMessage).toHaveBeenCalledWith('thread-dm-b', {
        content: 'The deploy failed. Shall I roll back?',
        role: 'AGENT',
        triggeredBy: 'CRON_TASK',
      });
    });

    it('stores nothing when the adapter names no stored thread', async () => {
      await send();

      expect(mockConversationService.getOrCreateThreadByExternalId).not.toHaveBeenCalled();
      expect(mockConversationService.addMessage).not.toHaveBeenCalled();
    });

    it('reports the send as sent when the store fails, so the agent does not send it again', async () => {
      slack.postToTarget.mockResolvedValue({ messageId: 'm-1', history: { userId: 'user-2', threadKey: 'D0OTHER' } });
      mockConversationService.getOrCreateThreadByExternalId.mockRejectedValue(new Error('database is locked'));

      await expect(send()).resolves.toEqual({ key: RELEASE.key, name: RELEASE.name, messageId: 'm-1' });
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });

  describe('Scenario: refusals', () => {
    it('refuses a target that is not linked and lists the linked ones', async () => {
      const result = send({ target: 'slack:C0RANDOM' });

      await expect(result).rejects.toBeInstanceOf(SendRefusedError);
      await expect(result).rejects.toThrow('"slack:C0RANDOM" is not a channel or DM linked to this agent');
      await expect(result).rejects.toThrow('slack:C0RELEASE (release)');
      expect(slack.postToTarget).not.toHaveBeenCalled();
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'agent message sent',
        'user-1',
        expect.objectContaining({ 'send.outcome': 'refused', 'send.reason': 'unknown_target' }),
      );
    });

    it('refuses a name two linked channels share', async () => {
      await expect(send({ target: '#release' })).rejects.toThrow('More than one linked channel is named "#release"');
    });

    it('refuses a target on a platform with no linked conversation', async () => {
      slack.listLinkedTargets.mockResolvedValue([]);
      teams.listLinkedTargets.mockResolvedValue([]);

      await expect(send()).rejects.toThrow('No channel or DM is linked to this agent.');
    });

    it.each([
      ['plain @channel', 'Heads up @channel'],
      ['plain @here', '@here the build is green'],
      ['plain @everyone', 'Hi @Everyone!'],
      ['italic @here', 'Ping _@here_ now'],
    ])('refuses a broadcast: %s', async (_label, text) => {
      await expect(send({ text })).rejects.toThrow('broadcast mention');
      expect(slack.postToTarget).not.toHaveBeenCalled();
    });

    it('keeps an address that only contains the word', async () => {
      await send({ text: 'Mail ops@channel.example.com for access' });

      expect(slack.postToTarget).toHaveBeenCalled();
    });

    it('refuses an empty message', async () => {
      await expect(send({ text: '   ' })).rejects.toThrow('The message is empty.');
    });

    it('refuses a message over the limit', async () => {
      await expect(send({ text: 'x'.repeat(MAX_SENT_MESSAGE_LENGTH + 1) })).rejects.toThrow('Shorten it.');
    });

    it('refuses the conversation and thread the run reply goes to', async () => {
      const result = send({
        thread: '1712345678.000001',
        origin: { platform: 'slack', conversationId: 'C0RELEASE', thread: '1712345678.000001' },
      });

      await expect(result).rejects.toThrow('Your reply already goes to this conversation');
      expect(slack.postToTarget).not.toHaveBeenCalled();
    });

    describe('an autonomous run, which may post only where its delivery setting allows', () => {
      const ceiling = { webChat: false, targets: [RELEASE, OWN_DM] };

      beforeEach(() => {
        slack.listLinkedTargets.mockResolvedValue([GENERAL, RELEASE, OWN_DM, OTHER_DM]);
      });

      it('posts to a target the setting allows, the main channel and the own DM included', async () => {
        await send({ target: 'slack:C0RELEASE', ceiling });
        await send({ target: 'slack:D0OWNER', ceiling: { webChat: false, targets: [GENERAL, OWN_DM] } });
        await send({ target: 'slack:C0GENERAL', ceiling: { webChat: false, targets: [GENERAL, OWN_DM] } });

        expect(slack.postToTarget.mock.calls.map(([target]) => target.key)).toEqual([
          'slack:C0RELEASE',
          'slack:D0OWNER',
          'slack:C0GENERAL',
        ]);
      });

      it('refuses a linked target the setting leaves out, and names the allowed ones', async () => {
        const result = send({ target: '#general', ceiling });

        await expect(result).rejects.toThrow('Your delivery setting does not let this run post to #general');
        await expect(result).rejects.toThrow('This run may post to: slack:C0RELEASE (release), slack:D0OWNER (<@U0OWNER>).');
        expect(slack.postToTarget).not.toHaveBeenCalled();
        expect(mockTrackEvent).toHaveBeenCalledWith(
          'agent message sent',
          'user-1',
          expect.objectContaining({ 'send.outcome': 'refused', 'send.reason': 'outside_delivery' }),
        );
      });

      it('posts into web chat when the setting allows it', async () => {
        mockPublishToWebChat.mockResolvedValue({ id: 'msg-web-1' });

        const result = await send({ target: 'chat', ceiling: { webChat: true, targets: [] } });

        expect(mockPublishToWebChat).toHaveBeenCalledWith('agent-1', 'user-1', 'Release v2 is out.', 'CRON_TASK');
        expect(result).toEqual({ key: 'chat', name: 'Web chat', messageId: 'msg-web-1' });
        expect(mockTrackEvent).toHaveBeenCalledWith(
          'agent message sent',
          'user-1',
          expect.objectContaining({ 'send.outcome': 'sent', 'send.platform': 'chat' }),
        );
      });

      it('refuses web chat when the setting leaves it out, and in a conversation', async () => {
        await expect(send({ target: 'chat', ceiling })).rejects.toThrow('"chat" is not a channel or DM linked to this agent');
        await expect(send({ target: 'chat' })).rejects.toThrow('"chat" is not a channel or DM linked to this agent');
        expect(mockPublishToWebChat).not.toHaveBeenCalled();
      });

      it('lists only the allowed targets when a name matches nothing it allows', async () => {
        await expect(send({ target: 'slack:C0RANDOM', ceiling: { webChat: true, targets: [RELEASE] } })).rejects.toThrow(
          'This run may post to: chat (Web chat), slack:C0RELEASE (release).',
        );
      });
    });

    it('refuses only the one conversation a single-platform run delivers to', async () => {
      slack.listLinkedTargets.mockResolvedValue([GENERAL, RELEASE, OWN_DM]);
      const origin = { platform: 'slack' as const, conversationId: 'D0OWNER' };

      await send({ target: 'teams:19:release@thread.tacv2', origin });
      await send({ target: 'slack:C0GENERAL', origin });
      await expect(send({ target: 'slack:D0OWNER', origin })).rejects.toThrow('Your reply already goes to this conversation');

      expect(teams.postToTarget).toHaveBeenCalledWith(TEAMS_RELEASE, expect.any(String), undefined);
      expect(slack.postToTarget.mock.calls.map(([target]) => target.key)).toEqual(['slack:C0GENERAL']);
    });

    it('allows the main channel from a web turn, whose reply goes to the web chat only', async () => {
      await send({ target: 'slack:C0GENERAL' });

      expect(slack.postToTarget).toHaveBeenCalledWith(GENERAL, expect.any(String), undefined);
    });

    it('passes a refusal from the adapter on unchanged', async () => {
      slack.postToTarget.mockRejectedValue(new SendRefusedError('Bob (<@U0BOB>) is not a member of #release', 'not_member'));

      await expect(send()).rejects.toThrow('Bob (<@U0BOB>) is not a member of #release');
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'agent message sent',
        'user-1',
        expect.objectContaining({ 'send.outcome': 'refused', 'send.reason': 'not_member', 'send.platform': 'slack' }),
      );
    });

    it('reports a failed post with the platform name', async () => {
      slack.postToTarget.mockRejectedValue(new Error('An API error occurred: not_in_channel'));

      await expect(send()).rejects.toThrow('Slack did not accept the message: An API error occurred: not_in_channel');
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'agent message sent',
        'user-1',
        expect.objectContaining({ 'send.outcome': 'failed' }),
      );
    });
  });
});

describe('Requirement: a withheld run that sent a message stays in history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversationService.getOrCreateLatestThread.mockResolvedValue({ id: 'thread-latest' });
    mockConversationService.writableThreadId.mockImplementation(async (threadId: string) => threadId);
    mockConversationService.addMessage.mockResolvedValue({ message: { id: 'msg-kept' } });
  });

  const run = {
    agentId: 'agent-1',
    userId: 'user-1',
    content: 'Posted the release note to #release.',
    triggeredBy: 'CRON_TASK' as const,
  };

  it("stores the run's message in the latest thread when the run has none, and returns its id", async () => {
    const toolCalls = [toolCall({})];

    expect(await outboundMessageService.keepWithheldRun({ ...run, toolCalls })).toBe('msg-kept');

    expect(mockConversationService.addMessage).toHaveBeenCalledWith('thread-latest', {
      content: 'Posted the release note to #release.',
      role: 'AGENT',
      triggeredBy: 'CRON_TASK',
      toolCalls,
    });
    expect(mockConversationService.getThreadSource).not.toHaveBeenCalled();
  });

  it("stores the run's message in its own thread, visible in the thread's history", async () => {
    mockConversationService.getThreadSource.mockResolvedValue('DATABASE');

    await outboundMessageService.keepWithheldRun({ ...run, threadId: 'thread-bound', toolCalls: [toolCall({})] });

    expect(mockConversationService.getOrCreateLatestThread).not.toHaveBeenCalled();
    expect(mockConversationService.addMessage).toHaveBeenCalledWith(
      'thread-bound',
      expect.not.objectContaining({ internalStep: expect.anything() }),
    );
  });

  it('stores the message in the thread a delivery would write to, the one conversation in single-thread mode', async () => {
    mockConversationService.writableThreadId.mockResolvedValue('thread-one');
    mockConversationService.getThreadSource.mockResolvedValue('DATABASE');

    await outboundMessageService.keepWithheldRun({ ...run, threadId: 'thread-hidden', toolCalls: [toolCall({})] });

    expect(mockConversationService.writableThreadId).toHaveBeenCalledWith('thread-hidden');
    expect(mockConversationService.getThreadSource).toHaveBeenCalledWith('thread-one');
    expect(mockConversationService.addMessage).toHaveBeenCalledWith('thread-one', expect.anything());
  });

  it('stores the message as an internal row in a thread read live from a channel, which replays only those', async () => {
    mockConversationService.getThreadSource.mockResolvedValue('SLACK');

    await outboundMessageService.keepWithheldRun({ ...run, threadId: 'thread-slack', toolCalls: [toolCall({})] });

    expect(mockConversationService.getThreadSource).toHaveBeenCalledWith('thread-slack');
    expect(mockConversationService.addMessage).toHaveBeenCalledWith(
      'thread-slack',
      expect.objectContaining({ content: 'Posted the release note to #release.', internalStep: true }),
    );
  });

  it('stores the record as an internal row when the run posted into web chat, where the post already shows', async () => {
    const posted = toolCall({ input: JSON.stringify({ target: 'chat', text: 'Release v2 is out.' }) });

    await outboundMessageService.keepWithheldRun({ ...run, toolCalls: [posted] });

    expect(mockConversationService.addMessage).toHaveBeenCalledWith(
      'thread-latest',
      expect.objectContaining({ internalStep: true }),
    );
  });

  it('stores the record as a visible row when the run posted only to a channel', async () => {
    const posted = toolCall({ input: JSON.stringify({ target: 'slack:C0RELEASE', text: 'Release v2 is out.' }) });

    await outboundMessageService.keepWithheldRun({ ...run, toolCalls: [posted] });

    expect(mockConversationService.addMessage.mock.calls[0][1]).not.toHaveProperty('internalStep');
  });

  it('stores the subscription name of a webhook run, so its history has the event turn', async () => {
    await outboundMessageService.keepWithheldRun({
      ...run,
      triggeredBy: 'WEBHOOK',
      triggerName: 'release-alerts',
      toolCalls: [toolCall({})],
    });

    expect(mockConversationService.addMessage).toHaveBeenCalledWith(
      'thread-latest',
      expect.objectContaining({ triggeredBy: 'WEBHOOK', triggerName: 'release-alerts' }),
    );
  });

  it('stores a fixed text for a run that ended with no text, never an empty message', async () => {
    await outboundMessageService.keepWithheldRun({ ...run, content: '', toolCalls: [toolCall({})] });

    expect(mockConversationService.addMessage).toHaveBeenCalledWith(
      'thread-latest',
      expect.objectContaining({ content: WITHHELD_RUN_TEXT }),
    );
  });

  it('stores nothing for a run whose sends all failed, or that sent nothing', async () => {
    await outboundMessageService.keepWithheldRun({ ...run, toolCalls: [toolCall({ success: false })] });
    await outboundMessageService.keepWithheldRun({ ...run, toolCalls: [toolCall({ tool: 'memory_search' })] });

    expect(mockConversationService.addMessage).not.toHaveBeenCalled();
  });
});

describe("Requirement: a run's sends read back as where each message went and what it said", () => {
  it('lists each successful send, with its thread, and skips failed sends and other tools', () => {
    expect(
      sentMessages([
        toolCall({ input: JSON.stringify({ target: '#ops', text: 'Build #812 failed.' }) }),
        toolCall({ input: JSON.stringify({ target: 'slack:C0RELEASE', thread: '1712345678.000001', text: 'Shipped.' }) }),
        toolCall({ input: JSON.stringify({ target: '#ops', text: 'Refused.' }), success: false }),
        toolCall({ tool: 'memory_write', input: '{}' }),
      ]),
    ).toEqual(['- To #ops: Build #812 failed.', '- To slack:C0RELEASE, in thread 1712345678.000001: Shipped.']);
  });
});
