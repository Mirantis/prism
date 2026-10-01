/**
 * Webhook Step Definitions (web)
 *
 * Drives the Webhooks page (receiver banner, subscription modal, row
 * toggles) and asserts on authoritative state: the receiver flag and
 * subscription list via the management API, and delivered messages via the
 * `conversation_messages` table (triggeredBy = WEBHOOK) — the agent run is
 * asynchronous, so on-screen text alone would race it.
 *
 * Sender verification is exercised end-to-end by signing the exact bytes the
 * POST sends, so a mismatch between what the runtime hashes and what the sender
 * signed would fail here.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import crypto from 'crypto';
import type { Page } from '@playwright/test';
import { WebhooksPage } from '../pages/webhooks.page';
import { WEBHOOK_PORT } from '../support/webhook-port';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { When, Then } = createBdd();

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

Then('the webhook receiver banner is visible', async ({ page }) => {
  await expect(page.getByText('Webhook receiver disabled')).toBeVisible();
  await expect(new WebhooksPage(page).enableButton).toBeVisible();
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

When('I disable the webhook receiver via the API', async ({ page }) => {
  const res = await page.request.patch('/agents/webhooks/receiver', {
    data: { enabled: false },
  });
  expect(res.ok()).toBe(true);
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
      card.getByRole('button', { name: `Authentication for ${name}` }),
      card.getByRole('button', { name: `Delete ${name}` }),
      card.getByRole('switch', { name: `Toggle ${name}` }),
    ]) {
      await expect(control).toBeInViewport();
    }
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  },
);

When('I open authentication for webhook {string} on a short screen', async ({ page }, name: string) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.getByRole('button', { name: `Authentication for ${name}`, exact: true }).click();
});

Then('the webhook authentication form and its actions fit the viewport', async ({ page }) => {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const box = await dialog.boundingBox();
    return box && box.y >= 0 && box.y + box.height <= page.viewportSize()!.height;
  }).toBe(true);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  await expect(page.locator('#webhook-secret')).toHaveValue('');
  await page.locator('#webhook-auth-header').fill('');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.locator('#webhook-auth-header').fill('X-Hub-Signature-256');
});

When('I save webhook authentication with an empty secret using Enter', async ({ page }) => {
  await page.locator('#webhook-auth-header').press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();
});

When('I replace the webhook secret with {string} using Enter', async ({ page }, secret: string) => {
  await page.locator('#webhook-secret').fill(secret);
  await page.locator('#webhook-secret').press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();
});
