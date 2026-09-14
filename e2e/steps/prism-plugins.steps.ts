/**
 * Prism plugin step definitions.
 *
 * A plugin page is the one place the SPA runs code it did not bundle, so these
 * steps walk the real page in the browser rather than asserting on the catalog
 * endpoint alone: that a page renders through Prism's own components, against
 * its own backend, is the claim worth proving.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { getPrisma } from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { PrismPluginsPage } from '../pages/prism-plugins.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { When, Then } = createBdd();

/** The fixture plugins seeded into the runtime's data dir by the config. */
const COSTS = 'costs';
const BROKEN = 'broken';

interface ToolCallRecord {
  tool: string;
  input: string;
  output: string;
}

async function agentToolCalls(): Promise<ToolCallRecord[]> {
  const rows = await getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
    select: { toolCalls: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.flatMap((row) =>
    Array.isArray(row.toolCalls) ? (row.toolCalls as unknown as ToolCallRecord[]) : [],
  );
}

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

When('I navigate to the overview page', async ({ page }) => {
  await new HomePage(page).navigate();
});

When('I navigate to the costs plugin page', async ({ page }) => {
  await new PrismPluginsPage(page).navigate(COSTS);
});

When('I navigate to the broken plugin page', async ({ page }) => {
  await new PrismPluginsPage(page).navigate(BROKEN);
});

When('I follow the costs plugin in the navigation', async ({ page }) => {
  await new PrismPluginsPage(page).clickNavItem(COSTS);
});

When('I ask the agent for the cost summary', async ({ page }) => {
  const home = new HomePage(page);
  await home.navigate();
  await home.typeMessage(
    'Call the costs plugin cost_summary tool and report the total it returns. Use the tool, do not guess.',
  );
  await home.sendMessage();
  await home.waitForStreamComplete(180_000);
});

// ---------------------------------------------------------------------------
// Then — navigation
// ---------------------------------------------------------------------------

Then('the navigation lists the costs plugin', async ({ page }) => {
  const labels = await new PrismPluginsPage(page).navLabels();
  expect(labels).toContain(COSTS);
});

Then('the costs plugin is listed as an ordinary page, not inside a group', async ({ page }) => {
  const plugins = new PrismPluginsPage(page);
  const labels = await plugins.navLabels();
  // One menu holds the built-in pages and the plugins alike, so the plugin
  // follows Activity in the same list rather than under a heading of its own.
  expect(labels.indexOf(COSTS)).toBeGreaterThan(labels.indexOf('Activity'));
  await expect(page.locator('[data-slot="sidebar-group-label"]', { hasText: /^Plugins$/ })).toHaveCount(0);
});

Then('the navigation still lists the broken plugin', async ({ page }) => {
  const labels = await new PrismPluginsPage(page).navLabels();
  expect(labels).toContain(BROKEN);
});

Then('the costs plugin page is shown', async ({ page }) => {
  await expect(page).toHaveURL(new RegExp(`/plugins/${COSTS}$`));
});

Then('the breadcrumb names the costs plugin', async ({ page }) => {
  await expect(page.locator('nav[aria-label="breadcrumb"]')).toContainText(COSTS);
});

// ---------------------------------------------------------------------------
// Then — the page itself
// ---------------------------------------------------------------------------

Then('the page heading reads Costs', async ({ page }) => {
  await expect(new PrismPluginsPage(page).heading).toHaveText('Costs');
});

Then("the page shows the total from the plugin's own endpoint", async ({ page }) => {
  // 128 is the sum the fixture's own handler returns, so seeing it on screen
  // proves the page called its backend rather than rendering a constant.
  await expect(page.locator('main.overflow-auto')).toContainText('Total 128 USD');
});

Then('the page shows a row for each service the endpoint returned', async ({ page }) => {
  const plugins = new PrismPluginsPage(page);
  await expect(plugins.cell('compute')).toBeVisible();
  await expect(plugins.cell('storage')).toBeVisible();
  const content = await plugins.content();
  expect(content).toContain('96');
  expect(content).toContain('32');
});

Then('the page reports a build problem', async ({ page }) => {
  const content = await new PrismPluginsPage(page).content();
  expect(content).toContain('problem');
  // The message names the file, which is what an author needs to fix it.
  expect(content).toContain('page.tsx');
});

// ---------------------------------------------------------------------------
// Then — the plugin's own HTTP surface
// ---------------------------------------------------------------------------

Then("the plugin's summary endpoint answers", async ({ page }) => {
  const res = await page.request.get(`/agents/prism-plugins/${COSTS}/api/summary`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ total: 128 });
});

Then("the plugin's data directory is its own", async ({ page }) => {
  const res = await page.request.get(`/agents/prism-plugins/${COSTS}/api/where`);
  const body = (await res.json()) as { dataDir: string };
  // A sibling of the plugin rather than a child, so deleting and re-dropping
  // the plugin folder is a clean reinstall.
  expect(body.dataDir).toContain(`prism-plugin-data/${COSTS}`);
});

Then('a route the plugin does not declare answers not found', async ({ page }) => {
  const res = await page.request.get(`/agents/prism-plugins/${COSTS}/api/undeclared`);
  expect(res.status()).toBe(404);
});

Then('a file the plugin ships is served', async ({ page }) => {
  const res = await page.request.get(`/agents/prism-plugins/${COSTS}/asset/note.txt`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('PLUGIN_ASSET_OK');
});

// ---------------------------------------------------------------------------
// Then — the tool
// ---------------------------------------------------------------------------

Then("the agent calls the plugin's tool", async () => {
  const calls = await agentToolCalls();
  // Namespaced by plugin id, so two plugins may both declare `cost_summary`.
  const used = calls.filter((call) => call.tool === `${COSTS}__cost_summary`);
  expect(used.length).toBeGreaterThan(0);
});
