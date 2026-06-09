/**
 * Teams Message Formatter
 *
 * Bot Framework messages with `textFormat: 'markdown'` accept standard
 * markdown (bold, italic, lists, links, code blocks). Tables are NOT
 * rendered in Teams bot messages, so they are converted to bullet text —
 * same approach as the Slack formatter.
 *
 * Feedback (👍/👎) is rendered as an Adaptive Card attachment with
 * Action.Submit buttons — the Teams analogue of Slack's Block Kit actions
 * block. Clicks arrive as message activities with `activity.value` set and
 * no text.
 */

// Bot Framework attachment shape (kept structural to avoid importing the
// botbuilder types into a pure-formatting module).
export interface TeamsAttachment {
  contentType: string;
  content: unknown;
}

export interface FormattedTeamsMessage {
  text: string;
  textFormat: 'markdown';
  attachments?: TeamsAttachment[];
}

// Teams caps a message payload around 28 KB; keep a margin for entities,
// attachments, and JSON overhead. Content longer than this is split into
// multiple messages by the adapter.
export const TEAMS_TEXT_LIMIT = 24000;

export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

// ============================================================================
// Feedback buttons (👍 / 👎 on agent responses)
// ============================================================================

export const FEEDBACK_ACTION_UP = 'feedback_thumbs_up';
export const FEEDBACK_ACTION_DOWN = 'feedback_thumbs_down';

export const FEEDBACK_RATING_UP = 'up';
export const FEEDBACK_RATING_DOWN = 'down';
export type FeedbackRating = typeof FEEDBACK_RATING_UP | typeof FEEDBACK_RATING_DOWN;

/** Shape of `activity.value` posted by the feedback card's Action.Submit. */
export interface TeamsFeedbackSubmitValue {
  action: typeof FEEDBACK_ACTION_UP | typeof FEEDBACK_ACTION_DOWN;
  messageId: string;
}

/**
 * Adaptive Card with 👍/👎 Action.Submit buttons. The submit `data` carries
 * the internal message ID so the activity handler can correlate the click
 * back to a ConversationMessage — same contract as the Slack button `value`.
 */
export function buildFeedbackCard(messageId: string): TeamsAttachment {
  return {
    contentType: ADAPTIVE_CARD_CONTENT_TYPE,
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [],
      actions: [
        {
          type: 'Action.Submit',
          title: '👍 Helpful',
          data: { action: FEEDBACK_ACTION_UP, messageId },
        },
        {
          type: 'Action.Submit',
          title: '👎 Not helpful',
          data: { action: FEEDBACK_ACTION_DOWN, messageId },
        },
      ],
    },
  };
}

/**
 * Inline acknowledgement card rendered in place of the feedback buttons after
 * a click. Generic wording on purpose — in channel mode the update is visible
 * to everyone, not just the clicker, so we don't claim "you rated this".
 */
export function buildFeedbackAckCard(): TeamsAttachment {
  return {
    contentType: ADAPTIVE_CARD_CONTENT_TYPE,
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: '✓ Thanks for the feedback!',
          isSubtle: true,
          wrap: true,
        },
      ],
    },
  };
}

/**
 * Convert markdown tables to a simple text format since Teams bot messages
 * don't render tables.
 */
function convertTablesToText(content: string): string {
  const tableRegex = /(\|.+\|[\r\n]+\|[-:\s|]+\|[\r\n]+(?:\|.+\|[\r\n]*)+)/g;

  return content.replace(tableRegex, (match) => {
    const lines = match.trim().split('\n');
    if (lines.length < 3) return match;

    const parseRow = (row: string): string[] => {
      return row
        .split('|')
        .map(cell => cell.trim())
        .filter(cell => cell.length > 0 && !cell.match(/^[-:]+$/));
    };

    const headers = parseRow(lines[0]);
    const rows = lines.slice(2).filter(l => l.trim()).map(parseRow);

    const result: string[] = [];
    for (const row of rows) {
      const items = row.map((cell, i) => {
        const header = headers[i] || `Col${i + 1}`;
        return `**${header}:** ${cell}`;
      });
      result.push(`- ${items.join(' | ')}`);
    }

    return result.join('\n');
  });
}

/**
 * Options for extending the formatted message.
 */
export interface FormatTeamsMessageOptions {
  /**
   * When set, append a 👍/👎 feedback Adaptive Card keyed by this messageId.
   * The caller is responsible for gating (length / cadence / terminal-only).
   */
  feedbackMessageId?: string;
}

/**
 * Format a message for Teams. Returns the markdown text chunks (Teams caps
 * message size, so very long content is split — each chunk is sent as its
 * own activity) plus optional attachments that ride on the LAST chunk.
 */
export function formatTeamsMessage(
  content: string,
  triggeredBy?: string,
  toolCalls?: Array<{ tool: string; [key: string]: unknown }>,
  options?: FormatTeamsMessageOptions,
): { chunks: FormattedTeamsMessage[] } {
  const parts: string[] = [];

  // Prefix line for autonomous triggers (heartbeat/cron), mirroring the
  // Slack context block.
  if (triggeredBy && triggeredBy !== 'USER_INPUT') {
    const contextText = triggeredBy === 'HEARTBEAT'
      ? '💓 **Heartbeat Alert**'
      : triggeredBy === 'CRON_TASK'
        ? '⏰ **Scheduled Task Result**'
        : `📬 **${triggeredBy}**`;
    parts.push(contextText);
  }

  const processedContent = convertTablesToText(content);
  if (processedContent.trim()) {
    parts.push(processedContent);
  }

  // Footer listing the tools used, mirroring the Slack context block.
  if (toolCalls && toolCalls.length > 0) {
    const uniqueTools = [...new Set(toolCalls.map((tc) => tc.tool))];
    parts.push(`🔧 _${uniqueTools.join(', ')}_`);
  }

  const fullText = parts.join('\n\n') || content || '(empty message)';

  const textChunks = fullText.length <= TEAMS_TEXT_LIMIT
    ? [fullText]
    : splitContent(fullText, TEAMS_TEXT_LIMIT);

  const chunks: FormattedTeamsMessage[] = textChunks.map((text) => ({
    text,
    textFormat: 'markdown' as const,
  }));

  // Feedback card rides on the final chunk so it appears under the full reply.
  if (options?.feedbackMessageId && chunks.length > 0) {
    chunks[chunks.length - 1].attachments = [buildFeedbackCard(options.feedbackMessageId)];
  }

  return { chunks };
}

/**
 * Split content into chunks respecting paragraph boundaries
 */
function splitContent(text: string, maxLength: number): string[] {
  const sections: string[] = [];
  let currentSection = '';

  const paragraphs = text.split(/\n\n+/);

  for (const para of paragraphs) {
    const wouldBe = currentSection + (currentSection ? '\n\n' : '') + para;

    if (wouldBe.length <= maxLength) {
      currentSection = wouldBe;
    } else {
      if (currentSection.trim()) {
        sections.push(currentSection.trim());
      }

      if (para.length > maxLength) {
        const chunks = splitLongText(para, maxLength);
        sections.push(...chunks.slice(0, -1));
        currentSection = chunks[chunks.length - 1] || '';
      } else {
        currentSection = para;
      }
    }
  }

  if (currentSection.trim()) {
    sections.push(currentSection.trim());
  }

  return sections;
}

/**
 * Split very long text by sentences or words.
 *
 * The chunk includes the character AT the split point (`splitPoint + 1`),
 * so delimiters are searched up to `maxLength - 1` — searching at
 * `maxLength` would emit a `maxLength + 1` chunk and break the invariant
 * that every chunk fits in a single Teams message.
 */
function splitLongText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitPoint = remaining.lastIndexOf('. ', maxLength - 1);
    if (splitPoint === -1 || splitPoint < maxLength / 2) {
      splitPoint = remaining.lastIndexOf('\n', maxLength - 1);
    }
    if (splitPoint === -1 || splitPoint < maxLength / 2) {
      splitPoint = remaining.lastIndexOf(' ', maxLength - 1);
    }
    if (splitPoint === -1) {
      // No delimiter at all (one unbroken run) — hard split at the limit.
      splitPoint = maxLength - 1;
    }

    chunks.push(remaining.substring(0, splitPoint + 1).trim());
    remaining = remaining.substring(splitPoint + 1).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
