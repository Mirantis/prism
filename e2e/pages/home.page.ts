/**
 * Chat Page Object — chat interface at /chat.
 *
 * The SPA reads agent identity from /agents/me, so there's no agentId
 * in the URL. Selectors mirror web/src/components/chat/*.
 */

import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class HomePage extends BasePage {
  readonly chatInput: Locator;
  readonly sendButton: Locator;

  constructor(page: Page) {
    super(page);
    this.chatInput = page.getByPlaceholder('Message your agent...');
    this.sendButton = page.locator('button[type="submit"]');
  }

  async navigate() {
    await this.goto('/chat');
    await this.page.waitForLoadState('networkidle');
  }

  async typeMessage(text: string) {
    await this.chatInput.fill(text);
  }

  async sendMessage() {
    await this.sendButton.click();
  }

  /**
   * Find a message containing specific text anywhere in the chat area.
   */
  getMessageByText(text: string) {
    return this.page.getByText(text, { exact: false });
  }

  /**
   * Get agent response messages.
   * Agent messages render as div.group.flex.gap-3 (left-aligned with avatar).
   * User messages also have .group.flex.gap-3 but include .justify-end.
   */
  getAgentMessages() {
    return this.page.locator('.group.flex.gap-3:not(.justify-end)');
  }

  /**
   * Wait for an agent response to appear after sending a message.
   */
  async waitForAgentResponse(timeout = 60_000) {
    const selector = '.group.flex.gap-3:not(.justify-end)';
    const initialCount = await this.getAgentMessages().count();
    await this.page.waitForFunction(
      ({ sel, prevCount }) => {
        return document.querySelectorAll(sel).length > prevCount;
      },
      { sel: selector, prevCount: initialCount },
      { timeout },
    );
  }

  /**
   * Wait for streaming to finish — the typing indicator disappears when
   * isTyping flips to false at end-of-stream.
   */
  async waitForStreamComplete(timeout = 60_000) {
    await this.page
      .getByTestId('chat-typing-indicator')
      .waitFor({ state: 'detached', timeout });
  }
}
