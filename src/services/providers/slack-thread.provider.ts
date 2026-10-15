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

import { ConversationMessage, MessageTrigger, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import prisma from '../../lib/prisma';
import { getSlackConnection } from '../../lib/slack-source';
import { ThreadMessageProvider, MessageReadOptions } from '../thread-provider.interface';
import { slackAdapterService } from '../slack-adapter.service';
import { pollUntil, PollUntilOptions } from '../../utils/poll-until';

interface SlackMessage {
  user?: string;
  text?: string;
  ts: string;
}

/** What started a reply we stored. */
type StoredTrigger = Pick<ConversationMessage, 'triggeredBy' | 'triggerName'>;

const USER_NAME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedName {
  name: string;
  expiresAt: number;
}

export class SlackThreadProvider implements ThreadMessageProvider {
  private userNameCache = new Map<string, CachedName>();

  async getMessages(threadId: string, opts?: MessageReadOptions): Promise<ConversationMessage[]> {
    return this.fetchSlackMessages(threadId, opts);
  }

  async getRecentMessages(threadId: string, limit: number, opts?: MessageReadOptions): Promise<ConversationMessage[]> {
    const allMessages = await this.fetchSlackMessages(threadId, opts);
    return allMessages.slice(-limit);
  }

  /**
   * Wait (bounded, exponential backoff) until a message with `externalTs` is
   * visible in this thread's live Slack history.
   *
   * `conversations.replies` is eventually consistent: a just-posted message can
   * be absent for a few seconds, so building context immediately would read a
   * thread that ends on the bot's previous reply rather than the user's new
   * turn. Callers invoke this before building context so the history reflects
   * the message being responded to.
   *
   * Resolves once the message appears. If it never shows within the time
   * budget, **throws** — the turn must fail rather than respond to stale
   * context (and risk Bedrock's assistant-prefill rejection): the message is
   * not dropped. Uses a light raw-replies check (no name resolution / mapping);
   * the full read happens later via `getMessages`.
   */
  async waitForExternalMessage(
    threadId: string,
    externalTs: string,
    options: PollUntilOptions = {},
  ): Promise<void> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { externalChannelId: true, externalThreadId: true },
    });
    if (!thread?.externalChannelId || !thread?.externalThreadId) return;

    const { channelId, threadTs, teamId } = await this.resolveSlackThread(
      threadId,
      thread.externalChannelId,
      thread.externalThreadId,
    );

    const found = await pollUntil(
      () => this.isMessageVisible(channelId, threadTs, externalTs, teamId),
      options,
    );

    if (!found) {
      throw new Error(
        `Slack message ${externalTs} did not become visible in thread ${threadId} within the wait budget`,
      );
    }
  }

  /**
   * Check whether a single message (by ts) is visible in a thread, without
   * paginating the whole thread.
   *
   * Slack has no "fetch one message by id" endpoint, but `conversations.replies`
   * accepts an `oldest`/`inclusive` window. The message we wait for is the
   * newest one, so windowing to `ts >= externalTs` returns just the thread's
   * tail — a single small page, no cursor — instead of every reply. (The thread
   * parent is always returned too, so we match on `ts` rather than assume a
   * position.)
   */
  private async isMessageVisible(
    channelId: string,
    threadTs: string,
    externalTs: string,
    teamId: string,
  ): Promise<boolean> {
    const app = slackAdapterService.getAppForTeam(teamId);
    if (!app) {
      throw new Error(`No Slack app found for team ${teamId}`);
    }

    const response = await app.app.client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      oldest: externalTs,
      inclusive: true,
      limit: 200,
    });

    return ((response.messages ?? []) as SlackMessage[]).some((m) => m.ts === externalTs);
  }

  /**
   * Resolve thread metadata, fetch from Slack API, and map to ConversationMessage format.
   *
   * The model view (the default) also merges the thread's concise-mode
   * internal steps — AGENT rows persisted for replay but never posted to
   * Slack, so absent from the live `conversations.replies` read. The client
   * view (`view: 'client'`) skips that merge.
   */
  private async fetchSlackMessages(threadId: string, opts?: MessageReadOptions): Promise<ConversationMessage[]> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: {
        externalChannelId: true,
        externalThreadId: true,
        compactedThroughTs: true,
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

    // Compaction watermark, model view only: replies at or before it are folded
    // into the thread's compaction summary, so the live read skips them (and
    // usually collapses to a single page). The client view stays unwindowed —
    // compaction only changes what the model sees.
    const clientView = opts?.view === 'client';
    const compactedThroughTs = clientView ? null : thread.compactedThroughTs;

    const [rawMessages, { contentByTs, toolCallsByTs, createdAtByTs, triggerByTs }] = await Promise.all([
      this.fetchAllReplies(channelId, threadTs, teamId, compactedThroughTs ?? undefined),
      this.getAgentMessageMaps(threadId),
    ]);
    const slackDerived = await this.mapToConversationMessages(
      threadId,
      rawMessages,
      botUserId,
      teamId,
      contentByTs,
      toolCallsByTs,
      createdAtByTs,
      triggerByTs,
    );

    if (clientView) return slackDerived;

    // Model view: interleave the persisted internal steps. Both the internal rows
    // and (via createdAtByTs) our own delivered replies are ordered by our DB
    // clock, so an internal step sorts before its turn's delivered final; the
    // cross-clock comparison (Slack ts vs DB createdAt) only occurs at user↔agent
    // boundaries. Concat internal-first so a rare exact timestamp tie keeps the
    // internal step ahead of its final (stable sort).
    //
    // One of those boundaries is now close rather than a full LLM round apart: a
    // turn's recalled memories are written about a second after the Slack message
    // that triggered them, the time it takes to read the context and embed the
    // query. A host clock behind Slack's by more than that sorts the recall ahead of
    // the question it answers. The replay is then a different shape from the live
    // send, which costs that thread one re-write; nothing breaks.
    const internal = await this.getInternalStepMessages(threadId);
    if (internal.length === 0) return slackDerived;
    return [...internal, ...slackDerived].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  /**
   * Internal steps for this thread: rows persisted for model replay but never
   * delivered to Slack (`externalMessageId` is null, so they are disjoint from the
   * ts-enriched set built in {@link getAgentMessageMaps} — never set a ts on an
   * internal row or it would replay twice). `isCompacted: false` mirrors the
   * DatabaseThreadProvider filter.
   *
   * Either role. Concise mode writes AGENT rows; a turn's recalled memories are a
   * USER row. Filtering to AGENT would rebuild a Slack thread's history from Slack
   * alone and drop every recall, so the same agent would answer differently
   * depending on which surface the thread ran on.
   */
  private async getInternalStepMessages(threadId: string): Promise<ConversationMessage[]> {
    return prisma.conversationMessage.findMany({
      where: {
        threadId,
        internalStep: true,
        isCompacted: false,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Look up the Slack workspace details for a thread.
   */
  private async resolveSlackThread(
    threadId: string,
    channelId: string,
    threadTs: string
  ): Promise<{ channelId: string; threadTs: string; teamId: string; botUserId: string }> {
    // Channels store their id on slackChannelId; DMs store theirs on
    // dmChannelId. Look in both so threaded DMs (which are SLACK-sourced and
    // pass dmChannelId as externalChannelId) can resolve their workspace here.
    const mapping = await prisma.slackMapping.findFirst({
      where: {
        OR: [
          { slackChannelId: channelId },
          { dmChannelId: channelId },
        ],
      },
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
   *
   * `oldest` windows the read to replies strictly after the compaction
   * watermark (no `inclusive`, so the watermark message itself is excluded).
   * The thread parent is always returned by the API regardless of `oldest`, so
   * a ts post-filter drops it — without that, a compacted thread would replay
   * its root message forever.
   */
  private async fetchAllReplies(
    channelId: string,
    threadTs: string,
    teamId: string,
    oldest?: string
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
        ...(oldest && { oldest }),
        ...(cursor && { cursor }),
      });

      const messages = (response.messages || []) as SlackMessage[];
      allMessages.push(...messages);

      cursor = response.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }

    if (!oldest) return allMessages;
    const cutoff = parseFloat(oldest);
    return allMessages.filter((m) => parseFloat(m.ts) > cutoff);
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
    dbContentByTs: Map<string, string>,
    toolCallsByTs: Map<string, Prisma.JsonValue>,
    createdAtByTs: Map<string, Date>,
    triggerByTs: Map<string, StoredTrigger>,
  ): Promise<ConversationMessage[]> {
    // Choose the authoritative body for a message. For the agent's own
    // replies, prefer the lossless stored DB content (which preserves
    // newlines) over Slack's `msg.text`. Slack returns a flattened,
    // newline-stripped `text` for messages posted with markdown/blocks, and
    // replaying that as history trains the agent to imitate single-line
    // output — so we always feed it back its real, well-formatted reply.
    // Falls back to `msg.text` when no stored row exists (e.g. pre-join or
    // un-persisted messages).
    const sourceText = (m: SlackMessage): string => {
      if (m.user === botUserId) {
        const stored = dbContentByTs.get(m.ts);
        if (stored && stored.trim().length > 0) return stored;
      }
      return m.text || '';
    };

    // Collect every Slack user ID we'll need a name for: senders + any
    // user mentioned via `<@U…>` inside message bodies. Resolved in one batch.
    const senderIds = slackMessages
      .filter(m => m.user && m.user !== botUserId)
      .map(m => m.user!);
    const mentionIds = slackMessages.flatMap(m =>
      [...sourceText(m).matchAll(/<@([A-Z0-9]+)>/g)].map(match => match[1]),
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

      const rawText = sourceText(msg);
      const enrichedText = enrichMentions(rawText);

      // Prefix user messages with the sender's combined mention marker so
      // the agent always sees the canonical token for whoever is speaking.
      let content: string;
      if (isOurAgent || !msg.user || !enrichedText) {
        content = enrichedText;
      } else {
        content = `<@${msg.user}:${sanitizeName(senderName)}>: ${enrichedText}`;
      }

      // Prefer the stored DB createdAt for our own replies (a single, monotonic
      // server clock) so persisted internal steps interleave correctly against
      // them; fall back to the Slack ts for messages we never persisted (pre-join,
      // non-mention, or user messages).
      const createdAt = (isOurAgent && createdAtByTs.get(msg.ts)) || new Date(parseFloat(msg.ts) * 1000);

      return {
        id: this.deterministicId(threadId, msg.ts),
        threadId,
        role: isOurAgent ? 'AGENT' as const : 'USER' as const,
        content,
        // A reply we stored keeps its trigger, so a scheduled task's reply is not
        // read as an answer to the person.
        triggeredBy: (isOurAgent && triggerByTs.get(msg.ts)?.triggeredBy) || MessageTrigger.USER_INPUT,
        triggerName: (isOurAgent && triggerByTs.get(msg.ts)?.triggerName) || null,
        toolCalls: (isOurAgent && toolCallsByTs.get(msg.ts)) || null,
        blocks: null,
        senderExternalId: msg.user || null,
        senderName: isOurAgent ? null : senderName,
        externalMessageId: msg.ts,
        isCompacted: false,
        // Slack-derived rows are always delivered messages, never internal steps.
        internalStep: false,
        createdAt,
      };
    });
  }

  /**
   * Build lookup maps from Slack message ts → stored agent data.
   *
   * Agent replies are persisted in the DB with `externalMessageId` set to the
   * Slack ts (and `toolCalls` when present), so we can match them back to the
   * Slack messages this provider reads. We fetch BOTH the original `content`
   * (lossless, newline-preserving — used in place of Slack's flattened
   * `msg.text`) and `toolCalls` for context enrichment.
   *
   * Note: no `toolCalls` filter on the query — most agent messages have none,
   * and we still need their `content`. The `toolCalls` map only gains an entry
   * when the row actually carries tool calls.
   */
  private async getAgentMessageMaps(threadId: string): Promise<{
    contentByTs: Map<string, string>;
    toolCallsByTs: Map<string, Prisma.JsonValue>;
    createdAtByTs: Map<string, Date>;
    triggerByTs: Map<string, StoredTrigger>;
  }> {
    // Only delivered agent replies carry a ts (`externalMessageId`). This set is
    // disjoint from the concise internal steps merged in fetchSlackMessages
    // (those have externalMessageId == null) — keep it that way so no row is
    // replayed twice.
    const dbMessages = await prisma.conversationMessage.findMany({
      where: {
        threadId,
        role: 'AGENT',
        externalMessageId: { not: null },
      },
      select: {
        externalMessageId: true,
        content: true,
        toolCalls: true,
        createdAt: true,
        triggeredBy: true,
        triggerName: true,
      },
    });

    const contentByTs = new Map<string, string>();
    const toolCallsByTs = new Map<string, Prisma.JsonValue>();
    const createdAtByTs = new Map<string, Date>();
    const triggerByTs = new Map<string, StoredTrigger>();
    for (const msg of dbMessages) {
      if (!msg.externalMessageId) continue;
      contentByTs.set(msg.externalMessageId, msg.content);
      createdAtByTs.set(msg.externalMessageId, msg.createdAt);
      triggerByTs.set(msg.externalMessageId, { triggeredBy: msg.triggeredBy, triggerName: msg.triggerName });
      if (msg.toolCalls != null) {
        toolCallsByTs.set(msg.externalMessageId, msg.toolCalls);
      }
    }
    return { contentByTs, toolCallsByTs, createdAtByTs, triggerByTs };
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
