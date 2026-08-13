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
  /** "New conversation" pen icon button next to the Recents label. */
  readonly newThreadButton: Locator;
  /**
   * The "agent is working" indicator in the message list. Driven by the same
   * `isTyping` state as the STOP button (AgentChat passes it as both `isTyping`
   * and `isPending`), so it is the one signal for "a turn is in flight".
   */
  readonly typingIndicator: Locator;
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
    this.typingIndicator = page.getByTestId('chat-typing-indicator');
    // Hidden file input behind the paperclip button in ChatInput.
    this.fileInput = page.locator('input[type="file"]');
    this.recentsSection = page.getByTestId('recents');
    this.recentThreads = page.getByTestId('recent-thread');
    this.newThreadButton = page.getByTestId('new-thread');
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

  /**
   * Send the staged message and confirm the send actually went out.
   *
   * The indicator is set optimistically inside the send — `use-websocket.ts`
   * flips `isTyping` right after `ws.send()`, before any runtime frame — so it
   * is in the DOM by the time the click resolves. What this wait therefore
   * proves is that the socket *accepted* the message, and its one real failure
   * mode is the one that matters here: when the socket is not OPEN,
   * `sendMessage()` logs to the console and returns without flipping `isTyping`,
   * so nothing is sent and nothing says so.
   *
   * Without it, that lost send surfaces further down as an empty conversation or
   * a missing thread row — an assertion failure pointing at the feature rather
   * than at the dropped message. It also makes `waitForStreamComplete()`'s
   * `detached` wait sound: that wait is only meaningful once the indicator is
   * known to have appeared.
   *
   * Cheap by construction (the state is already set locally when the click
   * returns), so the budget only has to cover a slow render.
   *
   * Note it proves *a* turn is in flight, not specifically this one: send twice
   * without waiting and the gateway queues the second behind the first, whose
   * indicator is already up.
   *
   * Exception: a slash command. `AgentChat.handleSend` matches the staged text
   * against its command registry and, on a hit, returns before the WebSocket
   * send — the command runs over REST instead. Nothing ever sets `isTyping`, so
   * anchoring on it would hang until the timeout on every `/compact`,
   * `/goal …` and `/skills …`. Those steps assert on what the command itself
   * renders. Text that only *looks* like a command (no registry hit) is sent
   * over the socket like any message; skipping the check for it loses the
   * guarantee and nothing else, and no scenario sends one.
   */
  async sendMessage(turnStartTimeout = 30_000) {
    const staged = (await this.chatInput.inputValue()).trim();
    await this.sendButton.click();
    if (staged.startsWith('/')) return;
    await this.typingIndicator.waitFor({ state: 'visible', timeout: turnStartTimeout });
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
   *
   * This is the second half of the condition; `sendMessage()` waits for the
   * indicator to appear, without which a `detached` wait is satisfied by a DOM
   * that never had one — a send the socket dropped, say. (It follows that this
   * is only meaningful for a message send: after a slash command there is no
   * turn to wait for, and no step calls it there.) Callers that reach here after `waitForAgentResponse()`
   * may find the turn already finished, which is a correct pass — the turn is
   * known to have started, so the absence means over rather than never began.
   */
  async waitForStreamComplete(timeout = 60_000) {
    await this.typingIndicator.waitFor({ state: 'detached', timeout });
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
