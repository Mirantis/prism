/**
 * Channels Page Object — /channels.
 *
 * The SPA reads the Slack workspace from env (SLACK_BOT_TOKEN,
 * validated via auth.test on runtime boot), so there is no in-UI
 * "Configure Slack" flow. This page object just waits for the
 * configured branch to render and exposes the "Get Channel Link Code"
 * affordance used by the slack-channel e2e flow.
 */

import { Page } from '@playwright/test';
import { BasePage } from './base.page';

export class ChannelsPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async navigate() {
    await this.goto('/channels');
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Wait for the configured-Slack branch of /channels to render. The
   * workspace is set up automatically from env; this is just a
   * readiness check (the `botToken` arg is ignored, kept for call-site
   * compatibility with the @slack Before hook).
   */
  async configureSlack(_botToken: string) {
    // The "Slack" h3 only renders in the configured branch of /channels;
    // the empty-state card shows "No Slack workspace configured" instead.
    await this.page
      .getByRole('heading', { name: 'Slack', level: 3 })
      .waitFor({ timeout: 15_000 });
  }

  /**
   * Click "Get Channel Link Code" and return the 6-char hex code from
   * the .font-mono.text-2xl block that appears.
   */
  async getChannelLinkCode(): Promise<string> {
    await this.page.getByRole('button', { name: 'Get Channel Link Code' }).click();
    const codeEl = this.page.locator('.font-mono.text-2xl');
    await codeEl.waitFor({ timeout: 10_000 });
    const code = await codeEl.textContent();
    if (!code) throw new Error('Channel link code not found');
    return code.trim();
  }
}
