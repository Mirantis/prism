/**
 * Tests for the Teams message formatter.
 */

import { describe, it, expect } from 'vitest';
import {
  formatTeamsMessage,
  buildFeedbackCard,
  buildFeedbackAckCard,
  ADAPTIVE_CARD_CONTENT_TYPE,
  FEEDBACK_ACTION_UP,
  FEEDBACK_ACTION_DOWN,
  TEAMS_TEXT_LIMIT,
} from './teams-formatter';

describe('formatTeamsMessage', () => {
  it('returns a single markdown chunk for short content', () => {
    const { chunks } = formatTeamsMessage('Hello **world**');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Hello **world**');
    expect(chunks[0].textFormat).toBe('markdown');
    expect(chunks[0].attachments).toBeUndefined();
  });

  it('prefixes a heartbeat label for HEARTBEAT-triggered messages', () => {
    const { chunks } = formatTeamsMessage('Disk almost full', 'HEARTBEAT');
    expect(chunks[0].text).toContain('💓 **Heartbeat Alert**');
    expect(chunks[0].text).toContain('Disk almost full');
  });

  it('prefixes a scheduled-task label for CRON_TASK-triggered messages', () => {
    const { chunks } = formatTeamsMessage('Backup done', 'CRON_TASK');
    expect(chunks[0].text).toContain('⏰ **Scheduled Task Result**');
  });

  it('does not prefix anything for USER_INPUT messages', () => {
    const { chunks } = formatTeamsMessage('Just a reply', 'USER_INPUT');
    expect(chunks[0].text).toBe('Just a reply');
  });

  it('appends a tool footer listing unique tools', () => {
    const { chunks } = formatTeamsMessage('Done', undefined, [
      { tool: 'kubectl' },
      { tool: 'kubectl' },
      { tool: 'github' },
    ]);
    expect(chunks[0].text).toContain('🔧 _kubectl, github_');
  });

  it('converts markdown tables to bullet text', () => {
    const table = '| Name | Status |\n| --- | --- |\n| api | up |\n| db | down |';
    const { chunks } = formatTeamsMessage(table);
    expect(chunks[0].text).not.toContain('| --- |');
    expect(chunks[0].text).toContain('**Name:** api');
    expect(chunks[0].text).toContain('**Status:** down');
  });

  it('splits content longer than the Teams limit into multiple chunks', () => {
    const para = 'word '.repeat(2000).trim(); // ~10k chars
    const content = [para, para, para, para].join('\n\n'); // ~40k chars
    const { chunks } = formatTeamsMessage(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(TEAMS_TEXT_LIMIT);
    }
  });

  it('keeps every chunk within the limit even for unbroken strings with no delimiters', () => {
    const content = 'x'.repeat(TEAMS_TEXT_LIMIT * 2 + 5);
    const { chunks } = formatTeamsMessage(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(TEAMS_TEXT_LIMIT);
    }
    // No content lost in the split
    expect(chunks.map((c) => c.text).join('')).toBe(content);
  });

  it('attaches the feedback card to the last chunk only', () => {
    const para = 'word '.repeat(2000).trim();
    const content = [para, para, para, para].join('\n\n');
    const { chunks } = formatTeamsMessage(content, undefined, undefined, {
      feedbackMessageId: 'msg-42',
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.attachments).toBeUndefined();
    }
    const last = chunks[chunks.length - 1];
    expect(last.attachments).toHaveLength(1);
    expect(last.attachments![0].contentType).toBe(ADAPTIVE_CARD_CONTENT_TYPE);
  });

  it('falls back to a placeholder for empty content', () => {
    const { chunks } = formatTeamsMessage('');
    expect(chunks[0].text).toBe('(empty message)');
  });
});

describe('buildFeedbackCard', () => {
  it('carries the message id in both submit actions', () => {
    const card = buildFeedbackCard('msg-7');
    const content = card.content as { actions: Array<{ type: string; data: { action: string; messageId: string } }> };
    expect(content.actions).toHaveLength(2);
    expect(content.actions[0].data).toEqual({ action: FEEDBACK_ACTION_UP, messageId: 'msg-7' });
    expect(content.actions[1].data).toEqual({ action: FEEDBACK_ACTION_DOWN, messageId: 'msg-7' });
    expect(content.actions.every((a) => a.type === 'Action.Submit')).toBe(true);
  });
});

describe('buildFeedbackAckCard', () => {
  it('renders a generic thanks message with no actions', () => {
    const card = buildFeedbackAckCard();
    const content = card.content as { body: Array<{ text: string }>; actions?: unknown[] };
    expect(content.body[0].text).toContain('Thanks for the feedback');
    expect(content.actions).toBeUndefined();
  });
});
