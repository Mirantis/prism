/**
 * Profile Page Object — profile view at /profile.
 *
 * Renders agent identity (name + model), the workspace markdown
 * tabs, and the heartbeat status card.
 */

import { Page } from '@playwright/test';
import { BasePage } from './base.page';

export class ProfilePage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async navigate() {
    await this.goto('/profile');
    await this.page.waitForLoadState('networkidle');
  }
}
