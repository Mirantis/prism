/**
 * Manual-compaction step definitions.
 *
 * The history is seeded directly in the database (precedent:
 * context-window.steps.ts writes thread columns directly) so the scenario
 * exercises exactly one model call — the summarizer — instead of ten chat
 * turns. Assertions are DB-authoritative for the compaction state and
 * DOM-level for the progress UX; the telemetry assertion goes through the real
 * OTLP collector → MinIO pipeline.
 *
 * Note: the "I open a fresh chat" and "I reload the chat page" steps are
 * defined in context-window.steps.ts / file-sharing.steps.ts; playwright-bdd
 * hard-errors on duplicate definitions.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { waitForTelemetryEvent } from '../support/s3-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

// No `When` here on purpose: the scenarios drive the UI through the shared
// chat steps ("I type … in the chat input" / "I send the message").
const { Given, Then } = createBdd();

const SEED_COUNT = 10;
/** Must match the runtime default (COMPACTION_TAIL_MESSAGES). */
const TAIL = 6;

const seededContent = (i: number) =>
  `compaction-seed-${i}: the deployment uses port ${3000 + i} for service-${i}.`;

/** Poll `fn` until `ok` holds or the timeout elapses; returns the last value. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const start = Date.now();
  let last = await fn();
  while (!ok(last) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

/**
 * The indicator shows while the summarizer runs, which can be shorter than a poll when the e2e LLM
 * cache answers it. The script sets a flag when the indicator first appears. The flag shows that
 * the indicator was added to the page, not that it was visible: a replayed summarizer can remove it
 * before the next paint.
 */
function watchCompactingIndicator() {
  const w = window as unknown as { __compactingSeen: boolean };
  w.__compactingSeen = false;
  new MutationObserver(() => {
    if (document.querySelector('[data-testid="compacting-indicator"]')) w.__compactingSeen = true;
  }).observe(document, { childList: true, subtree: true });
}

async function latestThread() {
  const thread = await dbHelper.getPrisma().conversationThread.findFirst({
    where: { agentId: DEFAULT_AGENT_ID },
    orderBy: { updatedAt: 'desc' },
  });
  if (!thread) throw new Error('no thread found for the default agent');
  return thread;
}

Given('a conversation seeded with 10 messages', async ({ page }) => {
  const messages = Array.from({ length: SEED_COUNT }, (_, i) => ({
    role: (i % 2 === 0 ? 'USER' : 'AGENT') as 'USER' | 'AGENT',
    content: seededContent(i),
  }));
  await dbHelper.createThread(DEFAULT_AGENT_ID, { title: 'Compaction seed', messages });
  // The seeded thread is the newest, so the chat opens straight onto it.
  await new HomePage(page).navigate();
  await expect(new HomePage(page).getMessageByText(seededContent(0))).toBeVisible({
    timeout: 10_000,
  });
  await page.evaluate(watchCompactingIndicator);
});

Then('the compacting indicator appears', async ({ page }) => {
  // Broadcast as the `started` compaction frame.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __compactingSeen: boolean }).__compactingSeen), {
      timeout: 30_000,
    })
    .toBe(true);
});

Then('the compaction note appears in the conversation', async ({ page }) => {
  // The summarizer is a real model call over the seeded history.
  await expect(new HomePage(page).getMessageByText('Conversation compacted')).toBeVisible({
    timeout: 120_000,
  });
});

Then('the thread stores a compaction summary with the tail preserved', async () => {
  const thread = await pollUntil(
    latestThread,
    (t) => Boolean(t.compactionSummary),
    120_000,
  );
  // The structured template's fixed headings prove a real summary landed.
  expect(thread.compactionSummary).toContain('## Goal');
  expect(thread.compactedThroughTs).toBeTruthy();

  const rows = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: 'asc' },
  });
  const compacted = rows.filter((r) => r.isCompacted);
  const kept = rows.filter((r) => !r.isCompacted);
  // Exactly seeded − tail rows are folded into the summary; the newest TAIL
  // stay verbatim — and they are the newest, not an arbitrary subset.
  expect(compacted).toHaveLength(SEED_COUNT - TAIL);
  expect(kept).toHaveLength(TAIL);
  expect(compacted.map((r) => r.content)).toEqual(
    Array.from({ length: SEED_COUNT - TAIL }, (_, i) => seededContent(i)),
  );
});

Then('a manual compaction telemetry event is recorded', async () => {
  const event = await waitForTelemetryEvent('compaction finished', 60_000);
  expect(event.attributes['compaction.trigger']).toBe('manual');
  expect(event.attributes['thread.source']).toBe('DATABASE');
  expect(Number(event.attributes['compaction.messages_compacted'])).toBe(SEED_COUNT - TAIL);
  // Stats only — the summary text itself must never reach telemetry.
  expect(JSON.stringify(event.attributes)).not.toContain('compaction-seed-0');
});

/** One line of a long, invented deploy log holds the build id; the summary below never names it. */
const BUILD_ID = 'bld-7f3a9c2e';
const DEPLOY_LOG = Array.from({ length: 400 }, (_, i) =>
  i === 287 ? `step ${i}: artifact uploaded, build id ${BUILD_ID}` : `step ${i}: ok (checkout-api rollout, replica ${i % 3})`,
).join('\n');

Given('a compacted conversation whose summary leaves out the build id from a deploy log', async ({ page }) => {
  const threadId = await dbHelper.createThread(DEFAULT_AGENT_ID, {
    title: 'Deploy log',
    messages: [
      { role: 'USER', content: 'Read yesterday\'s deploy log of checkout-api and tell me if it went fine.' },
      {
        role: 'AGENT',
        content: 'The rollout finished; every step reported ok.',
        toolCalls: [{ tool: 'shell_exec', input: '{"command":"cat deploy.log"}', output: DEPLOY_LOG, rendered: true }],
      },
      { role: 'USER', content: 'Thanks.' },
      { role: 'AGENT', content: 'You are welcome.' },
    ],
  });
  const prisma = dbHelper.getPrisma();
  await prisma.conversationMessage.updateMany({ where: { threadId }, data: { isCompacted: true } });
  await prisma.conversationThread.update({
    where: { id: threadId },
    data: {
      compactionSummary:
        '## Goal\n- Check whether yesterday\'s checkout-api deploy went fine.\n\n' +
        '## Current State\n- Done: read the deploy log with shell_exec; every step reported ok.',
      compactedAt: new Date(),
    },
  });
  await new HomePage(page).navigate();
});

/** Three warnings far apart in one long log: a page of the conversation shows the start of the log alone. */
const WARNING_STEPS = [41, 212, 377];
const WARNING_LOG = Array.from({ length: 400 }, (_, i) =>
  WARNING_STEPS.includes(i) ? `step ${i}: WARN disk usage high on node-${i % 5}` : `step ${i}: ok (payments-api rollout, replica ${i % 3})`,
).join('\n');

Given('a compacted conversation whose summary leaves out three warnings spread through a deploy log', async ({ page }) => {
  const threadId = await dbHelper.createThread(DEFAULT_AGENT_ID, {
    title: 'Deploy warnings',
    messages: [
      { role: 'USER', content: 'Read yesterday\'s deploy log of payments-api and tell me if it went fine.' },
      {
        role: 'AGENT',
        content: 'The rollout finished.',
        toolCalls: [{ tool: 'shell_exec', input: '{"command":"cat deploy.log"}', output: WARNING_LOG, rendered: true }],
      },
      { role: 'USER', content: 'Thanks.' },
      { role: 'AGENT', content: 'You are welcome.' },
    ],
  });
  const prisma = dbHelper.getPrisma();
  await prisma.conversationMessage.updateMany({ where: { threadId }, data: { isCompacted: true } });
  await prisma.conversationThread.update({
    where: { id: threadId },
    data: {
      compactionSummary:
        '## Goal\n- Check whether yesterday\'s payments-api deploy went fine.\n\n' +
        '## Current State\n- Done: read the deploy log with shell_exec; the rollout finished.',
      compactedAt: new Date(),
    },
  });
  await new HomePage(page).navigate();
});

Then('the agent read a compacted message in full', async () => {
  const thread = await latestThread();
  const readsInFull = (r: { toolCalls: unknown }) =>
    ((r.toolCalls ?? []) as Array<{ tool?: string; input?: unknown }>).some((call) => {
      if (call.tool !== 'search_conversations') return false;
      const input = typeof call.input === 'string' ? JSON.parse(call.input) : call.input;
      return typeof (input as { position?: unknown })?.position === 'number';
    });
  const rows = await pollUntil(
    () => dbHelper.getPrisma().conversationMessage.findMany({ where: { threadId: thread.id, role: 'AGENT' } }),
    (found) => found.some(readsInFull),
    120_000,
  );
  expect(rows.some(readsInFull)).toBe(true);
});

Then('the agent read the compacted history', async () => {
  const thread = await latestThread();
  const rows = await pollUntil(
    () => dbHelper.getPrisma().conversationMessage.findMany({ where: { threadId: thread.id, role: 'AGENT' } }),
    (found) => found.some((r) => JSON.stringify(r.toolCalls ?? '').includes('search_conversations')),
    120_000,
  );
  expect(rows.some((r) => JSON.stringify(r.toolCalls ?? '').includes('search_conversations'))).toBe(true);
});

Then('every seeded message is still visible in the conversation', async ({ page }) => {
  // Decision: compaction changes only the model's view; the scrollback keeps
  // the full thread, compacted rows included.
  const homePage = new HomePage(page);
  for (let i = 0; i < SEED_COUNT; i++) {
    await expect(homePage.getMessageByText(seededContent(i))).toBeVisible({ timeout: 10_000 });
  }
});
