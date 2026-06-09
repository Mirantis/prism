/**
 * Tests for the Teams adapter's pure-ish helpers: inbound mention
 * resolution, outbound mention rewriting, sender tagging, and thread/
 * channel id derivation from activities.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Activity } from 'botbuilder';

vi.mock('../lib/prisma', () => {
  const prisma = {};
  return { default: prisma, prisma };
});
vi.mock('./teams-mapping.service', () => ({ teamsMappingService: {} }));
vi.mock('./teams-message-queue.service', () => ({ teamsMessageQueueService: {} }));
vi.mock('./teams-heartbeat-trigger.service', () => ({ teamsHeartbeatTriggerService: {} }));
vi.mock('./heartbeat.service', () => ({ heartbeatService: {} }));
vi.mock('./conversation.service', () => ({ conversationService: {} }));
vi.mock('./conversation-engine.service', () => ({ conversationEngineService: {} }));
vi.mock('../queues/teams-heartbeat-throttle-queue', () => ({ getTeamsHeartbeatThrottleQueue: vi.fn() }));
vi.mock('../queues/channel-learning.queue', () => ({ channelLearningQueue: {} }));
vi.mock('../lib/telemetry', () => ({ trackEvent: vi.fn() }));
vi.mock('../lib/classification', () => ({ getClassificationModel: vi.fn() }));
vi.mock('../lib/teams-source', () => ({
  getActiveTeamsConnections: vi.fn().mockResolvedValue([]),
  getTeamsConnection: vi.fn().mockResolvedValue(null),
}));
vi.mock('ai', () => ({ generateObject: vi.fn() }));

import { teamsAdapterService } from './teams-adapter.service';

// Access private helpers without widening the public surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = teamsAdapterService as any;

function channelActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    type: 'message',
    id: '1700000000002',
    text: '<at>Prism</at> hello there',
    from: { id: '29:alice-id', name: 'Alice Smith' },
    recipient: { id: '28:bot-app-id', name: 'Prism' },
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    conversation: {
      id: '19:chan@thread.tacv2;messageid=1700000000001',
      conversationType: 'channel',
    },
    channelData: { channel: { id: '19:chan@thread.tacv2' } },
    entities: [
      { type: 'mention', text: '<at>Prism</at>', mentioned: { id: '28:bot-app-id', name: 'Prism' } },
    ],
    ...overrides,
  } as unknown as Activity;
}

describe('resolveMentions', () => {
  it('removes the bot mention and rewrites user mentions to combined tokens', () => {
    const activity = channelActivity({
      text: '<at>Prism</at> ask <at>Bob</at> about the deploy',
      entities: [
        { type: 'mention', text: '<at>Prism</at>', mentioned: { id: '28:bot-app-id', name: 'Prism' } },
        { type: 'mention', text: '<at>Bob</at>', mentioned: { id: '29:bob-id', name: 'Bob' } },
      ],
    } as Partial<Activity>);

    const resolved = svc.resolveMentions(activity.text, activity);

    expect(resolved).not.toContain('<at>Prism</at>');
    expect(resolved).toContain('<@29:bob-id|Bob>');
    expect(resolved).toContain('about the deploy');
  });

  it('sanitizes pipe and angle characters out of mention display names', () => {
    const activity = channelActivity({
      text: 'ping <at>Weird|Name</at>',
      entities: [
        { type: 'mention', text: '<at>Weird|Name</at>', mentioned: { id: '29:weird-id', name: 'Weird|Name' } },
      ],
    } as Partial<Activity>);

    const resolved = svc.resolveMentions(activity.text, activity);
    expect(resolved).toContain('<@29:weird-id|WeirdName>');
  });
});

describe('stripBotMention', () => {
  it('strips only the bot mention, leaving user mention text intact', () => {
    const activity = channelActivity({
      text: '<at>Prism</at> ask <at>Bob</at> please',
      entities: [
        { type: 'mention', text: '<at>Prism</at>', mentioned: { id: '28:bot-app-id', name: 'Prism' } },
        { type: 'mention', text: '<at>Bob</at>', mentioned: { id: '29:bob-id', name: 'Bob' } },
      ],
    } as Partial<Activity>);

    const stripped = svc.stripBotMention(activity.text, activity);
    expect(stripped).toBe('ask <at>Bob</at> please');
  });
});

describe('buildSenderTaggedContent', () => {
  it('prefixes the sender combined token', () => {
    const tagged = svc.buildSenderTaggedContent('29:alice-id', 'Alice Smith', 'hello');
    expect(tagged).toBe('<@29:alice-id|Alice Smith>: hello');
  });

  it('falls back to the bare message when sender name is unknown', () => {
    expect(svc.buildSenderTaggedContent('29:alice-id', undefined, 'hello')).toBe('hello');
  });
});

describe('rewriteOutboundMentions', () => {
  it('converts combined tokens into <at> text plus mention entities', () => {
    const { text, entities } = teamsAdapterService.rewriteOutboundMentions(
      'Hey <@29:bob-id|Bob>, deploy is done',
    );

    expect(text).toBe('Hey <at>Bob</at>, deploy is done');
    expect(entities).toEqual([
      { type: 'mention', text: '<at>Bob</at>', mentioned: { id: '29:bob-id', name: 'Bob' } },
    ]);
  });

  it('downgrades tokens with non-Teams ids to plain @name', () => {
    const { text, entities } = teamsAdapterService.rewriteOutboundMentions(
      'Hey <@not-a-teams-id|Bob>',
    );
    expect(text).toBe('Hey @Bob');
    expect(entities).toEqual([]);
  });

  it('drops bare unknown tokens without a display name', () => {
    const { text, entities } = teamsAdapterService.rewriteOutboundMentions('Hey <@29:bob-id>!');
    expect(text).toBe('Hey !');
    expect(entities).toEqual([]);
  });

  it('returns text unchanged when no tokens are present', () => {
    const { text, entities } = teamsAdapterService.rewriteOutboundMentions('No mentions here');
    expect(text).toBe('No mentions here');
    expect(entities).toEqual([]);
  });

  it('deduplicates entities for repeated mentions of the same user', () => {
    const { text, entities } = teamsAdapterService.rewriteOutboundMentions(
      '<@29:bob-id|Bob> and again <@29:bob-id|Bob>',
    );
    expect(text).toBe('<at>Bob</at> and again <at>Bob</at>');
    expect(entities).toHaveLength(1);
  });
});

describe('channelIdFromActivity', () => {
  it('prefers channelData.channel.id', () => {
    expect(svc.channelIdFromActivity(channelActivity())).toBe('19:chan@thread.tacv2');
  });

  it('falls back to the conversation id with the thread suffix stripped', () => {
    const activity = channelActivity({ channelData: {} } as Partial<Activity>);
    expect(svc.channelIdFromActivity(activity)).toBe('19:chan@thread.tacv2');
  });
});

describe('isThreadReply', () => {
  it('is false for a new top-level post (root message id equals activity id)', () => {
    const activity = channelActivity({
      id: '1700000000001',
      conversation: {
        id: '19:chan@thread.tacv2;messageid=1700000000001',
        conversationType: 'channel',
      },
    } as Partial<Activity>);
    expect(svc.isThreadReply(activity)).toBe(false);
  });

  it('is true for a reply inside an existing thread', () => {
    expect(svc.isThreadReply(channelActivity())).toBe(true);
  });

  it('is false when the conversation id has no thread suffix (group chat)', () => {
    const activity = channelActivity({
      conversation: { id: '19:group-chat', conversationType: 'groupChat' },
    } as Partial<Activity>);
    expect(svc.isThreadReply(activity)).toBe(false);
  });
});

describe('isBotMentioned', () => {
  it('is true when entities include a mention of the recipient', () => {
    expect(svc.isBotMentioned(channelActivity())).toBe(true);
  });

  it('is false when only other users are mentioned', () => {
    const activity = channelActivity({
      entities: [
        { type: 'mention', text: '<at>Bob</at>', mentioned: { id: '29:bob-id', name: 'Bob' } },
      ],
    } as Partial<Activity>);
    expect(svc.isBotMentioned(activity)).toBe(false);
  });
});
