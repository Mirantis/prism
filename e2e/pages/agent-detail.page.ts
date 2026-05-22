/**
 * Agent Detail Page Object — /orgs/:orgId/teams/:teamId/agents/:id.
 *
 * Selectors are based on packages/lens-agents/frontend/src/pages/orgs/[orgId]/teams/[teamId]/agents/[id]/index.tsx.
 * The page uses shadcn/ui Cards, Tabs, Table, and AlertDialog components.
 */

import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class AgentDetailPage extends BasePage {
  /** The "Add" button inside the subagents card header */
  readonly addSubagentButton: Locator;

  constructor(page: Page) {
    super(page);
    this.addSubagentButton = page.getByRole('button', { name: 'Add', exact: true });
  }

  async navigate(agentId: string) {
    await this.goto(`/orgs/test-org-id/teams/test-team-id/agents/${agentId}`);
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Open the three-dot actions menu for a specific subagent row.
   * The TableActionsMenu renders a DropdownMenuTrigger with sr-only "Actions" text.
   */
  async openSubagentActionsMenu(name: string) {
    const row = this.page.locator('tr').filter({ hasText: name });
    await row.getByRole('button', { name: 'Actions' }).click();
  }

  /**
   * Click "Get Channel Link Code" and return the 6-char hex verification code.
   */
  async getChannelLinkCode(): Promise<string> {
    await this.page.getByRole('button', { name: 'Get Channel Link Code' }).click();
    // Wait for the code to appear — it's in a .font-mono div
    const codeEl = this.page.locator('.font-mono.text-2xl');
    await codeEl.waitFor({ timeout: 10_000 });
    const code = await codeEl.textContent();
    if (!code) throw new Error('Channel link code not found');
    return code.trim();
  }
}
