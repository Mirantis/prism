// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TranscriptMessage } from '@/lib/chat-socket/transcript';
import type { Viewer } from '@/lib/chat-socket/protocol';
import ChatMessage from './ChatMessage';

const ADA: Viewer = { id: 'ada@example.com', name: 'ada@example.com' };
const GRACE: Viewer = { id: 'grace@example.com', name: 'grace@example.com' };

function userMessage(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: '58aa0353-ebdb-421b-ad49-75f443341eb7',
    threadId: '9db4a6ef-9160-4784-bcda-c2e649edf269',
    role: 'USER',
    content: 'Reply with exactly: pong',
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    isCompacted: false,
    createdAt: '2026-09-27T08:38:51.086Z',
    attachments: null,
    senderId: 'ada@example.com',
    senderName: 'ada@example.com',
    ...overrides,
  };
}

function renderMessage(message: TranscriptMessage, viewer: Viewer | undefined) {
  const onRetry = vi.fn();
  const onEdit = vi.fn();
  const { container } = render(
    <ChatMessage
      message={message}
      agentName="Prism"
      viewer={viewer}
      onOpenComputerHelp={vi.fn()}
      onRetry={onRetry}
      onEdit={onEdit}
    />,
  );
  return { onRetry, onEdit, container };
}

describe('ChatMessage', () => {
  afterEach(cleanup);

  it("puts somebody else's message on the participants' side, under their name", () => {
    const { container } = renderMessage(userMessage(), GRACE);
    expect(screen.getByTestId('message-sender').textContent).toBe('ada@example.com');
    expect(container.querySelector('[data-message-role="participant"]')).not.toBeNull();
    expect(container.querySelector('.justify-end')).toBeNull();
  });

  it("puts another agent's message on the participants' side as that agent's, even before the runtime says who you are", () => {
    const fromAgent = userMessage({ triggeredBy: 'AGENT_MESSAGE', senderId: 'agent-r', senderName: 'Researcher' });
    const { container } = renderMessage(fromAgent, undefined);
    expect(screen.getByTestId('message-sender').textContent).toBe('Researcher · Agent');
    expect(container.querySelector('[data-message-role="participant"]')).not.toBeNull();
  });

  it('names a notice by its sender alone', () => {
    renderMessage(userMessage({ triggeredBy: 'AGENT_MESSAGE', senderId: 'irene-agent', senderName: 'Irene Agent' }), ADA);
    expect(screen.getByTestId('message-sender').textContent).toBe('Irene Agent');
  });

  it('draws every message as your own until the runtime says who you are', () => {
    const { container } = renderMessage(userMessage(), undefined);
    expect(screen.queryByTestId('message-sender')).toBeNull();
    expect(container.querySelector('[data-message-role="user"]')).not.toBeNull();
  });

  it('shows your own message on its own side, without a name', () => {
    const { container } = renderMessage(userMessage(), ADA);
    expect(screen.queryByTestId('message-sender')).toBeNull();
    expect(container.querySelector('[data-message-role="user"]')?.className).toContain('justify-end');
  });

  it('offers Retry and Edit on a message that was not stored', () => {
    const { onRetry, onEdit } = renderMessage(
      userMessage({ delivery: 'failed', deliveryError: 'This conversation no longer exists.' }),
      ADA,
    );

    expect(screen.getByTestId('message-failed').textContent).toContain('This conversation no longer exists.');
    fireEvent.click(screen.getByTestId('message-retry'));
    fireEvent.click(screen.getByTestId('message-edit'));
    expect(onRetry).toHaveBeenCalledWith('58aa0353-ebdb-421b-ad49-75f443341eb7');
    expect(onEdit).toHaveBeenCalledWith('58aa0353-ebdb-421b-ad49-75f443341eb7');
  });
});
