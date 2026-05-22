/**
 * Chat Page Object — chat interface at /orgs/:orgId/teams/:teamId/agents/:id/chat.
 *
 * Selectors are based on:
 *   packages/lens-agents/frontend/src/pages/orgs/[orgId]/teams/[teamId]/agents/[id]/chat.tsx
 *   packages/lens-agents/frontend/src/components/chat/AgentChat.tsx
 *   packages/lens-agents/frontend/src/components/chat/ChatInput.tsx
 *   packages/lens-agents/frontend/src/components/chat/ChatMessage.tsx
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

  async navigate(agentId: string) {
    await this.goto(`/orgs/test-org-id/teams/test-team-id/agents/${agentId}/chat`);
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
}
