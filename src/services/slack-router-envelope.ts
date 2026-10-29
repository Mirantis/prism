/**
 * The envelope a Slack router posts to `POST /agents/slack/router`, and the
 * Bolt body a `slack` envelope becomes.
 *
 * The envelope is strict: an unknown field, version or kind fails it. Its
 * `payload` is in Slack's own shape, so the schema checks the fields the adapter
 * reads and drops every other field, and the Bolt body is built from those
 * fields alone.
 */

import { z } from 'zod';

const id = z.string().min(1).max(255);

const slackFile = z.object({
  id,
  name: z.string().optional(),
  mimetype: z.string().optional(),
  size: z.number().optional(),
  url_private: z.string().optional(),
  url_private_download: z.string().optional(),
});

const messageEvent = z.object({
  type: z.enum(['message', 'app_mention']),
  subtype: z.string().optional(),
  channel: id,
  channel_type: z.string().optional(),
  user: id.optional(),
  bot_id: id.optional(),
  text: z.string().optional(),
  ts: id,
  thread_ts: id.optional(),
  files: z.array(slackFile).optional(),
});

const memberEvent = z.object({
  type: z.enum(['member_joined_channel', 'member_left_channel']),
  user: id,
  channel: id,
});

const blockActions = z.object({
  type: z.literal('block_actions'),
  user: z.object({ id }),
  channel: z.object({ id }),
  message: z.object({
    ts: id,
    text: z.string().optional(),
    blocks: z.array(z.looseObject({ type: z.string(), block_id: z.string().optional() })).optional(),
  }),
  actions: z
    .array(z.object({ action_id: id, block_id: z.string().optional(), value: z.string().optional() }))
    .min(1),
});

const base = {
  version: z.literal(1),
  eventId: id,
  sentAt: z.iso.datetime({ offset: true }),
  teamId: id,
};

const slackBase = {
  ...base,
  kind: z.literal('slack'),
  person: z.strictObject({ id }).nullable(),
};

const op = z.enum(['add', 'remove']);

export const routerEnvelopeSchema = z.discriminatedUnion('kind', [
  z.discriminatedUnion('payloadType', [
    z.strictObject({
      ...slackBase,
      route: z.enum(['dm', 'mention', 'thread_reply', 'channel_event']),
      payloadType: z.literal('event'),
      payload: z.union([messageEvent, memberEvent]),
    }),
    z.strictObject({
      ...slackBase,
      route: z.literal('action'),
      payloadType: z.literal('block_actions'),
      payload: blockActions,
    }),
  ]),
  z.strictObject({
    ...base,
    kind: z.literal('link'),
    link: z.discriminatedUnion('type', [
      z.strictObject({ op, type: z.literal('dm'), slackUserId: id, dmChannelId: id, personId: id }),
      z.strictObject({ op, type: z.literal('channel'), channelId: id, personId: id }),
    ]),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('connected'),
    workspace: z.strictObject({ teamId: id, teamName: z.string(), botUserId: id, botId: id }),
  }),
  z.strictObject({ ...base, kind: z.literal('disconnected') }),
]);

export type RouterEnvelope = z.infer<typeof routerEnvelopeSchema>;
export type SlackEnvelope = Extract<RouterEnvelope, { kind: 'slack' }>;
export type SlackRoute = SlackEnvelope['route'];
export type RoutedLink = Extract<RouterEnvelope, { kind: 'link' }>['link'];

/**
 * The body Bolt's `processEvent` reads for a `slack` envelope. It names no
 * team, so Bolt gives the listeners the app's own client, whose calls carry no
 * `team_id`: the proxy token already names the workspace.
 */
export function toBoltBody(envelope: SlackEnvelope): Record<string, unknown> {
  if (envelope.payloadType === 'block_actions') return envelope.payload;
  // A mention reaches the adapter's message handler, which reads it as the
  // message it is.
  const event =
    envelope.payload.type === 'app_mention' ? { ...envelope.payload, type: 'message' } : envelope.payload;
  return { type: 'event_callback', event_id: envelope.eventId, event };
}
