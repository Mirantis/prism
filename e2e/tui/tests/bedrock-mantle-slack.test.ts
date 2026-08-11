/**
 * Slack thread classification on `LLM_PROVIDER=bedrock-mantle`.
 *
 * The classifier is the runtime's only `generateObject` caller, and mantle
 * rejects the SDK's native structured-output path with a 400. That failure is
 * invisible from the outside — `classifyThreadMessage` catches it and returns
 * `respond` — so the bot would answer every threaded message and look merely
 * chatty. Only an end-to-end run through a real workspace tells the difference,
 * which is why this exists alongside the unit tests.
 *
 * Slack rather than the PTY, and its own runtime rather than the Playwright
 * one: the Socket Mode connection is exclusive per bot token, and the
 * Playwright suite holds it for its whole run on the `bedrock` provider. The
 * two suites are separate steps of the same CI job, so they never overlap.
 *
 * Skips itself when the Slack e2e credentials are absent, matching the
 * Playwright `@slack` scenarios — the mantle chat coverage in
 * `bedrock-mantle.test.ts` needs no Slack and still runs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import stripAnsi from 'strip-ansi';
import Database from 'better-sqlite3';
import { WebClient } from '@slack/web-api';
import { setupRuntime, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/bedrock-mantle-slack.feature'), 'utf8'),
);

const BOT_TOKEN = process.env.SLACK_E2E_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const USER_TOKEN = process.env.SLACK_E2E_USER_TOKEN;
const BOT_USER_ID = process.env.SLACK_E2E_BOT_USER_ID;
const hasSlack = Boolean(BOT_TOKEN && APP_TOKEN && USER_TOKEN && BOT_USER_ID);

/** The message the classifier must judge, and the thread it lives in. */
interface ThreadUnderTest {
  channelId: string;
  threadTs: string;
  followUpTs: string;
}

let env: RuntimeTestEnv;
let user: WebClient;
let agentId: string;
let ownerUserId: string;
let thread: ThreadUnderTest;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, Scenario }) => {
  BeforeAllScenarios(async () => {
    if (!hasSlack) return;
    user = new WebClient(USER_TOKEN);
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
    'Reacts with an emoji instead of replying to human-to-human chatter',
    ({ Given, And, When, Then }) => {
      Given('a Slack channel linked to the mantle agent', async () => {
        if (skip()) return;
        const name = `mantle-e2e-${Date.now().toString(36)}`;
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
        thread = { channelId, threadTs: '', followUpTs: '' };
      });

      And('the bot has replied in a thread', async () => {
        if (skip()) return;
        // The classifier only runs on threads the bot already participates in,
        // so this mention both opens the thread and gets the bot into it.
        const posted = await user.chat.postMessage({
          channel: thread.channelId,
          text: `<@${BOT_USER_ID}> reply with exactly: MANTLESLACK1`,
        });
        thread.threadTs = posted.ts!;
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
        await waitForLog(/Slack thread status accepted/, 30_000);
        expect(logText(), 'status rejected — the cue fell back to the reaction').not.toMatch(
          /Slack thread status rejected/,
        );
      });

      When('a human posts a follow-up aimed at another person', async () => {
        if (skip()) return;
        // No @mention: a mention of another user would trip the pre-LLM
        // heuristic branch, which reacts without ever calling the classifier —
        // and this scenario is about the classifier.
        const posted = await user.chat.postMessage({
          channel: thread.channelId,
          thread_ts: thread.threadTs,
          text: 'thanks Dana, I will take the rest of this one — no need for anyone else to jump in',
        });
        thread.followUpTs = posted.ts!;
      });

      Then('the classifier decides on a reaction rather than a reply', async () => {
        if (skip()) return;
        // The log line is the authoritative signal: it names the LLM branch, so
        // it distinguishes a real classification from the heuristic shortcut
        // and from the catch's fallback.
        await waitForLog(/LLM classifier decided only a reaction \(no response\)/, 90_000);
      });

      And('the bot adds an emoji reaction to that message', async () => {
        if (skip()) return;
        const reactions = await waitForReaction(thread.channelId, thread.followUpTs, 30_000);
        expect(reactions, 'no reaction appeared on the follow-up').not.toHaveLength(0);
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
        const after = (replies.messages ?? []).filter(
          (m) => m.bot_id && Number(m.ts) > Number(thread.followUpTs),
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
 * `lensUserId` is load-bearing, not decoration: the channel handler skips any
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

async function waitForBotReply(
  channel: string,
  threadTs: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await user.conversations.replies({ channel, ts: threadTs, limit: 20 });
    const bot = res.messages?.find((m) => m.bot_id && m.ts !== threadTs);
    if (bot?.text) return bot.text;
    await sleep(2_000);
  }
  return null;
}

async function waitForReaction(
  channel: string,
  ts: string,
  timeoutMs: number,
): Promise<Array<{ name?: string }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await user.reactions.get({ channel, timestamp: ts, full: true });
    const reactions = (res.message as { reactions?: Array<{ name?: string }> } | undefined)
      ?.reactions;
    if (reactions?.length) return reactions;
    if (Date.now() > deadline) return [];
    await sleep(2_000);
  }
}

/** Poll the runtime log until `pattern` shows up. */
async function waitForLog(pattern: RegExp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pattern.test(logText())) return;
    if (Date.now() > deadline) {
      throw new Error(`runtime log never matched ${pattern} within ${timeoutMs}ms`);
    }
    await sleep(2_000);
  }
}
