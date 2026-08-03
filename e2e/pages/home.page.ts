/**
 * Chat Page Object — chat interface at /chat.
 *
 * The SPA reads agent identity from /agents/me, so there's no agentId
 * in the URL. Selectors mirror web/src/components/chat/*.
 */

import { Page, Locator, Download } from '@playwright/test';
import { BasePage } from './base.page';

/**
 * Agent-bubble count at the moment the current turn's message was sent.
 *
 * The reply is "arrived" once the count exceeds this baseline. Anchoring to
 * send time rather than to each call makes the wait idempotent: two
 * consecutive content assertions about the same reply both pass, instead of
 * the second one demanding a *further* bubble. In concise mode (the e2e
 * default — `verbose` defaults to false and db-helper never sets it) the
 * runtime delivers exactly one bubble per turn, so a snapshot-at-call-time
 * wait could only ever time out.
 *
 * Keyed by Page and held in a WeakMap because step definitions construct a
 * fresh `HomePage` per step, so instance state would not survive.
 */
const sendBaseline = new WeakMap<Page, number>();

export class HomePage extends BasePage {
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly stopButton: Locator;
  readonly fileInput: Locator;
  /** "Recents" sidebar section — only present on the Chat page. */
  readonly recentsSection: Locator;
  /** Each conversation row in the Recents list. */
  readonly recentThreads: Locator;
  /** Slash-command suggestion popup shown above the composer when "/" is typed. */
  readonly commandPopup: Locator;
  /** Individual rows in the command popup. */
  readonly commandPopupItems: Locator;

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
    this.commandPopup = page.getByTestId('command-popup');
    this.commandPopupItems = page.getByTestId('command-popup-item');
  }

  /** A command popup row matching the given command name (e.g. "/skills"). */
  commandPopupItem(name: string) {
    return this.commandPopupItems.filter({ hasText: name });
  }

  /** Press a key while the composer is focused (e.g. Tab to autocomplete). */
  async pressKeyInInput(key: string) {
    await this.chatInput.focus();
    await this.page.keyboard.press(key);
  }

  /** Current value of the composer textarea. */
  inputValue() {
    return this.chatInput.inputValue();
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
    // Wait for the composer to be sendable *before* snapshotting. ChatInput
    // swaps submit for STOP while a turn is in flight, so click() would
    // auto-wait — and a count taken ahead of that wait would predate the
    // previous turn's reply, letting waitForAgentResponse() return on that
    // stale bubble.
    await this.sendButton.waitFor({ state: 'visible' });
    // Snapshot the bubble count *before* the click so waitForAgentResponse()
    // can tell "this turn's reply landed" from "a further bubble arrived".
    sendBaseline.set(this.page, await this.getAgentMessages().count());
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
   * Find a message containing specific text inside the conversation list.
   *
   * Scoped to the message list (data-testid="chat-messages") rather than the
   * whole page: the Recents sidebar shows each thread's title, and a short
   * first message ("hello") is titled verbatim, so an unscoped getByText would
   * also match the sidebar row and trip Playwright's strict-mode check.
   */
  getMessageByText(text: string) {
    return this.page.getByTestId('chat-messages').getByText(text, { exact: false });
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
   * Wait for the current turn's agent response to appear.
   *
   * Idempotent: it waits for the bubble count to exceed the baseline taken in
   * `sendMessage()`, so calling it again after the reply has landed returns
   * immediately rather than waiting for another bubble. That is what lets a
   * scenario assert several things about one reply — concise mode delivers a
   * single bubble per turn, so a "count must increase from now" wait would
   * hang for the full timeout on the second assertion.
   *
   * With no recorded baseline (a turn not started via `sendMessage()`, e.g.
   * an autonomous message) it falls back to "at least one agent bubble".
   *
   * The baseline is a bubble *count*, so `navigate()` and `page.reload()`
   * invalidate it — both change the count out from under it, after which this
   * wait can return immediately. Assert a reply before reloading, never after.
   */
  async waitForAgentResponse(timeout = 60_000) {
    const selector = '.group.flex.gap-3:not(.justify-end)';
    const baseline = sendBaseline.get(this.page) ?? 0;
    await this.page.waitForFunction(
      ({ sel, prevCount }) => {
        return document.querySelectorAll(sel).length > prevCount;
      },
      { sel: selector, prevCount: baseline },
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

  /** Attach a binary file (zip, image, etc.) via the hidden file input. */
  async attachFileBuffer(file: { name: string; mimeType: string; buffer: Buffer }) {
    await this.fileInput.setInputFiles({
      name: file.name,
      mimeType: file.mimeType,
      buffer: file.buffer,
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
