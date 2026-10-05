/**
 * Activity Page Object — activity view at /activity.
 *
 * Three sections: token totals for the last 24 hours as four cards, every
 * webhook run as an expandable list paged by a button, and every tool call the
 * agent has made as an expandable list that pages on scroll.
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
  /** One row per webhook run; the trigger that expands it. */
  readonly webhookRuns: Locator;
  readonly emptyWebhookRuns: Locator;
  readonly webhookRunMessage: Locator;
  readonly webhookRunToolCalls: Locator;
  readonly webhookRunDetails: Locator;

  constructor(page: Page) {
    super(page);
    this.totalTokens = page.getByTestId('activity-total-tokens');
    this.inputTokens = page.getByTestId('activity-input-tokens');
    this.outputTokens = page.getByTestId('activity-output-tokens');
    this.cacheHitRate = page.getByTestId('activity-cache-hit-rate');
    this.toolCalls = page.getByTestId('activity-tool-call');
    this.emptyToolCalls = page.getByTestId('activity-tool-calls-empty');
    this.webhookRuns = page.getByTestId('activity-webhook-run');
    this.emptyWebhookRuns = page.getByTestId('activity-webhook-runs-empty');
    this.webhookRunMessage = page.getByTestId('activity-webhook-run-message');
    this.webhookRunToolCalls = page.getByTestId('activity-webhook-run-tool-call');
    this.webhookRunDetails = page.getByTestId('activity-webhook-run-details');
  }

  /** The row of the newest run of the webhook `name`. */
  webhookRun(name: string): Locator {
    return this.webhookRuns.filter({ hasText: name }).first();
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
