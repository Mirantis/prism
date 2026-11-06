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
    renderMessage(userMessage({ triggeredBy: 'AGENT_MESSAGE', senderId: 'messaging', senderName: 'Messaging', agentMessageKind: 'notice' }), ADA);
    expect(screen.getByTestId('message-sender').textContent).toBe('Messaging');
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

  it('shows a coding agent sign-in request as its card, in place of the link in its text', () => {
    renderMessage(
      userMessage({
        role: 'AGENT',
        content:
          'Sign in to Claude to run Claude Code on your own plan. Enter the sign-in code only where this link opens, never in chat.\n\n[Sign in to Claude](https://agent.example.com/coding-agents?agent=claude-code)',
        blocks: [
          {
            type: 'coding_agent_sign_in',
            id: '3b241101-e2bb-4255-8caf-4136c566a962',
            agent: 'claude-code',
            status: 'waiting',
          },
        ],
      }),
      ADA,
    );

    expect(screen.getByLabelText('Coding agent sign-in').textContent).toContain(
      'Run Claude Code on your own Claude plan',
    );
    expect(screen.queryByRole('link', { name: 'Sign in to Claude' })).toBeNull();
  });
});

describe('ChatMessage images in the text', () => {
  afterEach(cleanup);

  const CHART = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
  const DATA = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
  const chart = { id: CHART, filename: 'euribor.png', mediaType: 'image/png', sizeBytes: 109_600, category: 'image' as const };
  const data = { id: DATA, filename: 'euribor.csv', mediaType: 'text/csv', sizeBytes: 900, category: 'text' as const };

  function agentReply(content: string, attachments: TranscriptMessage['attachments']) {
    return userMessage({ role: 'AGENT', senderId: null, senderName: null, content, attachments });
  }

  it('shows an inline image between the text around it, and only the other files as chips', () => {
    const reply = agentReply(`Rates fell.\n\n![Euribor, past year](attachment:${CHART})\n\nThey bottomed in May.`, [
      { ...chart, inline: true },
      data,
    ]);
    const { container } = renderMessage(reply, ADA);

    const image = screen.getByTestId('inline-image');
    expect(image.getAttribute('src')).toBe(`/agents/attachments/${CHART}`);
    expect(image.getAttribute('alt')).toBe('Euribor, past year');
    const paragraphs = [...container.querySelectorAll('p')].map((p) => p.textContent);
    expect(paragraphs).toEqual(['Rates fell.', '', 'They bottomed in May.']);
    expect(screen.getAllByTestId('message-attachment').map((chip) => chip.textContent)).toEqual([
      expect.stringContaining('euribor.csv'),
    ]);
  });

  it('keeps an image the text does not place as a chip', () => {
    renderMessage(agentReply('Here is the chart.', [chart]), ADA);
    expect(screen.queryByTestId('inline-image')).toBeNull();
    expect(screen.getByTestId('message-attachment').textContent).toContain('euribor.png');
  });

  it('loads no image from another host, and links it instead', () => {
    renderMessage(agentReply('![tracker](https://example.com/pixel.png?d=secret)', null), ADA);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'tracker' }).getAttribute('href')).toBe('https://example.com/pixel.png?d=secret');
  });

  it('shows the description of a reference that names no image of the message', () => {
    renderMessage(agentReply(`![lost chart](attachment:${DATA})`, [data]), ADA);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('lost chart')).toBeTruthy();
  });

  it('marks an inline image whose content expired', () => {
    renderMessage(agentReply(`![chart](attachment:${CHART})`, [{ ...chart, inline: true, expired: true }]), ADA);
    expect(screen.queryByTestId('inline-image')).toBeNull();
    expect(screen.getByTestId('inline-image-expired').textContent).toBe('chart · expired');
  });
});
