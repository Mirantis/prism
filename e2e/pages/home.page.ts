/**
 * Chat Page Object — chat interface at /chat.
 *
 * The SPA reads agent identity from /agents/me, so there's no agentId
 * in the URL. Selectors mirror web/src/components/chat/*.
 */

import { Page, Locator, Download } from '@playwright/test';
import { BasePage } from './base.page';

export class HomePage extends BasePage {
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly stopButton: Locator;
  readonly fileInput: Locator;
  /** "Recents" sidebar section — only present on the Chat page. */
  readonly recentsSection: Locator;
  /** Each conversation row in the Recents list. */
  readonly recentThreads: Locator;

  constructor(page: Page) {
    super(page);
    this.chatInput = page.getByPlaceholder('Message your agent...');
    this.sendButton = page.locator('button[type="submit"]');
    // STOP button shown in place of send while the agent is responding.
    this.stopButton = page.getByTestId('chat-stop-button');
    // Hidden file input behind the paperclip button in ChatInput.
    this.fileInput = page.locator('input[type="file"]');
    this.recentsSection = page.getByTestId('recents');
    this.recentThreads = page.getByTestId('recent-thread');
  }

  /** Visible Recents row labels, in document (top-to-bottom) order. */
  async recentThreadNames(): Promise<string[]> {
    const texts = await this.recentThreads.allInnerTexts();
    return texts.map((t) => t.trim()).filter(Boolean);
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
   * Cancel the in-flight response: wait for the STOP button to replace send
   * (the agent is working), then click it.
   */
  async stopResponse(timeout = 10_000) {
    await this.stopButton.waitFor({ state: 'visible', timeout });
    await this.stopButton.click();
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

  // ---- File sharing ----

  /**
   * Attach a file via the hidden <input type="file"> (setInputFiles works on
   * hidden inputs and mirrors a real drag-drop/picker selection).
   */
  async attachFile(file: { name: string; mimeType: string; content: string }) {
    await this.fileInput.setInputFiles({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.content),
    });
  }

  /** Composer chips (pending/ready uploads above the textarea). */
  composerAttachment(filename: string) {
    return this.page.getByTestId('composer-attachment').filter({ hasText: filename });
  }

  /** Chips rendered on sent/historical messages (clickable download links). */
  messageAttachment(filename: string) {
    return this.page.getByTestId('message-attachment').filter({ hasText: filename });
  }

  /** Attachment chips that live on an agent (non-user) message — i.e. files
   *  the agent shared, not files the user uploaded. */
  agentMessageAttachment(filename: string) {
    return this.getAgentMessages().getByTestId('message-attachment').filter({ hasText: filename });
  }

  async removeComposerAttachment(filename: string) {
    await this.composerAttachment(filename)
      .getByRole('button', { name: /remove/i })
      .click();
  }

  /** Click a message's attachment chip and capture the resulting download. */
  async downloadAttachment(filename: string): Promise<Download> {
    const [download] = await Promise.all([
      this.page.waitForEvent('download'),
      this.messageAttachment(filename).first().click(),
    ]);
    return download;
  }
}
