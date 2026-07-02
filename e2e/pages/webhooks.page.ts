/**
 * Webhooks Page Object — /webhooks.
 *
 * Covers the receiver banner ("Enable Webhooks"), the New-subscription
 * modal, and per-row controls (active toggle, delete).
 */

import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export interface NewSubscriptionInput {
  name: string;
  description?: string;
  events?: string;
  prompt?: string;
  deliverOnly?: boolean;
}

export class WebhooksPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async navigate() {
    await this.goto('/webhooks');
    await this.page.waitForLoadState('networkidle');
  }

  get enableButton(): Locator {
    return this.page.getByTestId('enable-webhooks');
  }

  get newSubscriptionButton(): Locator {
    return this.page.getByRole('button', { name: 'New subscription' });
  }

  /** Click "Enable Webhooks" and wait for the enabled state to render. */
  async enableReceiver() {
    await this.enableButton.click();
    await this.newSubscriptionButton.waitFor({ timeout: 10_000 });
  }

  /** Open the modal, fill the hermes-style fields, and submit. */
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
    if (input.prompt) {
      await this.page.locator('#webhook-prompt').fill(input.prompt);
    }
    await this.page.getByRole('button', { name: 'Create', exact: true }).click();
    // Row appears once the create + list-invalidate round trip completes.
    await this.subscriptionRow(input.name).waitFor({ timeout: 10_000 });
  }

  subscriptionRow(name: string): Locator {
    return this.page.getByRole('row').filter({ hasText: name });
  }

  /** Flip a subscription's Active switch. */
  async toggleSubscription(name: string) {
    await this.page.getByRole('switch', { name: `Toggle ${name}` }).click();
  }
}
