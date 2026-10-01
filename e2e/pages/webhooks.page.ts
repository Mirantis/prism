/**
 * Webhooks Page Object — /webhooks.
 *
 * Covers the receiver switch, the New-subscription
 * modal (including the generic sender-verification fields), and per-row
 * controls (active toggle, delete).
 */

import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export interface NewSubscriptionInput {
  name: string;
  description?: string;
  events?: string;
  prompt?: string;
  deliverOnly?: boolean;
  /** Omit to explicitly select None for unsigned-delivery scenarios. */
  authType?: 'token' | 'hmac';
  authHeader?: string;
  authPrefix?: string;
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
    await this.newSubscriptionButton.click();
    await this.page.locator('#webhook-name').fill(input.name);
    if (input.description) {
      await this.page.locator('#webhook-description').fill(input.description);
    }
    if (input.events) {
      await this.page.locator('#webhook-events').fill(input.events);
    }
    if (input.deliverOnly) {
      // Base UI's Checkbox puts the id on a hidden input; click the visible
      // role=checkbox element (scoped to the dialog) instead.
      await this.page
        .locator('[data-slot="dialog-content"] [data-slot="checkbox"]')
        .click();
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
      if (input.secret) {
        await this.page.locator('#webhook-secret').fill(input.secret);
      }
    }
    if (input.prompt) {
      await this.page.locator('#webhook-prompt').fill(input.prompt);
    }
    await this.page.getByRole('button', { name: 'Create', exact: true }).click();
    // Row appears once the create + list-invalidate round trip completes.
    await this.subscriptionRow(input.name).waitFor({ timeout: 10_000 });
  }

  subscriptionRow(name: string): Locator {
    return this.page.getByRole('row').filter({ hasText: name })
      .or(this.page.getByLabel(`Subscription ${name}`, { exact: true }))
      .filter({ visible: true });
  }

  /** Flip a subscription's Active switch. */
  async toggleSubscription(name: string) {
    await this.page.getByRole('switch', { name: `Toggle ${name}` }).click();
  }
}
