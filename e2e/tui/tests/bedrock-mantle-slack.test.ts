/**
 * Slack thread classification on `LLM_PROVIDER=bedrock-mantle`.
 *
 * The classifier is the runtime's only `generateObject` caller, and mantle
 * rejects the SDK's native structured-output path with a 400. `classifyThreadMessage`
 * catches that and returns `respond`, so from the outside the bot just looks
 * chatty — only a real workspace tells the difference.
 *
 * Socket Mode is per *app*: Slack hands each event to one of the connections
 * open for that token and never redelivers it, so any other holder can swallow
 * a message. CI keeps the token to one job (`e2e-slack`); the re-posting below
 * covers the connections a workflow cannot account for, and is gated on the
 * runtime's receipt line so it only ever answers a message that never arrived.
 *
 * Skips itself when the Slack e2e credentials are absent.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import stripAnsi from 'strip-ansi';
import Database from 'better-sqlite3';
import { WebClient } from '@slack/web-api';
import { setupRuntime, type RuntimeTestEnv } from '../setup';
import { SLACK_CLIENT_OPTIONS, pollUntil } from '../../support/slack-helper';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/bedrock-mantle-slack.feature'), 'utf8'),
);

const BOT_TOKEN = process.env.SLACK_E2E_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const USER_TOKEN = process.env.SLACK_E2E_USER_TOKEN;
const BOT_USER_ID = process.env.SLACK_E2E_BOT_USER_ID;
const hasSlack = Boolean(BOT_TOKEN && APP_TOKEN && USER_TOKEN && BOT_USER_ID);

/** Echoed by the opening mention's reply, so a late one is identifiable. */
const MENTION_MARKER = 'MANTLESLACK1';

/** The chatter the classifier must judge — no @mention, or the heuristic short-circuits. */
const FOLLOW_UP_TEXT =
  'thanks Dana, I will take the rest of this one — no need for anyone else to jump in';

/** The message the classifier must judge, and the thread it lives in. */
interface ThreadUnderTest {
  channelId: string;
  threadTs: string;
  /** Every follow-up posted, oldest first: any of them may be the one the runtime saw. */
  followUpTs: string[];
}

let env: RuntimeTestEnv;
let user: WebClient;
let agentId: string;
let ownerUserId: string;
let thread: ThreadUnderTest;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, Scenario }) => {
  BeforeAllScenarios(async () => {
    if (!hasSlack) return;
    user = new WebClient(USER_TOKEN, SLACK_CLIENT_OPTIONS);
    env = await setupRuntime({
      runtimeEnvOverrides: {
        LLM_PROVIDER: 'bedrock-mantle',
        // Mantle model IDs are bare and do not inherit from BEDROCK_MODEL_ID,
        // whose `us.` prefix mantle rejects.
        BEDROCK_MODEL_ID: undefined,
        SLACK_BOT_TOKEN: BOT_TOKEN,
        SLACK_APP_TOKEN: APP_TOKEN,
        // The e2e app id differs from the deployed one; the Playwright suite
        // skips the same check.
        SLACK_SKIP_BOT_ID_CHECK: 'true',
      },
    });
    const me = await runtimeAgent(env.port);
    agentId = me.agentId;
    ownerUserId = me.userId;
  });
  AfterAllScenarios(async () => {
    if (!hasSlack) return;
    // Archive rather than delete — Slack has no channel delete for bots, and
    // the workspace would otherwise accumulate one channel per CI run.
    // Bounded and logged rather than swallowed: a hanging Slack call would
    // otherwise eat the hook timeout, and a silently failing one leaves
    // channels behind with nothing to explain why.
    if (thread?.channelId) {
      await withTimeout(
        user.conversations.archive({ channel: thread.channelId }),
        15_000,
        'archive channel',
      ).catch((err: unknown) => {
        console.warn(`[mantle-slack] could not archive ${thread.channelId}: ${String(err)}`);
      });
    }

    // This is the only spec in the suite that opens a Socket Mode connection
    // and drives the Slack Web API from the test process itself, so it has more
    // to unwind than its neighbours: the runtime's websocket, and this fork's
    // keep-alive HTTP sockets. `cleanup()` awaits the runtime's exit; the settle
    // afterwards gives the event loop a beat to release the rest before the
    // next file forks and spawns a PTY of its own.
    await env.cleanup();
    await sleep(2_000);
  });

  Scenario(
    'Stays quiet on human-to-human chatter',
    ({ Given, And, When, Then }) => {
      Given('a Slack channel linked to the mantle agent', async () => {
        if (skip()) return;
        // A uuid keeps the name unique in Slack, and the LLM cache treats it as an id.
        const name = `mantle-e2e-${randomUUID()}`;
        const created = await user.conversations.create({ name });
        const channelId = created.channel?.id;
        if (!channelId) throw new Error(`could not create channel ${name}`);
        await user.conversations.invite({ channel: channelId, users: BOT_USER_ID! });
        // Slack takes a few seconds to start routing events after an invite.
        await sleep(5_000);

        // Seed the mapping straight into the runtime's DB. The product flow is
        // a verification code posted in the channel and confirmed in the SPA;
        // that is the web suite's subject, not this one's, and there is no
        // browser here.
        linkChannel(env.dbPath, agentId, ownerUserId, channelId, name);
        thread = { channelId, threadTs: '', followUpTs: [] };
      });

      And('the bot has replied in a thread', async () => {
        if (skip()) return;
        // The classifier only runs on threads the bot already participates in,
        // so this mention both opens the thread and gets the bot into it.
        const text = `<@${BOT_USER_ID}> reply with exactly: ${MENTION_MARKER}`;
        const opening = await user.chat.postMessage({ channel: thread.channelId, text });
        thread.threadTs = opening.ts!;

        // Re-post only while the runtime has not received it; a mention that
        // *was* received and went unanswered fails below. Re-posts go into the
        // same thread so `threadTs` stays the thread under test.
        const delivered = await postUntilReceived(
          () =>
            user.chat.postMessage({
              channel: thread.channelId,
              thread_ts: thread.threadTs,
              text,
            }),
          'mention',
        );
        expect(delivered, 'runtime never received the opening mention').toBe(true);

        const reply = await waitForBotReply(thread.channelId, thread.threadTs, 120_000);
        expect(reply, 'bot never replied to the opening mention').not.toBeNull();
      });

      And('Slack accepted the working status line on that thread', async () => {
        if (skip()) return;
        // The primary working cue for the turn above. Slack exposes no read for
        // an assistant-thread status, so the runtime's own log of the initial
        // `assistant.threads.setStatus` outcome is the only signal it rendered:
        // the accepted line proves the call reached Slack and came back ok, and
        // its absence (or the rejected line) is what a silently blank cue looks
        // like — the case the eyes reaction exists to cover.
        //
        // The turn has already replied by now, so the line is in the log; the
        // wait only absorbs the gap between the reply and the status log.
        const accepted = await waitForLog(/Slack thread status accepted/, 30_000);
        expect(accepted, 'runtime never logged an accepted Slack thread status').toBe(true);
        expect(logText(), 'status rejected — the cue fell back to the reaction').not.toMatch(
          /Slack thread status rejected/,
        );
      });

      When('a human posts a follow-up aimed at another person', async () => {
        if (skip()) return;
        // No @mention: a mention of another user would trip the pre-LLM
        // heuristic branch, which reacts without ever calling the classifier —
        // and this scenario is about the classifier.
        await postFollowUp();
      });

      Then('the classifier decides to ignore the follow-up', async () => {
        if (skip()) return;
        // The log line names the LLM branch, so it separates a real
        // classification from the heuristic shortcut and the catch's fallback.
        // Re-post while the chatter is dropped, then wait out the model call.
        const delivered = await postUntilReceived(postFollowUp, 'chatter');
        expect(delivered, 'runtime never received the follow-up').toBe(true);

        const decided = /LLM classifier decided to ignore thread message/;
        const seen = await waitForLog(decided, 90_000);
        expect(seen, `runtime log never matched ${decided}`).toBe(true);
      });

      And('the bot adds no reaction to the follow-up', async () => {
        if (skip()) return;
        // The verdict's log line is the adapter's last step for this message,
        // so a reaction the runtime added is already visible here.
        expect(await reactedFollowUps()).toEqual([]);
      });

      And('the bot posts no reply to the follow-up', async () => {
        if (skip()) return;
        // What a broken classifier looks like: the fallback is `respond`, so a
        // 400 would show up here as a bot message answering the follow-up.
        //
        // Anchored on the follow-up's timestamp rather than a count of bot
        // messages in the thread: the opening turn can produce several, since
        // the engine delivers each text-bearing step as its own Slack message.
        // What matters is that nothing arrived *after* the message the
        // classifier judged.
        const replies = await user.conversations.replies({
          channel: thread.channelId,
          ts: thread.threadTs,
          limit: 50,
        });
        // Anchored on the first follow-up, so a reply to any of them counts.
        // Matched by author, not `bot_id`: a user token belonging to a Slack app
        // stamps `bot_id` on this spec's own posts too. The marker excludes a
        // late answer to the mention, which is not the classifier's doing.
        expect(thread.followUpTs.length, 'no follow-up was ever posted').toBeGreaterThan(0);
        const firstFollowUp = Number(thread.followUpTs[0]);
        const after = (replies.messages ?? []).filter(
          (m) =>
            m.user === BOT_USER_ID &&
            Number(m.ts) > firstFollowUp &&
            !m.text?.includes(MENTION_MARKER),
        );
        expect(after.map((m) => m.text)).toEqual([]);
      });

      And('the classifier did not fall back', () => {
        if (skip()) return;
        expect(logText()).not.toMatch(/Thread classification failed/);
      });
    },
  );
});

/** Vitest has no per-scenario skip here, so each step short-circuits. */
function skip(): boolean {
  return !hasSlack;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reject rather than hang, so a stuck Slack call fails the hook with a name. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

function logText(): string {
  return stripAnsi(env.runtime.logTail(400_000));
}

async function runtimeAgent(port: number): Promise<{ agentId: string; userId: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/agents/me`);
  if (!res.ok) throw new Error(`/agents/me → ${res.status}`);
  return (await res.json()) as { agentId: string; userId: string };
}

/**
 * Insert the channel→agent mapping the adapter looks up per message.
 *
 * `lensUserId` is required: the channel handler skips any
 * mapping without one ("has no lensUserId - skipping (legacy mapping?)"), so
 * omitting it drops every message silently. The product flow stamps the
 * verifying user's id there; here that is the agent's owner.
 *
 * `connectionId` by contrast is stored but never matched on — `findByChannelId`
 * keys off `slackChannelId` alone and synthesizes `connection` from the env
 * tokens — so it only has to be present. Timestamps go in as epoch
 * milliseconds, which is what Prisma itself writes to a SQLite DATETIME; a
 * `datetime('now')` string would be a different affinity to read back.
 */
function linkChannel(
  dbPath: string,
  agent: string,
  owner: string,
  channelId: string,
  name: string,
): void {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO slack_mappings (id, connectionId, agentId, lensUserId, slackChannelId, slackChannelName, isMainChannel, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      `map-${channelId}`,
      process.env.SLACK_E2E_TEAM_ID ?? 'env-connection',
      agent,
      owner,
      channelId,
      name,
      now,
      now,
    );
  } finally {
    db.close();
  }
}

/**
 * A delivered event arrives in about four seconds; one routed elsewhere never
 * does. The window only has to tell those apart — the patience this spec needs
 * is for the model call that follows.
 */
const RECEIPT_WINDOW_MS = 12_000;

/** With three connections live a post lands here a third of the time. */
const MAX_POSTS = 8;

/**
 * Count the channel messages the adapter has logged receiving. `isMentioned`
 * separates the opening mention from the chatter without matching on wording:
 * the mention carries one, and the follow-up deliberately carries none.
 */
function countReceived(kind: 'mention' | 'chatter'): number {
  const re =
    kind === 'mention'
      ? /Slack channel message from .*isMentioned=true/g
      : /Slack channel message from .*isMentioned=false/g;
  return (logText().match(re) ?? []).length;
}

/**
 * Wait for the runtime to receive a message of `kind`, re-posting via `post`
 * while it has not. The caller has already posted once, so this waits first.
 * Reports only whether it arrived; what the runtime did with it is the caller's
 * assertion.
 */
async function postUntilReceived(
  post: () => Promise<unknown>,
  kind: 'mention' | 'chatter',
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_POSTS; attempt++) {
    if (await waitUntil(() => countReceived(kind) >= 1, RECEIPT_WINDOW_MS)) return true;
    if (attempt === MAX_POSTS) break;
    console.warn(`[mantle-slack] ${kind} not received in ${RECEIPT_WINDOW_MS}ms; re-posting`);
    await post();
  }
  return false;
}

/** Poll a local predicate (the runtime's log) until it holds, or give up. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(1_000);
  }
}

/** Post one more copy of the chatter and remember its ts. */
async function postFollowUp(): Promise<void> {
  const posted = await user.chat.postMessage({
    channel: thread.channelId,
    thread_ts: thread.threadTs,
    text: FOLLOW_UP_TEXT,
  });
  thread.followUpTs.push(posted.ts!);
}

/**
 * Wait for a message the *bot* wrote in the thread, matched by author: a user
 * token belonging to a Slack app stamps `bot_id` on this spec's own posts, so
 * only `user` separates the bot's replies from them.
 */
async function waitForBotReply(
  channel: string,
  threadTs: string,
  timeoutMs: number,
): Promise<string | null> {
  return pollUntil(
    async () => {
      const res = await user.conversations.replies({ channel, ts: threadTs, limit: 20 });
      const reply = res.messages?.find(
        (m) => m.user === BOT_USER_ID && m.ts !== threadTs && m.text,
      );
      return reply?.text ?? null;
    },
    { timeoutMs, label: `bot reply in ${channel}/${threadTs}` },
  );
}

/**
 * The timestamps of the follow-ups that carry a reaction. One
 * `conversations.replies` carries every message's reactions at once, on a more
 * generous rate limit than per-message `reactions.get`.
 */
async function reactedFollowUps(): Promise<string[]> {
  const wanted = new Set(thread.followUpTs);
  const res = await user.conversations.replies({
    channel: thread.channelId,
    ts: thread.threadTs,
    limit: 50,
  });
  return (res.messages ?? [])
    .filter(
      (m) =>
        m.ts !== undefined &&
        wanted.has(m.ts) &&
        ((m as { reactions?: unknown[] }).reactions?.length ?? 0) > 0,
    )
    .map((m) => m.ts!);
}

/**
 * Poll the runtime log for `pattern`. Reports whether it showed up rather than
 * throwing, so a caller can re-post and wait again instead of failing outright.
 */
async function waitForLog(pattern: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pattern.test(logText())) return true;
    if (Date.now() > deadline) return false;
    await sleep(2_000);
  }
}
