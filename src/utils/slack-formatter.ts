/**
 * Slack Message Formatter
 *
 * Uses Slack's native markdown block (released Feb 2025) which accepts
 * standard markdown directly - no conversion needed!
 *
 * Reference: https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
 *
 * Supported: Bold, italic, strikethrough, headers, lists, blockquotes,
 *            inline code, code blocks, links, images (as links)
 * Not supported: Tables, syntax highlighting, horizontal rules
 */

import { splitContent } from './text-chunker';

// Slack Block Kit types
interface MarkdownBlock {
  type: 'markdown';
  text: string;
}

interface SectionBlock {
  type: 'section';
  text: {
    type: 'mrkdwn';
    text: string;
  };
}

interface ContextBlock {
  type: 'context';
  block_id?: string;
  elements: Array<{
    type: 'mrkdwn';
    text: string;
  }>;
}

interface ButtonElement {
  type: 'button';
  action_id: string;
  text: { type: 'plain_text'; text: string; emoji?: boolean };
  value: string;
}

interface ActionsBlock {
  type: 'actions';
  block_id: string;
  elements: ButtonElement[];
}

export type SlackBlock = MarkdownBlock | SectionBlock | ContextBlock | ActionsBlock;

// Individual block text limit
const BLOCK_TEXT_LIMIT = 3000;

// ============================================================================
// Feedback buttons (👍 / 👎 on agent responses)
// ============================================================================

export const FEEDBACK_BLOCK_ID = 'lens_feedback';
export const FEEDBACK_ACK_BLOCK_ID = 'lens_feedback_ack';
export const FEEDBACK_ACTION_UP = 'feedback_thumbs_up';
export const FEEDBACK_ACTION_DOWN = 'feedback_thumbs_down';

export const FEEDBACK_RATING_UP = 'up';
export const FEEDBACK_RATING_DOWN = 'down';
export type FeedbackRating = typeof FEEDBACK_RATING_UP | typeof FEEDBACK_RATING_DOWN;

/**
 * Inline acknowledgement block rendered in place of the feedback buttons after
 * a click. Generic wording on purpose — in channel/team mode the update is
 * visible to everyone, not just the clicker, so we don't claim "you rated this".
 */
export function buildFeedbackAckBlock(): ContextBlock {
  return {
    type: 'context',
    block_id: FEEDBACK_ACK_BLOCK_ID,
    elements: [
      {
        type: 'mrkdwn',
        text: '_✓ Thanks for the feedback!_',
      },
    ],
  };
}

/**
 * Build the actions block containing 👍 / 👎 feedback buttons for an agent message.
 * The button `value` carries the internal message ID so the action handler can
 * correlate the click back to a ConversationMessage.
 */
export function buildFeedbackActionsBlock(messageId: string): ActionsBlock {
  return {
    type: 'actions',
    block_id: FEEDBACK_BLOCK_ID,
    elements: [
      {
        type: 'button',
        action_id: FEEDBACK_ACTION_UP,
        text: { type: 'plain_text', text: '👍 Helpful', emoji: true },
        value: messageId,
      },
      {
        type: 'button',
        action_id: FEEDBACK_ACTION_DOWN,
        text: { type: 'plain_text', text: '👎 Not helpful', emoji: true },
        value: messageId,
      },
    ],
  };
}


/**
 * Convert markdown tables to a simple text format since markdown blocks don't support tables
 */
function convertTablesToText(content: string): string {
  // Match markdown tables
  const tableRegex = /(\|.+\|[\r\n]+\|[-:\s|]+\|[\r\n]+(?:\|.+\|[\r\n]*)+)/g;

  return content.replace(tableRegex, (match) => {
    const lines = match.trim().split('\n');
    if (lines.length < 3) return match;

    // Parse header and rows
    const parseRow = (row: string): string[] => {
      return row
        .split('|')
        .map(cell => cell.trim())
        .filter(cell => cell.length > 0 && !cell.match(/^[-:]+$/));
    };

    const headers = parseRow(lines[0]);
    const rows = lines.slice(2).filter(l => l.trim()).map(parseRow);

    // Convert to bullet list format
    const result: string[] = [];
    for (const row of rows) {
      const items = row.map((cell, i) => {
        const header = headers[i] || `Col${i + 1}`;
        return `**${header}:** ${cell}`;
      });
      result.push(`• ${items.join(' | ')}`);
    }

    return result.join('\n');
  });
}

/**
 * Options for extending the formatted message.
 */
export interface FormatSlackMessageOptions {
  /**
   * When set, append a 👍/👎 feedback actions block keyed by this messageId.
   * The caller is responsible for gating (length / cadence / terminal-only).
   */
  feedbackMessageId?: string;
}

/**
 * Format a message for Slack using native markdown blocks
 */
export function formatSlackMessage(
  content: string,
  triggeredBy?: string,
  toolCalls?: Array<{ tool: string; [key: string]: unknown }>,
  options?: FormatSlackMessageOptions,
): { text: string; blocks: SlackBlock[] } {
  const blocks: SlackBlock[] = [];

  // Add context block for triggered by info. A webhook message is its body alone.
  if (triggeredBy && triggeredBy !== 'USER_INPUT' && triggeredBy !== 'WEBHOOK') {
    const contextText = triggeredBy === 'HEARTBEAT'
      ? '💓 Heartbeat Alert'
      : triggeredBy === 'CRON_TASK'
        ? '⏰ Scheduled Task Result'
        : `📬 ${triggeredBy}`;

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: contextText,
        },
      ],
    });
  }

  // Convert tables to text format (markdown blocks don't support tables)
  const processedContent = convertTablesToText(content);

  // Split into chunks if content is too long
  if (processedContent.length > 0 && processedContent.length <= BLOCK_TEXT_LIMIT) {
    // Single markdown block
    blocks.push({
      type: 'markdown',
      text: processedContent,
    });
  } else if (processedContent.length > BLOCK_TEXT_LIMIT) {
    // Split by paragraphs/sections to stay within limits
    const sections = splitContent(processedContent, BLOCK_TEXT_LIMIT);

    for (const section of sections) {
      if (section.trim()) {
        blocks.push({
          type: 'markdown',
          text: section,
        });
      }
    }
  }

  // Append tool call context block
  if (toolCalls && toolCalls.length > 0) {
    const uniqueTools = [...new Set(toolCalls.map((tc) => tc.tool))];
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🔧 ${uniqueTools.join(', ')}` }],
    });
  }

  // Ensure we have at least one block
  if (blocks.length === 0 || (blocks.length === 1 && blocks[0].type === 'context')) {
    blocks.push({
      type: 'markdown',
      text: content || '(empty message)',
    });
  }

  // Append feedback buttons on the final message of a turn (caller decides when to pass this)
  if (options?.feedbackMessageId) {
    blocks.push(buildFeedbackActionsBlock(options.feedbackMessageId));
  }

  // Slack has a limit of 50 blocks
  if (blocks.length > 50) {
    blocks.length = 49;
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_Message truncated due to length..._',
        },
      ],
    });
  }

  return {
    text: content, // Fallback plain text for notifications
    blocks,
  };
}

/**
 * Format a simple notification message
 */
export function formatNotification(
  title: string,
  message: string,
  type: 'info' | 'warning' | 'error' | 'success' = 'info'
): { text: string; blocks: SlackBlock[] } {
  const emoji = {
    info: 'ℹ️',
    warning: '⚠️',
    error: '🚨',
    success: '✅',
  }[type];

  const blocks: SlackBlock[] = [
    {
      type: 'markdown',
      text: `${emoji} **${title}**\n\n${message}`,
    },
  ];

  return {
    text: `${emoji} ${title}: ${message}`,
    blocks,
  };
}

/**
 * How the system prompt names a Slack channel, `#` included once, with what the agent sees of a
 * thread there and how it mentions someone: the adapter reads the whole thread, and turns a
 * person's token in a reply into a mention.
 */
export function slackChannelLabel(channelName: string): string {
  return (
    `the team Slack channel **#${channelName.replace(/^#/, '')}**, where you see the messages of ` +
    'the thread you reply in, and where you mention someone by writing their token as it ' +
    'appears, so Slack notifies them'
  );
}
