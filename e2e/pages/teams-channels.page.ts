/**
 * Teams section of the Channels Page Object — /channels.
 *
 * The SPA reads the Teams connection from env (TEAMS_APP_ID +
 * TEAMS_APP_PASSWORD + TEAMS_APP_TENANT_ID on the runtime), so there is no
 * in-UI "Configure Teams" flow — this object waits for the configured branch
 * and drives the link-code affordances inside the Microsoft Teams section.
 */

import { Locator, Page } from '@playwright/test';
import { BasePage } from './base.page';

export class TeamsChannelsPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async navigate() {
    await this.goto('/channels');
    await this.page.waitForLoadState('networkidle');
  }

  /** The Microsoft Teams section — scopes every locator below. */
  private section(): Locator {
    return this.page
      .locator('div.space-y-4')
      .filter({ has: this.page.getByRole('heading', { name: 'Microsoft Teams', level: 3 }) });
  }

  /** Wait for the configured-Teams branch of /channels to render. */
  async waitForConfigured() {
    await this.page
      .getByRole('heading', { name: 'Microsoft Teams', level: 3 })
      .waitFor({ timeout: 15_000 });
  }

  /** Click "Link Account" (Personal Mode) and return the 6-char hex code. */
  async getDmLinkCode(): Promise<string> {
    await this.section().getByRole('button', { name: 'Link Account' }).click();
    return this.readCode();
  }

  /** Click "Add channel" (Team Mode) and return the 6-char hex code. */
  async getChannelLinkCode(): Promise<string> {
    await this.section().getByRole('button', { name: 'Add channel' }).click();
    return this.readCode();
  }

  private async readCode(): Promise<string> {
    const codeEl = this.section().locator('.font-mono.text-2xl');
    await codeEl.waitFor({ timeout: 10_000 });
    const code = await codeEl.textContent();
    if (!code) throw new Error('Teams link code not found');
    return code.trim();
  }
}
