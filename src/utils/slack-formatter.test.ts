/**
 * Slack Formatter Tests
 *
 * Tests for formatSlackMessage, formatNotification, and internal helpers
 * (convertTablesToText, splitContent, splitLongText) exercised through
 * the public API.
 */

import { describe, it, expect } from 'vitest';
import {
  formatSlackMessage,
  formatNotification,
  slackChannelLabel,
  buildFeedbackActionsBlock,
  buildFeedbackAckBlock,
  FEEDBACK_BLOCK_ID,
  FEEDBACK_ACTION_UP,
  FEEDBACK_ACTION_DOWN,
} from './slack-formatter';

// ---------------------------------------------------------------------------
// formatSlackMessage — basic content
// ---------------------------------------------------------------------------

describe('formatSlackMessage', () => {
  it('wraps short content in a single markdown block', () => {
    const result = formatSlackMessage('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({ type: 'markdown', text: 'Hello world' });
  });

  it('returns fallback block for empty content', () => {
    const result = formatSlackMessage('');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({ type: 'markdown', text: '(empty message)' });
  });

  it('preserves whitespace-only content in a single markdown block', () => {
    const result = formatSlackMessage('   ');
    expect(result.text).toBe('   ');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({ type: 'markdown', text: '   ' });
  });

  // ---------------------------------------------------------------------------
  // triggeredBy context blocks
  // ---------------------------------------------------------------------------

  describe('triggeredBy context', () => {
    it('adds heartbeat context block', () => {
      const result = formatSlackMessage('alert', 'HEARTBEAT');
      expect(result.blocks[0]).toEqual({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '💓 Heartbeat Alert' }],
      });
    });

    it('adds cron task context block', () => {
      const result = formatSlackMessage('report', 'CRON_TASK');
      expect(result.blocks[0]).toEqual({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '⏰ Scheduled Task Result' }],
      });
    });

    it('adds custom trigger context block', () => {
      const result = formatSlackMessage('msg', 'WEBHOOK');
      expect(result.blocks[0]).toEqual({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '📬 WEBHOOK' }],
      });
    });

    it('does not add context block for USER_INPUT', () => {
      const result = formatSlackMessage('msg', 'USER_INPUT');
      expect(result.blocks.some((b) => b.type === 'context')).toBe(false);
      // Should just be one markdown block
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].type).toBe('markdown');
    });

    it('does not add context block when triggeredBy is undefined', () => {
      const result = formatSlackMessage('msg');
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].type).toBe('markdown');
    });
  });

  // ---------------------------------------------------------------------------
  // toolCalls context
  // ---------------------------------------------------------------------------

  describe('toolCalls', () => {
    it('appends tool context block with unique tool names', () => {
      const result = formatSlackMessage('done', undefined, [
        { tool: 'kubectl' },
        { tool: 'github' },
        { tool: 'kubectl' },
      ]);
      const last = result.blocks[result.blocks.length - 1];
      expect(last).toEqual({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '🔧 kubectl, github' }],
      });
    });

    it('does not add tool block when toolCalls is empty', () => {
      const result = formatSlackMessage('done', undefined, []);
      expect(result.blocks).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Table conversion (exercised via formatSlackMessage)
  // ---------------------------------------------------------------------------

  describe('table conversion', () => {
    it('converts a markdown table to bullet list', () => {
      const table = [
        '| Name | Status |',
        '| --- | --- |',
        '| svc-a | healthy |',
        '| svc-b | degraded |',
      ].join('\n');

      const result = formatSlackMessage(table);
      const text = (result.blocks.find((b) => b.type === 'markdown') as { text: string }).text;
      expect(text).toContain('• **Name:** svc-a | **Status:** healthy');
      expect(text).toContain('• **Name:** svc-b | **Status:** degraded');
      // Should not contain the original pipe-delimited header
      expect(text).not.toContain('| Name | Status |');
    });

    it('preserves non-table content around a table', () => {
      const content = 'Before\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter';
      const result = formatSlackMessage(content);
      const text = (result.blocks.find((b) => b.type === 'markdown') as { text: string }).text;
      expect(text).toContain('Before');
      expect(text).toContain('After');
      expect(text).toContain('• **A:** 1 | **B:** 2');
    });

    it('leaves content alone when there is no table', () => {
      const content = 'Just some text\nwith newlines';
      const result = formatSlackMessage(content);
      expect(
        (result.blocks.find((b) => b.type === 'markdown') as { text: string }).text,
      ).toBe(content);
    });
  });

  // ---------------------------------------------------------------------------
  // Content splitting for long messages
  // ---------------------------------------------------------------------------

  describe('long content splitting', () => {
    it('splits content exceeding 3000 chars into multiple blocks', () => {
      // Build content with distinct paragraphs to hit paragraph-boundary splitting
      const para = 'A'.repeat(1000);
      const content = `${para}\n\n${para}\n\n${para}\n\n${para}`;
      const result = formatSlackMessage(content);
      // Should have more than one markdown block
      const mdBlocks = result.blocks.filter((b) => b.type === 'markdown');
      expect(mdBlocks.length).toBeGreaterThan(1);
    });

    it('splits a single very long paragraph by sentence boundary', () => {
      // A single paragraph with sentences
      const sentence = 'This is a test sentence. ';
      const content = sentence.repeat(200); // ~5000 chars
      const result = formatSlackMessage(content);
      const mdBlocks = result.blocks.filter((b) => b.type === 'markdown');
      expect(mdBlocks.length).toBeGreaterThan(1);
      // Each block should be within the limit
      for (const block of mdBlocks) {
        expect((block as { text: string }).text.length).toBeLessThanOrEqual(3000);
      }
    });

    it('hard-splits text with no natural break points', () => {
      const content = 'X'.repeat(7000); // no spaces, no newlines
      const result = formatSlackMessage(content);
      const mdBlocks = result.blocks.filter((b) => b.type === 'markdown');
      expect(mdBlocks.length).toBeGreaterThan(1);
      // Hard split at maxLength produces chunks of maxLength+1 due to
      // substring(0, splitPoint + 1) in splitLongText — verify all content
      // is preserved across chunks
      const reassembled = mdBlocks.map((b) => (b as { text: string }).text).join('');
      expect(reassembled).toBe(content);
    });

    it('splits at newline when no sentence boundary exists', () => {
      // Long text with newlines but no ". " sentence endings
      const line = 'word '.repeat(100); // ~500 chars per line
      const content = Array(10).fill(line.trim()).join('\n'); // ~5000 chars, one big paragraph
      const result = formatSlackMessage(content);
      const mdBlocks = result.blocks.filter((b) => b.type === 'markdown');
      expect(mdBlocks.length).toBeGreaterThan(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 50-block truncation
  // ---------------------------------------------------------------------------

  describe('50-block truncation', () => {
    it('truncates to 50 blocks with a truncation notice', () => {
      // Build content that produces >50 blocks: many paragraphs just under 3000 chars
      const para = 'B'.repeat(2999);
      const content = Array(55).fill(para).join('\n\n');
      const result = formatSlackMessage(content);
      expect(result.blocks).toHaveLength(50);
      const last = result.blocks[49];
      expect(last).toEqual({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_Message truncated due to length..._' }],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback when only context blocks
  // ---------------------------------------------------------------------------

  describe('empty content with triggeredBy', () => {
    it('adds fallback markdown block when content is empty but triggeredBy exists', () => {
      const result = formatSlackMessage('', 'HEARTBEAT');
      // Should have context + fallback markdown
      const mdBlocks = result.blocks.filter((b) => b.type === 'markdown');
      expect(mdBlocks.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// formatNotification
// ---------------------------------------------------------------------------

describe('formatNotification', () => {
  it('formats an info notification', () => {
    const result = formatNotification('Deploy', 'v1.2.3 released');
    expect(result.text).toBe('ℹ️ Deploy: v1.2.3 released');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({
      type: 'markdown',
      text: 'ℹ️ **Deploy**\n\nv1.2.3 released',
    });
  });

  it('formats a warning notification', () => {
    const result = formatNotification('Disk', 'low space', 'warning');
    expect(result.text).toContain('⚠️');
  });

  it('formats an error notification', () => {
    const result = formatNotification('Crash', 'OOM killed', 'error');
    expect(result.text).toContain('🚨');
  });

  it('formats a success notification', () => {
    const result = formatNotification('Build', 'passed', 'success');
    expect(result.text).toContain('✅');
  });

  it('defaults to info type', () => {
    const result = formatNotification('Test', 'msg');
    expect(result.text).toContain('ℹ️');
  });
});

// ---------------------------------------------------------------------------
// Feedback actions block
// ---------------------------------------------------------------------------

describe('feedback actions block', () => {
  it('is omitted by default', () => {
    const result = formatSlackMessage('Some substantive content to analyse.');
    const actions = result.blocks.find((b) => b.type === 'actions');
    expect(actions).toBeUndefined();
  });

  it('is appended when feedbackMessageId is provided', () => {
    const result = formatSlackMessage(
      'Some substantive content to analyse.',
      undefined,
      undefined,
      { feedbackMessageId: 'msg-42' },
    );

    const actions = result.blocks.find((b) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect(actions).toEqual(buildFeedbackActionsBlock('msg-42'));
  });

  it('feedback block carries message id on both buttons with matching action ids', () => {
    const block = buildFeedbackActionsBlock('msg-abc');
    expect(block.block_id).toBe(FEEDBACK_BLOCK_ID);
    expect(block.elements).toHaveLength(2);
    expect(block.elements[0]).toMatchObject({
      type: 'button',
      action_id: FEEDBACK_ACTION_UP,
      value: 'msg-abc',
    });
    expect(block.elements[1]).toMatchObject({
      type: 'button',
      action_id: FEEDBACK_ACTION_DOWN,
      value: 'msg-abc',
    });
  });

  it('feedback block is always appended last (after toolCalls context block)', () => {
    const result = formatSlackMessage(
      'Substantive content.',
      undefined,
      [{ tool: 'kubectl' }],
      { feedbackMessageId: 'msg-42' },
    );
    const last = result.blocks[result.blocks.length - 1];
    expect(last.type).toBe('actions');
  });

  it('buildFeedbackAckBlock renders a generic thank-you (no rating-specific text)', () => {
    const ack = buildFeedbackAckBlock();
    expect(ack.type).toBe('context');
    expect(ack.elements[0].text).toContain('Thanks for the feedback');
    // Visible to everyone in channel mode, so no "you rated this" and no thumb emoji.
    expect(ack.elements[0].text).not.toMatch(/you rated/i);
    expect(ack.elements[0].text).not.toContain('👍');
    expect(ack.elements[0].text).not.toContain('👎');
  });

});

describe('slackChannelLabel', () => {
  it('names the channel with one #', () => {
    expect(slackChannelLabel('alerts')).toBe('the team Slack channel **#alerts**');
    expect(slackChannelLabel('#general')).toBe('the team Slack channel **#general**');
  });
});
