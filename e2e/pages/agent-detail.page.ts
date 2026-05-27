/**
 * Agent Detail Page Object — the /profile route.
 *
 * The legacy "agent detail page" concept maps onto /profile; step
 * phrases like "I navigate to the agent detail page" still resolve
 * here. Selectors mirror web/src/routes/profile.tsx.
 */

import { Page } from '@playwright/test';
import { BasePage } from './base.page';

export class AgentDetailPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async navigate() {
    await this.goto('/profile');
    await this.page.waitForLoadState('networkidle');
  }
}
