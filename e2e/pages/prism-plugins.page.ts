/**
 * Prism Plugins Page Object — a plugin's own page at /plugins/<id>.
 *
 * A plugin page is code the SPA did not bundle: the runtime builds it and the
 * browser imports it at runtime. So the locators here reach into markup the
 * plugin authored, through the components the host handed it.
 */

import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class PrismPluginsPage extends BasePage {
  /** Every item in the left-hand navigation, plugins included. */
  readonly navItems: Locator;
  /** The heading a plugin page renders through `PageHeader`. */
  readonly heading: Locator;
  /** The strip shown while the runtime restarts after a plugin change. */
  readonly restartBanner: Locator;

  constructor(page: Page) {
    super(page);
    this.navItems = page.locator('[data-slot="sidebar"] a');
    this.heading = page.locator('main.overflow-auto h1');
    this.restartBanner = page.getByTestId('plugin-restart-banner');
  }

  async navigate(pluginId: string) {
    await this.goto(`/plugins/${pluginId}`);
    await this.page.waitForLoadState('networkidle');
  }

  /** The nav labels, in the order the sidebar lists them. */
  async navLabels(): Promise<string[]> {
    const texts = await this.navItems.allInnerTexts();
    return texts.map((t) => t.trim()).filter((t) => t.length > 0);
  }

  /** Follow the sidebar entry a plugin contributed. */
  async clickNavItem(label: string) {
    await this.navItems.filter({ hasText: label }).first().click();
    await this.page.waitForLoadState('networkidle');
  }

  /** The plugin page's own content, without the app shell around it. */
  async content(): Promise<string> {
    return this.page.locator('main.overflow-auto').innerText();
  }

  /** One row of the table the fixture plugin renders. */
  cell(text: string): Locator {
    return this.page.locator('main.overflow-auto td', { hasText: text });
  }
}
