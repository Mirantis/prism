/**
 * Webhooks Page Object — /webhooks.
 *
 * Covers the receiver switch, the New-subscription
 * modal (including the generic sender-verification fields), and per-row
 * controls (active toggle, edit, delete).
 */

import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export interface NewSubscriptionInput {
  name: string;
  description?: string;
  events?: string;
  prompt?: string;
  /** The Deliver to option's label; omit to keep the default (All channels). */
  deliverTo?: string;
  deliverOnly?: boolean;
  /** Linked Slack channel names to check; needs `deliverTo: 'Slack'`. */
  slackChannels?: string[];
  /** Omit to explicitly select None for unsigned-delivery scenarios. */
  authType?: 'token' | 'hmac';
  authHeader?: string;
  authPrefix?: string;
  authAlgorithm?: 'sha256' | 'sha1' | 'sha512';
  authEncoding?: 'hex' | 'base64';
  authSignedUrl?: string;
  secret?: string;
}

export class WebhooksPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async navigate() {
    await this.goto('/webhooks');
    await this.page.waitForLoadState('networkidle');
  }

  get receiverSwitch(): Locator {
    return this.page.getByRole('switch', { name: 'Webhook receiver', exact: true });
  }

  get newSubscriptionButton(): Locator {
    return this.page.getByRole('button', { name: 'New subscription' });
  }

  /** Enable the receiver and wait for the enabled state to render. */
  async enableReceiver() {
    await this.receiverSwitch.click();
    await this.newSubscriptionButton.waitFor({ timeout: 10_000 });
  }

  /** Open the modal, fill the subscription fields, and submit. */
  async createSubscription(input: NewSubscriptionInput) {
    await this.fillSubscription(input);
    await this.submitSubscription(input.name);
  }

  /** The Deliver only checkbox in the New-subscription modal. */
  get deliverOnlyCheckbox(): Locator {
    return this.page
      .getByRole('dialog')
      .getByRole('checkbox', { name: 'Skip the agent, post the template', exact: true });
  }

  /** Open the modal and fill the subscription fields, leaving it open. */
  async fillSubscription(input: NewSubscriptionInput) {
    await this.newSubscriptionButton.click();
    await this.page.locator('#webhook-name').fill(input.name);
    if (input.description) {
      await this.page.locator('#webhook-description').fill(input.description);
    }
    if (input.events) {
      await this.page.locator('#webhook-events').fill(input.events);
    }
    if (input.deliverTo) {
      await this.page.locator('#webhook-deliver-to').click();
      await this.page.getByRole('option', { name: input.deliverTo, exact: true }).click();
      // The authentication select also has a "None" option; let this list close first.
      await this.page.getByRole('listbox').waitFor({ state: 'hidden' });
    }
    if (input.deliverOnly) {
      await this.deliverOnlyCheckbox.click();
    }
    for (const channel of input.slackChannels ?? []) {
      await this.slackChannelCheckbox(channel).click();
    }
    if (!input.authType) {
      await this.page.locator('#webhook-auth-type').click();
      await this.page.getByRole('option', { name: 'None', exact: true }).click();
    }
    if (input.authType) {
      // Base UI Select: open the trigger, pick the option by its label.
      await this.page.locator('#webhook-auth-type').click();
      await this.page
        .getByRole('option', {
          name:
            input.authType === 'hmac'
              ? 'HMAC signature of the body'
              : 'Shared token in a header',
        })
        .click();
      if (input.authHeader) {
        await this.page.locator('#webhook-auth-header').fill(input.authHeader);
      }
      if (input.authPrefix) {
        await this.page.locator('#webhook-auth-prefix').fill(input.authPrefix);
      }
      if (input.authAlgorithm) {
        await this.page.locator('#webhook-auth-algorithm').click();
        await this.page.getByRole('option', { name: input.authAlgorithm, exact: true }).click();
      }
      if (input.authEncoding) {
        await this.page.locator('#webhook-auth-encoding').click();
        await this.page.getByRole('option', { name: input.authEncoding, exact: true }).click();
      }
      if (input.authSignedUrl) {
        await this.page.locator('#webhook-auth-signed-url').fill(input.authSignedUrl);
      }
      if (input.secret) {
        await this.page.locator('#webhook-secret').fill(input.secret);
      }
    }
    if (input.prompt) {
      await this.page.locator('#webhook-prompt').fill(input.prompt);
    }
  }

  /** Submit the open modal and wait for the new subscription's row. */
  async submitSubscription(name: string) {
    await this.page.getByRole('button', { name: 'Create', exact: true }).click();
    // Row appears once the create + list-invalidate round trip completes.
    await this.subscriptionRow(name).waitFor({ timeout: 10_000 });
  }

  subscriptionRow(name: string): Locator {
    return this.page.getByRole('row').filter({ hasText: name })
      .or(this.page.getByLabel(`Subscription ${name}`, { exact: true }))
      .filter({ visible: true });
  }

  /** A linked Slack channel's checkbox in the open form. */
  slackChannelCheckbox(channelName: string): Locator {
    return this.page.getByRole('dialog').getByRole('checkbox', { name: `#${channelName}`, exact: true });
  }

  /** Open a subscription's Edit dialog from its row or card. */
  async openEdit(name: string) {
    await this.page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  }

  /** Flip a subscription's Active switch. */
  async toggleSubscription(name: string) {
    await this.page.getByRole('switch', { name: `Toggle ${name}` }).click();
  }
}
