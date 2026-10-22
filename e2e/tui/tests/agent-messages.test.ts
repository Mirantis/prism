/**
 * `prism-cli` showing messages from the other agents of the project. A delivery
 * service posts them to `/agents/agent-messages`, signed with its key; the
 * steps post the same way, signed
 * with a key made for the run, which they give the runtime as list_agents would.
 * The labels are checked as the socket delivers each message and again from the
 * history a reopened terminal reads. Single-thread mode, so the reopened
 * terminal opens the same conversation.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { createTestDeliverySigner } from '../../../src/test-utils/agent-message-signer';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, type TuiSession } from '../harness';
import { countMessages, setupRuntime, runtimeRequest, type RuntimeTestEnv } from '../setup';

/** The sender id of what the delivery service itself says about the agent's messages. */
const NOTICE_SENDER_ID = 'messaging';
/** Already in the conversation, so its frame shows the terminal has read the history and is following the stream. */
const HISTORY_MARKER = 'agent-messages-history-marker';

const feature = loadFeatureFromText(
  readFileSync(path.join(import.meta.dirname, '../features/agent-messages.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession | undefined;
const signer = createTestDeliverySigner('tui-agent');

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime({ runtimeEnvOverrides: { THREAD_MODE: 'single' } });
    keepDeliveryKeys(env.dbPath);
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  AfterEachScenario(async () => {
    if (session) await session.stop();
    session = undefined;
  });

  const post = async (kind: 'message' | 'notice', sender: { id: string; name: string }, content: string) => {
    const body = JSON.stringify({
      id: randomUUID(),
      messageId: randomUUID(),
      conversationId: randomUUID(),
      kind,
      sender,
      content,
      expectsReply: false,
      attachmentIds: [],
    });
    const res = await fetch(`http://127.0.0.1:${env.port}/agents/agent-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-message-signature': signer.sign(body) },
      body,
    });
    if (res.status !== 202) throw new Error(`POST /agents/agent-messages → ${res.status}: ${await res.text()}`);
  };

  const showsSender = (sender: string) =>
    session!.waitForFrame(new RegExp(`▌ ${escapeRegExp(sender)}`), 30_000);

  Scenario(
    'Agent messages show under their senders, as they arrive and after reopening',
    ({ Given, When, Then, And }) => {
      Given("the CLI shows the agent's conversation", async () => {
        const { threadId } = await runtimeRequest<{ threadId: string }>(env.port, 'GET', '/latest-thread');
        seedMessage(env.dbPath, threadId, HISTORY_MARKER);
        session = startPrism({ env: env.prismEnv, runtime: env.runtime });
        await session.waitForFrame(new RegExp(HISTORY_MARKER), BOOT_FRAME_TIMEOUT_MS);
      });
      When('the agent {string} sends {string} to this agent', async (_ctx, name: string, content: string) => {
        await post('message', { id: randomUUID(), name }, content);
      });
      And('{string} sends the notice {string}', async (_ctx, name: string, content: string) => {
        await post('notice', { id: NOTICE_SENDER_ID, name }, content);
      });
      Then('the screen shows a message from {string}', async (_ctx, sender: string) => {
        await showsSender(sender);
      });
      And('the screen shows a message from {string}', async (_ctx, sender: string) => {
        await showsSender(sender);
      });
      When('the agent has answered them', async () => {
        // A reply beside the seeded marker, then no work left: the reopened terminal
        // reads a finished conversation, and no turn runs when the runtime stops.
        await expect
          .poll(
            async () =>
              countMessages(env.dbPath, 'AGENT') > 1 &&
              (await runtimeRequest<{ state: string }>(env.port, 'GET', '/agents/state')).state === 'idle',
            { timeout: 240_000, interval: 1_000 },
          )
          .toBe(true);
      });
      And('I reopen the CLI', async () => {
        await session!.stop();
        session = startPrism({ env: env.prismEnv, runtime: env.runtime });
        await session.waitForFrame(new RegExp(HISTORY_MARKER), BOOT_FRAME_TIMEOUT_MS);
      });
      Then('the reopened CLI shows a message from {string}', async (_ctx, sender: string) => {
        await showsSender(sender);
      });
      And('the reopened CLI shows a message from {string}', async (_ctx, sender: string) => {
        await showsSender(sender);
      });
    },
  );
});

/**
 * Store one message in a thread, as an earlier turn would have. It copies the
 * thread's own createdAt, so the value reads back through Prisma whatever its
 * on-disk DateTime encoding.
 */
/** Give the runtime the run's key, as list_agents would. */
function keepDeliveryKeys(dbPath: string): void {
  const { key, value } = signer.keptKeys();
  const db = new Database(dbPath);
  try {
    db.prepare('INSERT OR REPLACE INTO runtime_state (key, value, updatedAt) VALUES (?, ?, ?)').run(key, value, Date.now());
  } finally {
    db.close();
  }
}

function seedMessage(dbPath: string, threadId: string, content: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO conversation_messages (id, threadId, role, content, triggeredBy, isCompacted, createdAt)
       SELECT ?, id, 'AGENT', ?, 'USER_INPUT', 0, createdAt
       FROM conversation_threads WHERE id = ?`,
    ).run(`msg-${content}`, content, threadId);
  } finally {
    db.close();
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
