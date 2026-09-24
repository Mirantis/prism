/**
 * Activity Page Object — activity view at /activity.
 *
 * Two sections: token totals for the last 24 hours as four cards, and every
 * tool call the agent has made as an expandable list that pages on scroll.
 */

import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class ActivityPage extends BasePage {
  readonly totalTokens: Locator;
  readonly inputTokens: Locator;
  readonly outputTokens: Locator;
  readonly cacheHitRate: Locator;
  /** One row per tool call; the trigger that expands it. */
  readonly toolCalls: Locator;
  readonly emptyToolCalls: Locator;

  constructor(page: Page) {
    super(page);
    this.totalTokens = page.getByTestId('activity-total-tokens');
    this.inputTokens = page.getByTestId('activity-input-tokens');
    this.outputTokens = page.getByTestId('activity-output-tokens');
    this.cacheHitRate = page.getByTestId('activity-cache-hit-rate');
    this.toolCalls = page.getByTestId('activity-tool-call');
    this.emptyToolCalls = page.getByTestId('activity-tool-calls-empty');
  }

  async navigate() {
    await this.goto('/activity');
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Scroll to the bottom repeatedly so the list's sentinel comes into view and
   * each further page loads. The content pane (`#main-content`) is what scrolls,
   * inside a shell that fills the viewport.
   */
  async scrollToLoadMore(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await this.page.locator('#main-content').evaluate((pane) => {
        pane.scrollTo(0, pane.scrollHeight);
      });
      await this.page.waitForTimeout(700);
    }
  }
}
