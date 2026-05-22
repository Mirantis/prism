/**
 * Channels Page Object — /orgs/:orgId/channels.
 *
 * Handles org-level Slack workspace configuration.
 */

import { Page } from '@playwright/test';
import { BasePage } from './base.page';

export class ChannelsPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async navigate() {
    await this.goto('/orgs/test-org-id/channels');
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Configure a Slack workspace by entering the bot token.
   * Assumes the workspace is not yet configured.
   */
  async configureSlack(botToken: string) {
    // Wait for the page to settle into either "Connected" or "Configure Slack" state
    const connected = this.page.getByText('Connected', { exact: true });
    const configureButton = this.page.getByRole('button', { name: 'Configure Slack' });

    const alreadyConfigured = await Promise.race([
      connected.waitFor({ timeout: 10_000 }).then(() => true),
      configureButton.waitFor({ timeout: 10_000 }).then(() => false),
    ]);

    if (alreadyConfigured) {
      return;
    }

    await configureButton.click();
    await this.page.getByPlaceholder('xoxb-').fill(botToken);
    await this.page.getByRole('button', { name: 'Configure' }).click();

    // Wait for the "Connected" badge to appear
    await connected.waitFor({ timeout: 15_000 });
  }

  /**
   * Disconnect the currently connected Slack workspace. Assumes the
   * workspace is connected and the current user is an org admin.
   */
  async disconnectSlack() {
    await this.page.getByRole('button', { name: 'Disconnect' }).click();

    // Confirm in the AlertDialog
    const dialog = this.page.getByRole('alertdialog');
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.getByRole('button', { name: 'Disconnect' }).click();

    // After a successful disconnect, the UI swaps in the "Configure Slack"
    // button (the empty-state card). Wait for it to settle.
    await this.page
      .getByRole('button', { name: 'Configure Slack' })
      .waitFor({ timeout: 15_000 });
  }
}
