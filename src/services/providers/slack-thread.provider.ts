/**
 * Slack Thread Provider
 *
 * Reads conversation messages from Slack's conversations.replies API.
 * Used for threads with ThreadSource.SLACK to get the full Slack thread history,
 * including messages where the bot wasn't mentioned, edited messages, and
 * messages from before the bot joined.
 *
 * Accesses the Slack Bolt apps directly (no backend proxy).
 */

import { ConversationMessage, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import prisma from '../../lib/prisma';
import { getSlackConnection } from '../../lib/slack-source';
import { ThreadMessageProvider } from '../thread-provider.interface';
import { slackAdapterService } from '../slack-adapter.service';

interface SlackMessage {
  user?: string;
  text?: string;
  ts: string;
}

const USER_NAME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedName {
  name: string;
  expiresAt: number;
}

export class SlackThreadProvider implements ThreadMessageProvider {
  private userNameCache = new Map<string, CachedName>();

  async getMessages(threadId: string): Promise<ConversationMessage[]> {
    return this.fetchSlackMessages(threadId);
  }

  async getRecentMessages(threadId: string, limit: number): Promise<ConversationMessage[]> {
    const allMessages = await this.fetchSlackMessages(threadId);
    return allMessages.slice(-limit);
  }

  /**
   * Resolve thread metadata, fetch from Slack API, and map to ConversationMessage format.
   */
  private async fetchSlackMessages(threadId: string): Promise<ConversationMessage[]> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: {
        externalChannelId: true,
        externalThreadId: true,
      },
    });

    if (!thread?.externalChannelId || !thread?.externalThreadId) {
      throw new Error(
        `Slack thread ${threadId} missing externalChannelId or externalThreadId`
      );
    }

    const { channelId, threadTs, teamId, botUserId } = await this.resolveSlackThread(
      threadId,
      thread.externalChannelId,
      thread.externalThreadId
    );

    const [rawMessages, toolCallsByTs] = await Promise.all([
      this.fetchAllReplies(channelId, threadTs, teamId),
      this.getToolCallsForThread(threadId),
    ]);
    return this.mapToConversationMessages(threadId, rawMessages, botUserId, teamId, toolCallsByTs);
  }

  /**
   * Look up the Slack workspace details for a thread.
   */
  private async resolveSlackThread(
    threadId: string,
    channelId: string,
    threadTs: string
  ): Promise<{ channelId: string; threadTs: string; teamId: string; botUserId: string }> {
    const mapping = await prisma.slackMapping.findFirst({
      where: { slackChannelId: channelId },
    });

    if (!mapping) {
      throw new Error(
        `No SlackMapping found for channel ${channelId} (thread ${threadId})`
      );
    }

    const connection = await getSlackConnection();
    if (!connection) {
      throw new Error(
        `No SlackConnection found for connectionId ${mapping.connectionId} (thread ${threadId})`
      );
    }

    return {
      channelId,
      threadTs,
      teamId: connection.teamId,
      botUserId: connection.botUserId,
    };
  }

  /**
   * Fetch all replies from Slack's conversations.replies API using local Bolt app.
   */
  private async fetchAllReplies(
    channelId: string,
    threadTs: string,
    teamId: string
  ): Promise<SlackMessage[]> {
    const app = slackAdapterService.getAppForTeam(teamId);
    if (!app) {
      throw new Error(`No Slack app found for team ${teamId}`);
    }

    const allMessages: SlackMessage[] = [];
    let cursor: string | undefined;
    const maxPages = 50;

    for (let page = 0; page < maxPages; page++) {
      const response = await app.app.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
        ...(cursor && { cursor }),
      });

      const messages = (response.messages || []) as SlackMessage[];
      allMessages.push(...messages);

      cursor = response.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }

    return allMessages;
  }

  /**
   * Map Slack messages to ConversationMessage format.
   *
   * Senders and any `<@USERID>` tokens inside message bodies are rewritten to
   * the combined `<@USERID:displayName>` form so the agent can copy the token
   * verbatim into a reply — the Slack adapter's outbound rewrite then turns
   * it into a real Slack mention that fires a notification.
   */
  private async mapToConversationMessages(
    threadId: string,
    slackMessages: SlackMessage[],
    botUserId: string,
    teamId: string,
    toolCallsByTs: Map<string, Prisma.JsonValue>,
  ): Promise<ConversationMessage[]> {
    // Collect every Slack user ID we'll need a name for: senders + any
    // user mentioned via `<@U…>` inside message bodies. Resolved in one batch.
    const senderIds = slackMessages
      .filter(m => m.user && m.user !== botUserId)
      .map(m => m.user!);
    const mentionIds = slackMessages.flatMap(m =>
      [...(m.text || '').matchAll(/<@([A-Z0-9]+)>/g)].map(match => match[1]),
    );
    const userIds = [...new Set([...senderIds, ...mentionIds])];

    const userNames = await this.resolveUserNames(userIds, teamId);

    const sanitizeName = (name: string): string =>
      name.replace(/[<>:\x00-\x1f]/g, '').trim() || name;

    const enrichMentions = (text: string): string =>
      text.replace(/<@([A-Z0-9]+)>/g, (_match, uid: string) => {
        const name = userNames.get(uid);
        return name ? `<@${uid}:${sanitizeName(name)}>` : `<@${uid}>`;
      });

    return slackMessages.map(msg => {
      // Only treat messages from OUR bot as AGENT — other bots are treated as users
      const isOurAgent = msg.user === botUserId;
      const senderName = isOurAgent
        ? 'Agent'
        : userNames.get(msg.user!) || msg.user || 'Unknown';

      const rawText = msg.text || '';
      const enrichedText = enrichMentions(rawText);

      // Prefix user messages with the sender's combined mention marker so
      // the agent always sees the canonical token for whoever is speaking.
      let content: string;
      if (isOurAgent || !msg.user || !enrichedText) {
        content = enrichedText;
      } else {
        content = `<@${msg.user}:${sanitizeName(senderName)}>: ${enrichedText}`;
      }

      return {
        id: this.deterministicId(threadId, msg.ts),
        threadId,
        role: isOurAgent ? 'AGENT' as const : 'USER' as const,
        content,
        triggeredBy: 'USER_INPUT' as const,
        toolCalls: (isOurAgent && toolCallsByTs.get(msg.ts)) || null,
        blocks: null,
        tokenCount: null,
        senderExternalId: msg.user || null,
        senderName: isOurAgent ? null : senderName,
        externalMessageId: msg.ts,
        isCompacted: false,
        createdAt: new Date(parseFloat(msg.ts) * 1000),
      };
    });
  }

  /**
   * Build a lookup map from Slack message ts to tool calls stored in the database.
   * Agent responses are stored in the DB with toolCalls and externalMessageId (the Slack ts),
   * so we can match them back to Slack messages for context enrichment.
   */
  private async getToolCallsForThread(threadId: string): Promise<Map<string, Prisma.JsonValue>> {
    const dbMessages = await prisma.conversationMessage.findMany({
      where: {
        threadId,
        role: 'AGENT',
        toolCalls: { not: Prisma.DbNull },
        externalMessageId: { not: null },
      },
      select: {
        externalMessageId: true,
        toolCalls: true,
      },
    });

    const map = new Map<string, Prisma.JsonValue>();
    for (const msg of dbMessages) {
      if (msg.externalMessageId && msg.toolCalls) {
        map.set(msg.externalMessageId, msg.toolCalls);
      }
    }
    return map;
  }

  /**
   * Resolve Slack user IDs to display names using local Bolt app with in-memory caching.
   */
  private async resolveUserNames(
    userIds: string[],
    teamId: string
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const now = Date.now();

    // Collect cached names and determine which IDs need fetching
    const uncachedIds: string[] = [];
    for (const userId of userIds) {
      const cached = this.userNameCache.get(userId);
      if (cached && cached.expiresAt > now) {
        names.set(userId, cached.name);
      } else {
        uncachedIds.push(userId);
      }
    }

    if (uncachedIds.length === 0) return names;

    const app = slackAdapterService.getAppForTeam(teamId);
    if (!app) return names;

    await Promise.all(
      uncachedIds.map(async (userId) => {
        try {
          const result = await app.app.client.users.info({ user: userId });
          const user = result.user as { real_name?: string; name?: string } | undefined;
          const displayName = user?.real_name || user?.name;
          if (displayName) {
            names.set(userId, displayName);
            this.userNameCache.set(userId, { name: displayName, expiresAt: now + USER_NAME_CACHE_TTL_MS });
          }
        } catch {
          // Silently skip — caller falls back to user ID
        }
      })
    );

    return names;
  }

  /**
   * Generate a deterministic ID from threadId + Slack timestamp.
   */
  private deterministicId(threadId: string, ts: string): string {
    const hex = createHash('sha256')
      .update(`${threadId}:${ts}`)
      .digest('hex');
    // Format as UUID shape: 8-4-4-4-12
    return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
  }
}
