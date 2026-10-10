/**
 * Teams Message Formatter
 *
 * Renders agent output as plain-markdown Teams message activities. Teams chat
 * renders a markdown subset that INCLUDES tables, so unlike the Slack
 * formatter there is no tables→bullets conversion and no block structure —
 * one formatted string per activity, chunked well below Teams' message size
 * limit (~28k chars) at paragraph boundaries.
 */

import { splitContent } from './text-chunker';

/** Per-activity text budget — a safe bound below Teams' ~28k char limit. */
export const TEAMS_TEXT_LIMIT = 25_000;

export interface FormatTeamsMessageOptions {
  /** Message source (HEARTBEAT, CRON_TASK, …) — rendered as a banner line. */
  triggeredBy?: string;
  /** Tool calls made during the turn — rendered as a one-line footer. */
  toolCalls?: Array<{ tool: string; [key: string]: unknown }>;
}

/**
 * Format a message for Teams: returns one or more activity texts, in send
 * order. The triggered-by banner leads the first chunk and the tool footer
 * trails the last, so a chunked message carries each exactly once.
 */
export function formatTeamsMessage(
  content: string,
  options?: FormatTeamsMessageOptions,
): string[] {
  const { triggeredBy, toolCalls } = options ?? {};

  let banner = '';
  if (triggeredBy && triggeredBy !== 'USER_INPUT') {
    banner =
      triggeredBy === 'HEARTBEAT'
        ? '💓 **Heartbeat Alert**'
        : triggeredBy === 'CRON_TASK'
          ? '⏰ **Scheduled Task Result**'
          : `📬 **${triggeredBy}**`;
  }

  let footer = '';
  if (toolCalls && toolCalls.length > 0) {
    const uniqueTools = [...new Set(toolCalls.map((tc) => tc.tool))];
    footer = `🔧 _${uniqueTools.join(', ')}_`;
  }

  const body = content.trim() || '(empty message)';
  const chunks = body.length <= TEAMS_TEXT_LIMIT ? [body] : splitContent(body, TEAMS_TEXT_LIMIT);
  if (chunks.length === 0) chunks.push(body.slice(0, TEAMS_TEXT_LIMIT));

  if (banner) chunks[0] = `${banner}\n\n${chunks[0]}`;
  if (footer) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n${footer}`;

  return chunks;
}

/**
 * How the system prompt names a Teams channel, with what the agent sees of a thread there and how
 * it addresses someone: the adapter keeps a thread from the message that first mentioned the
 * agent, and Teams shows a token in a reply as text.
 */
export function teamsChannelLabel(channelName: string): string {
  return (
    `the Microsoft Teams channel **${channelName}**, where you see this thread from the message ` +
    'that first mentioned you, and where you address people by name, because Teams shows a ' +
    'token as text'
  );
}
