/**
 * Webhook Step Definitions (web)
 *
 * Drives the Webhooks page (receiver switch, subscription modal, row
 * toggles) and asserts on authoritative state: the receiver flag and
 * subscription list via the management API, and delivered messages via the
 * `conversation_messages` table (triggeredBy = WEBHOOK) — the agent run is
 * asynchronous, so on-screen text alone would race it. A message that must not
 * arrive is checked once the run's model calls are in `llm_calls`.
 *
 * Sender verification is exercised end-to-end by signing the exact bytes the
 * POST sends, so a mismatch between what the runtime hashes and what the sender
 * signed would fail here.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import crypto from 'crypto';
import net from 'node:net';
import type { Page } from '@playwright/test';
import { WebhooksPage } from '../pages/webhooks.page';
import { WEBHOOK_PORT } from '../support/webhook-port';
import * as dbHelper from '../support/db-helper';
import { TEST_USER } from '../fixtures/test-data';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

let lastWebhookStatus: number | null = null;

/**
 * POST a webhook body as an exact byte string to the webhook listener.
 * Signature verification hashes what arrives on the wire, so the payload must be
 * sent verbatim (not handed to Playwright as an object it would re-serialize).
 */
async function postWebhookBody(
  page: Page,
  name: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const res = await page.request.post(`http://localhost:${WEBHOOK_PORT}/agents/webhooks/${name}`, {
    headers: { 'content-type': 'application/json', ...headers },
    data: body,
  });
  return res.status();
}

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

When('I navigate to the webhooks page', async ({ page }) => {
  const webhooksPage = new WebhooksPage(page);
  await webhooksPage.navigate();
});

Then('the webhook receiver switch is off', async ({ page }) => {
  await expect(new WebhooksPage(page).receiverSwitch).not.toBeChecked();
});

When('I enable the webhook receiver', async ({ page }) => {
  await new WebhooksPage(page).enableReceiver();
});

Then('the stored webhook receiver state is enabled', async ({ page }) => {
  const res = await page.request.get('/agents/webhooks/receiver');
  expect(res.ok()).toBe(true);
  // The suite's runtime names only its web port to the ingress, so the
  // webhook port has no public origin.
  expect(await res.json()).toEqual({ enabled: true, port: WEBHOOK_PORT, publicUrl: null });
});

When(
  'I create a deliver-only webhook subscription named {string} with prompt {string}',
  async ({ page }, name: string, prompt: string) => {
    await new WebhooksPage(page).createSubscription({ name, prompt, deliverOnly: true });
  },
);

When(
  'I create a webhook subscription named {string} with prompt {string}',
  async ({ page }, name: string, prompt: string) => {
    await new WebhooksPage(page).createSubscription({ name, prompt });
  },
);

When(
  'I fill in a webhook subscription named {string} delivered to {string} with prompt {string}',
  async ({ page }, name: string, deliverTo: string, prompt: string) => {
    await new WebhooksPage(page).fillSubscription({ name, prompt, deliverTo });
  },
);

Then('the deliver-only option is unavailable', async ({ page }) => {
  await expect(new WebhooksPage(page).deliverOnlyCheckbox).toBeDisabled();
});

When('I submit the webhook subscription {string}', async ({ page }, name: string) => {
  await new WebhooksPage(page).submitSubscription(name);
});

Then('the subscription {string} appears in the subscriptions list', async ({ page }, name: string) => {
  await expect(new WebhooksPage(page).subscriptionRow(name)).toBeVisible();
});

Then('the stored webhook subscriptions include {string}', async ({ page }, name: string) => {
  const res = await page.request.get('/agents/webhook-subscriptions');
  expect(res.ok()).toBe(true);
  const subscriptions = (await res.json()) as Array<{ name: string }>;
  expect(subscriptions.map((s) => s.name)).toContain(name);
});

When('I disable the subscription {string}', async ({ page }, name: string) => {
  await new WebhooksPage(page).toggleSubscription(name);
  // Wait for the PATCH + list refetch to settle before firing the POST.
  await pollUntil(
    async () => {
      const res = await page.request.get('/agents/webhook-subscriptions');
      const subs = (await res.json()) as Array<{ name: string; isActive: boolean }>;
      return subs.find((s) => s.name === name)?.isActive;
    },
    (active) => active === false,
    10_000,
    250,
  );
});

When('I disable the webhook receiver', async ({ page }) => {
  await new WebhooksPage(page).receiverSwitch.click();
  await expect(new WebhooksPage(page).receiverSwitch).not.toBeChecked();
  await expect(new WebhooksPage(page).receiverSwitch).toBeEnabled();
});

async function webhookPortState(): Promise<'listening' | 'closed'> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(WEBHOOK_PORT, '127.0.0.1');
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('Webhook port probe timed out'));
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve('listening');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve('closed');
      else reject(error);
    });
  });
}

Then('the webhook port is closed', async () => {
  await expect.poll(webhookPortState).toBe('closed');
});

Then('the webhook port is listening', async () => {
  await expect.poll(webhookPortState).toBe('listening');
});

When(
  'I POST the payload {string} to webhook {string}',
  async ({ page }, payload: string, name: string) => {
    lastWebhookStatus = await postWebhookBody(page, name, payload);
  },
);

When(
  'I create a deliver-only webhook subscription named {string} verified by HMAC header {string} prefix {string} with secret {string} and prompt {string}',
  async (
    { page },
    name: string,
    authHeader: string,
    authPrefix: string,
    secret: string,
    prompt: string,
  ) => {
    await new WebhooksPage(page).createSubscription({
      name,
      prompt,
      deliverOnly: true,
      authType: 'hmac',
      authHeader,
      authPrefix,
      secret,
    });
  },
);

When(
  'I create a deliver-only webhook subscription named {string} verified by token header {string} prefix {string} with secret {string} and prompt {string}',
  async (
    { page },
    name: string,
    authHeader: string,
    authPrefix: string,
    secret: string,
    prompt: string,
  ) => {
    await new WebhooksPage(page).createSubscription({
      name,
      prompt,
      deliverOnly: true,
      authType: 'token',
      authHeader,
      authPrefix,
      secret,
    });
  },
);

Then(
  'the stored webhook subscription {string} has a secret set and never returns it',
  async ({ page }, name: string) => {
    const res = await page.request.get('/agents/webhook-subscriptions');
    expect(res.ok()).toBe(true);
    const subscriptions = (await res.json()) as Array<Record<string, unknown>>;
    const subscription = subscriptions.find((s) => s.name === name);
    expect(subscription).toBeTruthy();
    expect(subscription?.hasSecret).toBe(true);
    expect(subscription).not.toHaveProperty('secret');
    // Belt and braces: the secret must not surface under any key.
    expect(JSON.stringify(subscription)).not.toContain('s3cret');
  },
);

When(
  'I POST the payload {string} to webhook {string} signed with secret {string}',
  async ({ page }, payload: string, name: string, secret: string) => {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(Buffer.from(payload, 'utf8'))
      .digest('hex');
    lastWebhookStatus = await postWebhookBody(page, name, payload, {
      'X-Hub-Signature-256': `sha256=${signature}`,
    });
  },
);

When(
  'I POST the payload {string} to webhook {string} with header {string} set to {string}',
  async ({ page }, payload: string, name: string, header: string, value: string) => {
    lastWebhookStatus = await postWebhookBody(page, name, payload, { [header]: value });
  },
);

When(
  'I create a deliver-only webhook subscription named {string} verified by a sha1 base64 HMAC in header {string} that signs the URL {string}, with secret {string} and prompt {string}',
  async ({ page }, name: string, authHeader: string, authSignedUrl: string, secret: string, prompt: string) => {
    await new WebhooksPage(page).createSubscription({
      name,
      prompt,
      deliverOnly: true,
      authType: 'hmac',
      authHeader,
      authAlgorithm: 'sha1',
      authEncoding: 'base64',
      authSignedUrl,
      secret,
    });
  },
);

/** A base64 HMAC-SHA1 over exactly the bytes given, computed independently of the runtime. */
function sha1Base64(content: string, secret: string): string {
  return crypto.createHmac('sha1', secret).update(Buffer.from(content, 'utf8')).digest('base64');
}

When(
  'I POST the payload {string} to webhook {string} with header {string} set to a sha1 base64 HMAC of the body alone using secret {string}',
  async ({ page }, payload: string, name: string, header: string, secret: string) => {
    lastWebhookStatus = await postWebhookBody(page, name, payload, { [header]: sha1Base64(payload, secret) });
  },
);

When(
  'I POST the payload {string} to webhook {string} with header {string} set to a sha1 base64 HMAC of the body followed by {string} using secret {string}',
  async ({ page }, payload: string, name: string, header: string, url: string, secret: string) => {
    lastWebhookStatus = await postWebhookBody(page, name, payload, {
      [header]: sha1Base64(payload + url, secret),
    });
  },
);

Then('a HEAD request to webhook {string} answers {int}', async ({ page }, name: string, status: number) => {
  const res = await page.request.head(`http://localhost:${WEBHOOK_PORT}/agents/webhooks/${name}`);
  expect(res.status()).toBe(status);
});

Then('the webhook response status is {int}', async ({}, status: number) => {
  expect(lastWebhookStatus).toBe(status);
});

Then(
  'a webhook-triggered message containing {string} is stored in the conversation',
  async ({}, text: string) => {
    const agentId = getCurrentAgentId();
    const messages = await pollUntil(
      () =>
        dbHelper.getPrisma().conversationMessage.findMany({
          where: { triggeredBy: 'WEBHOOK', thread: { agentId } },
        }),
      (rows) => rows.some((m) => m.content.includes(text)),
      120_000,
    );
    expect(messages.some((m) => m.content.includes(text))).toBe(true);
  },
);

Then(
  'no webhook-triggered message containing {string} is stored in the conversation',
  async ({}, text: string) => {
    const agentId = getCurrentAgentId();
    // Rejected deliveries never reach delivery, and deliver-only publishing is
    // synchronous with the response — a short grace period is enough to catch a
    // leak without waiting on something that should never arrive.
    const messages = await pollUntil(
      () =>
        dbHelper.getPrisma().conversationMessage.findMany({
          where: { triggeredBy: 'WEBHOOK', thread: { agentId } },
        }),
      (rows) => rows.some((m) => m.content.includes(text)),
      3_000,
      500,
    );
    expect(messages.some((m) => m.content.includes(text))).toBe(false);
  },
);

/** The newest `llm_calls` row for this purpose, or null before the call is recorded. */
async function latestLlmCall(purpose: string): Promise<{ createdAt: Date } | null> {
  return dbHelper.getPrisma().llmCall.findFirst({
    where: { agentId: getCurrentAgentId(), purpose },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
}

Then('the agent has run for the webhook', async () => {
  const run = await pollUntil(() => latestLlmCall('webhook'), (row) => row !== null, 120_000);
  expect(run).not.toBeNull();
});

Then('the delivery gate has decided on the webhook reply', async () => {
  // The gate runs after the agent's call, so its row is the newer one.
  const decided = await pollUntil(
    async () => {
      const [run, gate] = await Promise.all([latestLlmCall('webhook'), latestLlmCall('delivery-gate')]);
      return Boolean(run && gate && gate.createdAt >= run.createdAt);
    },
    (done) => done,
    120_000,
  );
  expect(decided).toBe(true);
});

Then('no webhook-triggered message is stored in the conversation', async () => {
  const agentId = getCurrentAgentId();
  // Called once the run's last model call is recorded: a delivery follows that
  // call within milliseconds, so a short grace period catches one.
  const messages = await pollUntil(
    () =>
      dbHelper.getPrisma().conversationMessage.findMany({
        where: { triggeredBy: 'WEBHOOK', thread: { agentId } },
      }),
    (rows) => rows.length > 0,
    3_000,
    500,
  );
  expect(messages.map((m) => m.content)).toEqual([]);
});

When('I use a narrow webhook viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

Then(
  'the subscription {string} shows authentication and controls without horizontal scrolling',
  async ({ page }, name: string) => {
    const card = page.getByLabel(`Subscription ${name}`, { exact: true });
    await expect(card.getByText('HMAC signature', { exact: true })).toBeVisible();
    for (const control of [
      card.getByRole('button', { name: 'Copy endpoint URL' }),
      card.getByRole('button', { name: `Edit ${name}` }),
      card.getByRole('button', { name: `Delete ${name}` }),
      card.getByRole('switch', { name: `Toggle ${name}` }),
    ]) {
      await expect(control).toBeInViewport();
    }
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  },
);

When('I edit webhook {string} on a short screen', async ({ page }, name: string) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await new WebhooksPage(page).openEdit(name);
});

Then('the webhook edit form and its actions fit the viewport', async ({ page }) => {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const box = await dialog.boundingBox();
    return box && box.y >= 0 && box.y + box.height <= page.viewportSize()!.height;
  }).toBe(true);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  await expect(page.locator('#webhook-secret')).toHaveValue('');
});

When('I clear and restore the webhook authentication header', async ({ page }) => {
  await page.locator('#webhook-auth-header').fill('');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.locator('#webhook-auth-header').fill('X-Hub-Signature-256');
});

When('I save the webhook edit with an empty secret using Enter', async ({ page }) => {
  await page.locator('#webhook-auth-header').press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();
});

When('I replace the webhook secret with {string} using Enter', async ({ page }, secret: string) => {
  await page.locator('#webhook-secret').fill(secret);
  await page.locator('#webhook-secret').press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();
});

When('I open a new webhook subscription named {string}', async ({ page }, name: string) => {
  await new WebhooksPage(page).newSubscriptionButton.click();
  await page.locator('#webhook-name').fill(name);
  await page.locator('[data-slot="dialog-content"] [data-slot="checkbox"]').click();
});

Then('the webhook form requires shared-token credentials', async ({ page }) => {
  await expect(page.locator('#webhook-auth-type')).toHaveText('Shared token in a header');
  await expect(page.locator('#webhook-auth-header')).toBeVisible();
  await expect(page.locator('#webhook-secret')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
});

When('I create the webhook with header {string} and secret {string} using Enter', async ({ page }, header: string, secret: string) => {
  await page.locator('#webhook-auth-header').fill(header);
  await page.locator('#webhook-secret').fill(secret);
  await page.locator('#webhook-secret').press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();
});

When('I edit webhook {string}', async ({ page }, name: string) => {
  await new WebhooksPage(page).openEdit(name);
});

Then('the webhook edit form shows the prompt {string}', async ({ page }, prompt: string) => {
  await expect(page.getByRole('dialog')).toContainText('Edit ');
  await expect(page.locator('#webhook-name')).toHaveCount(0);
  await expect(page.locator('#webhook-prompt')).toHaveValue(prompt);
});

When(
  'I change the webhook prompt to {string} and the events to {string} and save',
  async ({ page }, prompt: string, events: string) => {
    await page.locator('#webhook-prompt').fill(prompt);
    await page.locator('#webhook-events').fill(events);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  },
);

Then(
  'the stored webhook subscription {string} has the prompt {string} and the events {string}',
  async ({ page }, name: string, prompt: string, events: string) => {
    const res = await page.request.get('/agents/webhook-subscriptions');
    expect(res.ok()).toBe(true);
    const subscriptions = (await res.json()) as Array<{ name: string; prompt: string; events: string }>;
    const subscription = subscriptions.find((s) => s.name === name);
    expect({ prompt: subscription?.prompt, events: subscription?.events }).toEqual({ prompt, events });
  },
);

/** The Slack id a seeded channel is stored under, derived from its name. */
function seededChannelId(name: string): string {
  return `C${name.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
}

Given(
  'the agent has the linked Slack channels {string} and {string}',
  async ({}, first: string, second: string) => {
    for (const name of [first, second]) {
      await dbHelper.getPrisma().slackMapping.create({
        data: {
          connectionId: 'T0E2EWORKSPACE',
          agentId: getCurrentAgentId(),
          lensUserId: TEST_USER.id,
          slackChannelId: seededChannelId(name),
          slackChannelName: name,
        },
      });
    }
  },
);

When(
  'I create a deliver-only webhook subscription named {string} that posts to the Slack channel {string}',
  async ({ page }, name: string, channel: string) => {
    await new WebhooksPage(page).createSubscription({
      name,
      prompt: 'Release {version} is out',
      deliverTo: 'Slack',
      deliverOnly: true,
      slackChannels: [channel],
    });
  },
);

Then(
  'the stored webhook subscription {string} posts to the Slack channels {string}',
  async ({ page }, name: string, channels: string) => {
    const expected = channels.split(',').map((channel) => seededChannelId(channel.trim()));
    await expect
      .poll(async () => {
        const res = await page.request.get('/agents/webhook-subscriptions');
        const subscriptions = (await res.json()) as Array<{
          name: string;
          deliverTo: string;
          slackChannelIds: string[];
        }>;
        const subscription = subscriptions.find((s) => s.name === name);
        return { deliverTo: subscription?.deliverTo, slackChannelIds: subscription?.slackChannelIds };
      })
      .toEqual({ deliverTo: 'slack', slackChannelIds: expected });
  },
);

Then(
  'the subscription {string} lists the Slack channels {string}',
  async ({ page }, name: string, channels: string) => {
    await expect(new WebhooksPage(page).subscriptionRow(name)).toContainText(channels);
  },
);

When('I check the Slack channel {string} and save', async ({ page }, channel: string) => {
  const webhooksPage = new WebhooksPage(page);
  await webhooksPage.slackChannelCheckbox(channel).click();
  await expect(webhooksPage.slackChannelCheckbox(channel)).toBeChecked();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});
