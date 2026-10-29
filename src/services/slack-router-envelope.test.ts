/**
 * Slack router envelope tests: what the schema accepts and refuses, and the
 * Bolt body a `slack` envelope becomes.
 */

import { describe, it, expect } from 'vitest';
import { routerEnvelopeSchema, toBoltBody, type SlackEnvelope } from './slack-router-envelope';

const base = {
  version: 1,
  eventId: 'evt-1',
  sentAt: '2026-10-29T10:00:00.000Z',
  teamId: 'T0EXAMPLE',
};

const mention = {
  ...base,
  kind: 'slack',
  route: 'mention',
  person: { id: 'person-1' },
  payloadType: 'event',
  payload: {
    type: 'app_mention',
    channel: 'C0EXAMPLE',
    user: 'U0ALICE',
    text: '<@U0BOT> what is the status?',
    ts: '1761732000.000100',
    event_ts: '1761732000.000100',
    blocks: [{ type: 'rich_text' }],
  },
};

const click = {
  ...base,
  kind: 'slack',
  route: 'action',
  person: null,
  payloadType: 'block_actions',
  payload: {
    type: 'block_actions',
    team: { id: 'T0EXAMPLE', domain: 'example' },
    user: { id: 'U0ALICE', team_id: 'T0EXAMPLE' },
    channel: { id: 'C0EXAMPLE' },
    message: { ts: '1761732001.000200', blocks: [{ type: 'actions', block_id: 'lens_feedback' }] },
    actions: [{ action_id: 'feedback_thumbs_up', value: 'msg-1' }],
    response_url: 'https://hooks.slack.com/actions/T0/1/x',
  },
};

describe('routerEnvelopeSchema', () => {
  it.each([
    ['a mention', mention],
    ['a feedback click', click],
    ['a DM link', { ...base, kind: 'link', link: { op: 'add', type: 'dm', slackUserId: 'U0ALICE', dmChannelId: 'D0ALICE', personId: 'person-1' } }],
    ['a channel unlink', { ...base, kind: 'link', link: { op: 'remove', type: 'channel', channelId: 'C0EXAMPLE', personId: 'person-1' } }],
    ['a connection', { ...base, kind: 'connected', workspace: { teamId: 'T0EXAMPLE', teamName: 'Example', botUserId: 'U0BOT', botId: 'B0BOT' } }],
    ['a disconnection', { ...base, kind: 'disconnected' }],
  ])('accepts %s', (_name, envelope) => {
    expect(routerEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it.each([
    ['an unknown version', { ...base, version: 2, kind: 'disconnected' }],
    ['an unknown kind', { ...base, kind: 'reconnected' }],
    ['an unknown envelope field', { ...base, kind: 'disconnected', extra: true }],
    ['an unknown link field', { ...base, kind: 'link', link: { op: 'add', type: 'channel', channelId: 'C0EXAMPLE', personId: 'p', name: 'x' } }],
    ['a click on a message route', { ...click, route: 'mention' }],
    ['an event type the adapter does not handle', { ...mention, payload: { type: 'app_home_opened', user: 'U0ALICE' } }],
    ['a sentAt that is not a time', { ...mention, sentAt: 'yesterday' }],
  ])('refuses %s', (_name, envelope) => {
    expect(routerEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('keeps only the payload fields the adapter reads', () => {
    const parsed = routerEnvelopeSchema.parse(mention) as SlackEnvelope;

    expect(parsed.payload).toEqual({
      type: 'app_mention',
      channel: 'C0EXAMPLE',
      user: 'U0ALICE',
      text: '<@U0BOT> what is the status?',
      ts: '1761732000.000100',
    });
  });
});

describe('toBoltBody', () => {
  it('reads a mention as the message it is, with no team id', () => {
    const body = toBoltBody(routerEnvelopeSchema.parse(mention) as SlackEnvelope);

    expect(body).toEqual({
      type: 'event_callback',
      event_id: 'evt-1',
      event: {
        type: 'message',
        channel: 'C0EXAMPLE',
        user: 'U0ALICE',
        text: '<@U0BOT> what is the status?',
        ts: '1761732000.000100',
      },
    });
  });

  // Bolt gives a listener a client that adds `team_id` to every call when the
  // body names a team; the proxy's schemas have no such parameter.
  it('builds a click without the team, the user team or the response URL', () => {
    const body = toBoltBody(routerEnvelopeSchema.parse(click) as SlackEnvelope);

    expect(body).toEqual({
      type: 'block_actions',
      user: { id: 'U0ALICE' },
      channel: { id: 'C0EXAMPLE' },
      message: { ts: '1761732001.000200', blocks: [{ type: 'actions', block_id: 'lens_feedback' }] },
      actions: [{ action_id: 'feedback_thumbs_up', value: 'msg-1' }],
    });
  });
});
