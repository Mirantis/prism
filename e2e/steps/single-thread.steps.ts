/**
 * Single-thread mode step definitions — an agent with one conversation, which
 * every page opens and every request for a new one returns.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';

const { Given, When, Then } = createBdd();

/** The root routes a third-party client calls; the SPA's dev server proxies only `/agents`. */
const RUNTIME = process.env.AGENT_RUNTIME_URL;

/** The thread the runtime answered a request for a new conversation with. */
let answered: string | undefined;

/**
 * Gated here rather than by a `grep` in the config, because the suite's own scripts
 * pass `--grep-invert` on the command line and a CLI filter replaces the config's
 * outright. The runtime reads its thread mode at boot, so this feature is its own
 * invocation —
 *   THREAD_MODE=single npm run test:e2e:single-thread --workspace=prism-agent-e2e
 */
Given('the agent keeps one conversation', async ({ page }) => {
  test.skip(process.env.THREAD_MODE !== 'single', 'Needs a runtime started with THREAD_MODE=single.');
  const me = await page.request.get('/agents/me');
  expect(((await me.json()) as { threadMode?: string }).threadMode).toBe('single');
});

Then('the sidebar offers no new chat and no Recents list', async ({ page }) => {
  const home = new HomePage(page);
  await expect(home.sidebarNewChatButton).toHaveCount(0);
  await expect(home.recentsSection).toHaveCount(0);
});

Then('the command palette offers no new chat and no conversations', async ({ page }) => {
  const palette = page.getByTestId('command-menu');
  await expect(palette.getByText('Toggle sidebar')).toBeVisible();
  await expect(palette.getByText('New chat', { exact: true })).toHaveCount(0);
  await expect(palette.getByText('Conversations', { exact: true })).toHaveCount(0);
});

Then('the overview lists no conversations', async ({ page }) => {
  await expect(page.getByTestId('setup-checklist')).toBeVisible();
  await expect(page.getByText('Recent conversations')).toHaveCount(0);
});

When('a client asks the runtime for a new conversation', async ({ page }) => {
  const res = await page.request.post(`${RUNTIME}/threads`, { data: { workspaceRoot: '/work/elsewhere' } });
  expect(res.ok()).toBe(true);
  answered = ((await res.json()) as { threadId: string }).threadId;
});

Then('the runtime answers with the conversation holding {string}', async ({ page }, text: string) => {
  const res = await page.request.get(`${RUNTIME}/messages?threadId=${answered}`);
  expect(res.ok()).toBe(true);
  const history = (await res.json()) as Array<{ content: string }>;
  expect(history.map((m) => m.content)).toContain(text);
});

Then('the runtime lists that conversation alone', async ({ page }) => {
  const res = await page.request.get(`${RUNTIME}/threads`);
  expect(res.ok()).toBe(true);
  expect(((await res.json()) as Array<{ id: string }>).map((t) => t.id)).toEqual([answered]);
});

Then('the database holds {int} conversation thread(s)', async ({}, count: number) => {
  const stored = await dbHelper.getPrisma().conversationThread.count({ where: { externalThreadId: null } });
  expect(stored).toBe(count);
});
