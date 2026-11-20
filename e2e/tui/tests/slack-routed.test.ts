/**
 * Slack routed mode against a real workspace.
 *
 * The runtime runs with `SLACK_API_URL` and no app token, so it opens no Socket
 * Mode connection: this spec delivers each Slack event to it as the router
 * would, and every Slack call it makes reaches the workspace through the proxy
 * double (`support/slack-router-double.ts`). The spec posts the human side of
 * each conversation with the e2e user token, so the agent replies in real
 * threads, and reads the replies back from Slack.
 *
 * Skips itself when the Slack e2e credentials are absent.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import Database from 'better-sqlite3';
import { WebClient } from '@slack/web-api';
import {
  findFreePort,
  runtimeRequest,
  setupRuntime,
  type RuntimeTestEnv,
} from '../setup';
import { SLACK_CLIENT_OPTIONS, pollUntil } from '../../support/slack-helper';
import {
  PROXY_METHODS,
  PROXY_TOKEN,
  SlackApiProxy,
  deliverEnvelope,
  envelopeBase,
} from '../../support/slack-router-double';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/slack-routed.feature'), 'utf8'),
);

const BOT_TOKEN = process.env.SLACK_E2E_BOT_TOKEN;
const USER_TOKEN = process.env.SLACK_E2E_USER_TOKEN;
const BOT_USER_ID = process.env.SLACK_E2E_BOT_USER_ID;
const TEAM_ID = process.env.SLACK_E2E_TEAM_ID;
const hasSlack = Boolean(BOT_TOKEN && USER_TOKEN && BOT_USER_ID && TEAM_ID);

const FEEDBACK_ACTION_UP = 'feedback_thumbs_up';
const FEEDBACK_BLOCK_ID = 'lens_feedback';
const FEEDBACK_ACK_BLOCK_ID = 'lens_feedback_ack';

let env: RuntimeTestEnv;
let proxy: SlackApiProxy;
let slackPort: number;
let user: WebClient;
let bot: WebClient;
/** The test user's Slack id. */
let me: string;
/** The agent's owner, the person every link names. */
let owner: string;
let dmChannelId: string;
let channelId: string;
/** The thread the current channel scenario talks in, and the agent's newest reply there. */
let threadTs: string;
let lastReplyTs: string;
let joinedThreadTs: string;
/** How many calls the proxy had answered when the agent was added to the workspace. */
let boundAt = 0;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, Scenario }) => {
  BeforeAllScenarios(async () => {
    if (!hasSlack) return;
    user = new WebClient(USER_TOKEN, SLACK_CLIENT_OPTIONS);
    bot = new WebClient(BOT_TOKEN, SLACK_CLIENT_OPTIONS);
    me = (await user.auth.test()).user_id!;
    proxy = new SlackApiProxy(BOT_TOKEN!);
    const apiUrl = await proxy.start();
    slackPort = await findFreePort();
    env = await setupRuntime({
      runtimeEnvOverrides: {
        SLACK_BOT_TOKEN: PROXY_TOKEN,
        SLACK_API_URL: apiUrl,
        SLACK_PORT: String(slackPort),
        // Empty rather than unset: the runtime loads a developer's `.env`,
        // which must not put this runtime on Socket Mode.
        SLACK_APP_TOKEN: '',
        SLACK_EXPECTED_APP_ID: '',
      },
    });
    owner = (await runtimeRequest<{ userId: string }>(env.port, 'GET', '/agents/me')).userId;
  });

  AfterAllScenarios(async () => {
    if (!hasSlack) return;
    if (channelId) {
      await user.conversations.archive({ channel: channelId }).catch((err: unknown) => {
        console.warn(`[slack-routed] could not archive ${channelId}: ${String(err)}`);
      });
    }
    await env?.cleanup();
    await proxy?.stop();
  });

  Scenario('The agent waits for Slack until the router connects it', ({ Given, Then, When }) => {
    Given('an agent in routed mode that is in no Slack workspace', () => {
      if (skip()) return;
      // The boot's `auth.test` is the only call before the agent is in a workspace.
      expect(proxy.calls.length).toBeGreaterThan(0);
      expect(proxy.calls.every((call) => call.method === 'auth.test' && call.refused === 'invalid_auth')).toBe(true);
    });

    Then('the agent lists no Slack workspace', async () => {
      if (skip()) return;
      expect(await workspaces()).toEqual([]);
    });

    When('the router reports the agent connected to the test workspace', async () => {
      if (skip()) return;
      boundAt = proxy.calls.length;
      proxy.bound = true;
      const auth = await bot.auth.test();
      const answer = await deliverEnvelope(slackPort, {
        ...envelopeBase(TEAM_ID!),
        kind: 'connected',
        workspace: { teamId: auth.team_id, teamName: auth.team, botUserId: auth.user_id, botId: auth.bot_id },
      });
      expect(answer).toEqual({ status: 200, body: { ok: true } });
    });

    Then('the agent lists the test workspace', async () => {
      if (skip()) return;
      expect((await workspaces()).map((w) => w.teamId)).toEqual([TEAM_ID]);
    });
  });

  Scenario('The agent refuses a delivery the ingress did not verify', ({ When, Then }) => {
    let marker: string;

    When('an envelope arrives without the ingress verification', async () => {
      if (skip()) return;
      marker = `UNVERIFIED${randomUUID().slice(0, 8)}`;
      const envelope = directMessage(`Reply with exactly: ${marker}`, 'D0NOTUSED');
      expect((await deliverEnvelope(slackPort, envelope, {})).status).toBe(401);
      expect((await deliverEnvelope(slackPort, envelope, { 'x-nexus-webhook-verified': '0' })).status).toBe(401);
    });

    Then('the agent answers 401 and handles nothing', async () => {
      if (skip()) return;
      await sleep(3_000);
      expect(sentMessages(marker)).toBe(0);
    });
  });

  Scenario('Replying to a direct message', ({ Given, When, Then }) => {
    Given('the router links my DM with the bot to the agent', async () => {
      if (skip()) return;
      // The router learns the DM channel from Slack. The spec asks Slack for it
      // by posting to the test user as the bot.
      const opened = await bot.chat.postMessage({ channel: me, text: 'Routed-mode e2e: this DM is linked to the agent.' });
      dmChannelId = opened.channel!;
      const answer = await deliverEnvelope(slackPort, {
        ...envelopeBase(TEAM_ID!),
        kind: 'link',
        link: { op: 'add', type: 'dm', slackUserId: me, dmChannelId, personId: owner },
      });
      expect(answer.status).toBe(200);
      expect(mappingRows('slackUserId = ? AND dmChannelId = ?', me, dmChannelId)).toBe(1);
    });

    When('the router delivers my direct message {string}', async (_ctx, text: string) => {
      if (skip()) return;
      // The e2e app grants the user token no DM scopes, so this message exists
      // in the envelope alone; the agent reads nothing else of it.
      expect((await deliverEnvelope(slackPort, directMessage(text, dmChannelId))).status).toBe(200);
    });

    Then('the agent replies {string} in my DM within 120 seconds', async (_ctx, marker: string) => {
      if (skip()) return;
      const posted = await pollUntil(
        async () =>
          proxy.calls.find(
            (call) =>
              call.method === 'chat.postMessage' &&
              call.params.channel === dmChannelId &&
              call.params.text?.includes(marker) &&
              call.response?.ok === true,
          ),
        { timeoutMs: 120_000, intervalMs: 1_000, label: 'agent reply in the DM' },
      );
      expect(posted, 'the agent posted no reply in the DM').not.toBeNull();
    });
  });

  Scenario('Replying to a mention, a thread reply and a feedback click', ({ Given, When, Then }) => {
    Given('the router links a new test channel to the agent', async () => {
      if (skip()) return;
      const created = await user.conversations.create({ name: `routed-e2e-${randomUUID()}` });
      channelId = created.channel!.id!;
      await user.conversations.invite({ channel: channelId, users: BOT_USER_ID! });
      const answer = await deliverEnvelope(slackPort, {
        ...envelopeBase(TEAM_ID!),
        kind: 'link',
        link: { op: 'add', type: 'channel', channelId, personId: owner },
      });
      expect(answer.status).toBe(200);
      expect(mappingRows('slackChannelId = ?', channelId)).toBe(1);
    });

    When('the router delivers my mention {string}', async (_ctx, text: string) => {
      if (skip()) return;
      threadTs = await deliverMention(text);
    });

    Then('the agent replies {string} in the thread within 120 seconds', async (_ctx, marker: string) => {
      if (skip()) return;
      lastReplyTs = await waitForBotReply(threadTs, marker, threadTs);
    });

    When('the router delivers my thread reply {string}', async (_ctx, text: string) => {
      if (skip()) return;
      const posted = await user.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
      const answer = await deliverEnvelope(slackPort, {
        ...slackEvent('thread_reply'),
        payload: { type: 'message', channel: channelId, channel_type: 'channel', user: me, text, ts: posted.ts, thread_ts: threadTs },
      });
      expect(answer.status).toBe(200);
    });

    Then('the agent answers the thread reply with {string} within 120 seconds', async (_ctx, marker: string) => {
      if (skip()) return;
      lastReplyTs = await waitForBotReply(threadTs, marker, lastReplyTs);
    });

    When("the router delivers a thumbs-up click on the agent's last reply", async () => {
      if (skip()) return;
      const messageId = await pollUntil(async () => storedReplyId(lastReplyTs), {
        timeoutMs: 30_000,
        intervalMs: 1_000,
        label: 'stored agent reply',
      });
      expect(messageId, 'the agent stored no reply with that ts').not.toBeNull();
      const replies = await user.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
      const reply = replies.messages?.find((m) => m.ts === lastReplyTs);
      const answer = await deliverEnvelope(slackPort, {
        ...slackEvent('action'),
        payloadType: 'block_actions',
        payload: {
          type: 'block_actions',
          user: { id: me },
          channel: { id: channelId },
          message: {
            ts: lastReplyTs,
            blocks: [...(reply?.blocks ?? []), { type: 'actions', block_id: FEEDBACK_BLOCK_ID, elements: [] }],
          },
          actions: [{ action_id: FEEDBACK_ACTION_UP, value: messageId }],
        },
      });
      expect(answer.status).toBe(200);
    });

    Then("the agent replaces that reply's feedback buttons within 30 seconds", async () => {
      if (skip()) return;
      const updated = await pollUntil(
        async () =>
          proxy.calls.find(
            (call) =>
              call.method === 'chat.update' &&
              call.params.ts === lastReplyTs &&
              call.response?.ok === true &&
              blockIds(call.params.blocks).includes(FEEDBACK_ACK_BLOCK_ID) &&
              !blockIds(call.params.blocks).includes(FEEDBACK_BLOCK_ID),
          ),
        { timeoutMs: 30_000, intervalMs: 1_000, label: 'feedback buttons replaced' },
      );
      expect(updated, 'the agent did not replace the feedback buttons').not.toBeNull();
    });
  });

  Scenario('Stale and repeated deliveries are not handled again', ({ When, Then, And }) => {
    When('the router delivers a mention {string} sent ten minutes ago', async (_ctx, text: string) => {
      if (skip()) return;
      const posted = await user.chat.postMessage({ channel: channelId, text: `<@${BOT_USER_ID}> ${text}` });
      const answer = await deliverEnvelope(slackPort, {
        ...mentionEnvelope(text, posted.ts!),
        sentAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      expect(answer).toEqual({ status: 200, body: { ok: true } });
    });

    Then('the agent stores no message containing {string}', async (_ctx, marker: string) => {
      if (skip()) return;
      await sleep(5_000);
      expect(sentMessages(marker)).toBe(0);
    });

    When('the router delivers a mention {string} twice', async (_ctx, text: string) => {
      if (skip()) return;
      const posted = await user.chat.postMessage({ channel: channelId, text: `<@${BOT_USER_ID}> ${text}` });
      threadTs = posted.ts!;
      const envelope = mentionEnvelope(text, threadTs);
      expect((await deliverEnvelope(slackPort, envelope)).status).toBe(200);
      // The router's retry after a lost answer: the same event, sent again.
      expect((await deliverEnvelope(slackPort, { ...envelope, sentAt: new Date().toISOString() })).status).toBe(200);
    });

    Then('the agent replies {string} in the thread within 120 seconds', async (_ctx, marker: string) => {
      if (skip()) return;
      lastReplyTs = await waitForBotReply(threadTs, marker, threadTs);
    });

    And('the agent stores one message containing {string}', (_ctx, marker: string) => {
      if (skip()) return;
      expect(sentMessages(marker)).toBe(1);
    });
  });

  Scenario('Joining a thread that already has messages', ({ Given, When, Then, And }) => {
    Given('a thread in the test channel that the agent is not in', async () => {
      if (skip()) return;
      const root = await user.chat.postMessage({ channel: channelId, text: 'ROUTEDROOT: the deploy window opens at nine.' });
      joinedThreadTs = root.ts!;
    });

    When('the router delivers my mention {string} in that thread', async (_ctx, text: string) => {
      if (skip()) return;
      const posted = await user.chat.postMessage({
        channel: channelId,
        thread_ts: joinedThreadTs,
        text: `<@${BOT_USER_ID}> ${text}`,
      });
      const answer = await deliverEnvelope(slackPort, {
        ...slackEvent('mention'),
        payload: {
          type: 'app_mention',
          channel: channelId,
          user: me,
          text: `<@${BOT_USER_ID}> ${text}`,
          ts: posted.ts,
          thread_ts: joinedThreadTs,
        },
      });
      expect(answer.status).toBe(200);
    });

    Then('the agent replies {string} in that thread within 120 seconds', async (_ctx, marker: string) => {
      if (skip()) return;
      await waitForBotReply(joinedThreadTs, marker, joinedThreadTs);
    });

    And('the agent read that thread from Slack once and keeps its first message', () => {
      if (skip()) return;
      const reads = proxy.calls.filter((call) => call.method === 'conversations.replies');
      expect(reads.map((call) => call.params.ts)).toEqual([joinedThreadTs]);
      expect(sentMessages('ROUTEDROOT', joinedThreadTs)).toBe(1);
    });
  });

  Scenario('Unlinking a channel', ({ When, Then }) => {
    When('the router unlinks the test channel', async () => {
      if (skip()) return;
      const answer = await deliverEnvelope(slackPort, {
        ...envelopeBase(TEAM_ID!),
        kind: 'link',
        link: { op: 'remove', type: 'channel', channelId, personId: owner },
      });
      expect(answer.status).toBe(200);
    });

    Then('the agent has no link for the test channel', () => {
      if (skip()) return;
      expect(mappingRows('slackChannelId = ?', channelId)).toBe(0);
    });
  });

  Scenario('Every Slack call goes through the proxy', ({ Then }) => {
    Then("the agent called only the proxy's methods, with the parameters each one takes", () => {
      if (skip()) return;
      // Before the agent was added to Slack the proxy refused its `auth.test`; since then, nothing.
      const refused = proxy.calls
        .slice(boundAt)
        .filter((call) => call.refused)
        .map((call) => `${call.method} ${JSON.stringify(call.params)}: ${call.refused}`);
      expect(refused).toEqual([]);
      expect(proxy.calls.every((call) => call.method in PROXY_METHODS)).toBe(true);
    });
  });
});

/** Vitest has no per-scenario skip here, so each step short-circuits. */
function skip(): boolean {
  return !hasSlack;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function workspaces(): Promise<Array<{ teamId: string }>> {
  return (await runtimeRequest<{ workspaces: Array<{ teamId: string }> }>(env.port, 'GET', '/agents/slack/workspaces'))
    .workspaces;
}

/** The fields of a `slack` envelope for `route`, with an event payload to fill in. */
function slackEvent(route: string) {
  return { ...envelopeBase(TEAM_ID!), kind: 'slack', route, person: { id: owner }, payloadType: 'event' };
}

function directMessage(text: string, channel: string) {
  const ts = `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(6, '0')}`;
  return {
    ...slackEvent('dm'),
    payload: { type: 'message', channel, channel_type: 'im', user: me, text, ts },
  };
}

function mentionEnvelope(text: string, ts: string) {
  return {
    ...slackEvent('mention'),
    payload: { type: 'app_mention', channel: channelId, user: me, text: `<@${BOT_USER_ID}> ${text}`, ts },
  };
}

/** Post a mention as the test user and deliver it as the router; resolves its ts. */
async function deliverMention(text: string): Promise<string> {
  const posted = await user.chat.postMessage({ channel: channelId, text: `<@${BOT_USER_ID}> ${text}` });
  const answer = await deliverEnvelope(slackPort, mentionEnvelope(text, posted.ts!));
  expect(answer.status).toBe(200);
  return posted.ts!;
}

/**
 * The ts of the first message the bot posted in `thread` after `after` that
 * holds `marker`, read from Slack. Matched by author: the e2e user token stamps
 * `bot_id` on the spec's own posts too.
 */
async function waitForBotReply(thread: string, marker: string, after: string): Promise<string> {
  const ts = await pollUntil(
    async () => {
      const res = await user.conversations.replies({ channel: channelId, ts: thread, limit: 50 });
      return res.messages?.find(
        (m) => m.user === BOT_USER_ID && Number(m.ts) > Number(after) && m.text?.includes(marker),
      )?.ts;
    },
    { timeoutMs: 120_000, label: `bot reply with ${marker}` },
  );
  expect(ts, `the agent posted no reply with ${marker}`).not.toBeNull();
  return ts!;
}

function blockIds(blocks: string | undefined): string[] {
  if (!blocks) return [];
  return (JSON.parse(blocks) as Array<{ block_id?: string }>).map((block) => block.block_id ?? '');
}

function storedReplyId(ts: string): string | null {
  const db = new Database(env.dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT id FROM conversation_messages WHERE role = 'AGENT' AND externalMessageId = ?")
      .get(ts) as { id: string } | undefined;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

/** How many of the agent's Slack links match `where`, with `values` bound to its placeholders. */
function mappingRows(where: string, ...values: string[]): number {
  const db = new Database(env.dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM slack_mappings WHERE ${where}`).get(...values) as { n: number }).n;
  } finally {
    db.close();
  }
}

/**
 * How many stored messages a person sent that contain `marker`, in the Slack
 * thread `threadTs` when given. A turn's recalled memories are stored as a user
 * row too, as an internal step, so those rows are left out.
 */
function sentMessages(marker: string, threadTs?: string): number {
  const db = new Database(env.dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_messages m JOIN conversation_threads t ON t.id = m.threadId
         WHERE m.role = 'USER' AND m.internalStep = 0 AND m.content LIKE ? AND (? IS NULL OR t.externalThreadId = ?)`,
      )
      .get(`%${marker}%`, threadTs ?? null, threadTs ?? null) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}
