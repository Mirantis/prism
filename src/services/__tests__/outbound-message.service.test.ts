/**
 * Outbound Message Service Tests
 *
 * The policy behind send_message: only a linked target, no broadcast, no post
 * into the conversation the run's reply already goes to, every outcome as one
 * telemetry event, and a withheld run that sent a message kept in history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAdapters, mockConversationService, mockTrackEvent } = vi.hoisted(() => ({
  mockAdapters: [] as Array<Record<string, unknown>>,
  mockConversationService: {
    getOrCreateLatestThread: vi.fn(),
    addMessage: vi.fn(),
  },
  mockTrackEvent: vi.fn(),
}));

vi.mock('../message-delivery.service', () => ({
  messageDeliveryService: { getAdapters: () => mockAdapters },
}));
vi.mock('../conversation.service', () => ({ conversationService: mockConversationService }));
vi.mock('../../lib/telemetry', () => ({ trackEvent: mockTrackEvent }));

import { outboundMessageService, MAX_SENT_MESSAGE_LENGTH, SEND_MESSAGE_TOOL_NAME } from '../outbound-message.service';
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
      expect(result).toEqual({ target: RELEASE, messageId: '1712345678.000100' });
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

    describe('a run without a thread, whose output goes to the main channel and the user DM', () => {
      beforeEach(() => {
        slack.listLinkedTargets.mockResolvedValue([GENERAL, RELEASE, OWN_DM, OTHER_DM]);
      });

      it('refuses the main channel', async () => {
        const result = send({ target: 'slack:C0GENERAL', origin: 'broadcast' });

        await expect(result).rejects.toThrow('Your final message already goes to #general');
        expect(slack.postToTarget).not.toHaveBeenCalled();
        expect(mockTrackEvent).toHaveBeenCalledWith(
          'agent message sent',
          'user-1',
          expect.objectContaining({ 'send.outcome': 'refused', 'send.reason': 'own_conversation' }),
        );
      });

      it('refuses the main channel on another platform too', async () => {
        await expect(send({ target: 'teams:19:release@thread.tacv2', origin: 'broadcast' })).rejects.toThrow(
          'Your final message already goes to #Release',
        );
      });

      it("refuses the user's own DM", async () => {
        await expect(send({ target: 'slack:D0OWNER', origin: 'broadcast' })).rejects.toThrow(
          'Your final message already goes to the DM with <@U0OWNER>',
        );
        expect(slack.postToTarget).not.toHaveBeenCalled();
      });

      it("allows a channel that is not main, and another user's DM", async () => {
        await send({ target: 'slack:C0RELEASE', origin: 'broadcast' });
        await send({ target: 'slack:D0OTHER', origin: 'broadcast' });

        expect(slack.postToTarget.mock.calls.map(([target]) => target.key)).toEqual(['slack:C0RELEASE', 'slack:D0OTHER']);
      });
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
  });

  const run = {
    agentId: 'agent-1',
    userId: 'user-1',
    content: 'Posted the release note to #release.',
    triggeredBy: 'CRON_TASK' as const,
  };

  it("stores the run's message in the latest thread when the run has none", async () => {
    const toolCalls = [toolCall({})];

    await outboundMessageService.keepWithheldRun({ ...run, toolCalls });

    expect(mockConversationService.addMessage).toHaveBeenCalledWith('thread-latest', {
      content: 'Posted the release note to #release.',
      role: 'AGENT',
      triggeredBy: 'CRON_TASK',
      toolCalls,
    });
  });

  it("stores the run's message in its own thread", async () => {
    await outboundMessageService.keepWithheldRun({ ...run, threadId: 'thread-bound', toolCalls: [toolCall({})] });

    expect(mockConversationService.getOrCreateLatestThread).not.toHaveBeenCalled();
    expect(mockConversationService.addMessage).toHaveBeenCalledWith('thread-bound', expect.anything());
  });

  it('stores nothing for a run whose sends all failed, or that sent nothing', async () => {
    await outboundMessageService.keepWithheldRun({ ...run, toolCalls: [toolCall({ success: false })] });
    await outboundMessageService.keepWithheldRun({ ...run, toolCalls: [toolCall({ tool: 'memory_search' })] });

    expect(mockConversationService.addMessage).not.toHaveBeenCalled();
  });
});
