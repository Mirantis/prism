/**
 * Teams Adapter Service
 *
 * Microsoft Teams channel adapter — the Teams mirror of
 * slack-adapter.service.ts, built on the Teams SDK (`@microsoft/teams.apps`).
 *
 * Architecture notes:
 * - Inbound: Azure Bot Service POSTs activities to `/agents/teams/messages`
 *   on a listener of its own (`TEAMS_PORT`) that serves nothing else, so that
 *   port alone is what a deployment publishes. The SDK registers the route and
 *   validates the Bot Framework JWT before our handler runs. The handler acknowledges fast — it sends one typing activity and
 *   fires the real work without awaiting it — because Bot Framework expects a
 *   response within seconds while a Prism turn runs for minutes.
 * - Outbound: every reply is a proactive send addressed by a stored
 *   conversation id (`app.send` / `app.reply`). Only the conversation id is
 *   persisted — never the activity's serviceUrl, which an attacker could
 *   forge; the SDK resolves the service URL itself.
 * - Fail-soft: unset env leaves the adapter idle; an SDK init failure is
 *   logged and leaves the adapter idle, mirroring the Slack adapter.
 */

import http from 'node:http';
import { App, ExpressAdapter } from '@microsoft/teams.apps';
import {
  IMessageActivity,
  MessageActivityInput,
  TypingActivityInput,
  stripMentionsText,
} from '@microsoft/teams.api';
import prisma from '../../lib/prisma';
import { logger } from '../../logger';
import { config } from '../../config';
import { trackEvent } from '../../lib/telemetry';
import { getTeamsConfig, TeamsConnectionRecord } from '../../lib/teams-config';
import { teamsMappingService } from './teams-mapping.service';
import { conversationService } from '../conversation.service';
import { conversationEngineService } from '../conversation-engine.service';
import {
  threadReplyClassifierService,
  ThreadAction,
  ThreadLine,
  THREAD_TRANSCRIPT_LINES,
} from '../thread-reply-classifier.service';
import { formatTeamsMessage, teamsChannelLabel } from '../../utils/teams-formatter';
import { MAX_FILE_SIZE_BYTES } from '../../constants';
import { getProxyDispatcher } from '../../lib/proxy-dispatcher';
import {
  buildFileFailureNotice,
  describeSharedFiles,
  readInboundFiles,
  TeamsFileTooLargeError,
  TeamsInboundFiles,
} from './teams-attachments';
import {
  ChannelAdapter,
  ChannelContext,
  ChannelDestination,
  DeliverableMessage,
  describeTarget,
  LinkedTarget,
  MENTION_TOKEN,
  SendRefusedError,
} from '../channel-adapter.interface';
import { AttachmentMeta } from '../attachment.service';

/** The public messaging endpoint registered on the Azure Bot resource. */
export const TEAMS_MESSAGING_PATH = '/agents/teams/messages';

/** How long one inbound file download may take. */
const FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Proactive-send retries on 429 (Retry-After honored when present). */
const SEND_RETRIES = 2;

/** An AAD object id, the id a Teams mention token names. */
const AAD_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Teams channel message id, which is also a reply-chain root. */
const TEAMS_MESSAGE_ID = /^\d+$/;

/**
 * Telemetry-safe description of a thrown value (name + HTTP status only —
 * never the message, which can quote user content). Mirrors the Slack
 * adapter's helper.
 */
function errorShape(error: unknown): Record<string, string> {
  const status =
    (error as { statusCode?: unknown } | null)?.statusCode ??
    (error as { status?: unknown } | null)?.status;
  return {
    'error.name': error instanceof Error ? error.name : typeof error,
    ...(typeof status === 'number' ? { 'error.status': String(status) } : {}),
  };
}

/** Read an HTTP status off an unknown error (SDK sends ride axios). */
function errorStatus(error: unknown): number | undefined {
  const err = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; headers?: Record<string, unknown> };
  } | null;
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Read a Retry-After delay (ms) off an unknown error, if one is present. */
function retryAfterMs(error: unknown): number | undefined {
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | null)?.response
    ?.headers;
  const raw = headers?.['retry-after'];
  const seconds = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      // A net.Server emits 'error' on a failed accept (e.g. EMFILE under
      // file-descriptor pressure). With no listener the event throws and stops
      // the process, and this port faces the internet, so keep a permanent one
      // once binding has succeeded.
      server.on('error', (err) => logger.error({ err }, '[TeamsAdapter] bot server error'));
      resolve();
    });
  });
}

class TeamsAdapterService implements ChannelAdapter {
  readonly name = 'teams';

  private app?: App;
  private server?: http.Server;
  private connection: TeamsConnectionRecord | null = null;
  /** The bot's own account id, captured from the first inbound activity. */
  private botAccountId?: string;
  private stopped = false;

  /**
   * Test-only: reset the singleton between tests.
   * @internal
   */
  __resetForTests(): void {
    this.app = undefined;
    this.server = undefined;
    this.connection = null;
    this.botAccountId = undefined;
    this.stopped = false;
  }

  // ============================================================================
  // ChannelAdapter contract
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.app) return; // already initialized
    this.stopped = false;
    // Hoisted so a failure after the SDK app is built — a bind conflict on the
    // bot port, say — can still stop it. Leaving an initialized app unstopped
    // leaks its token-manager timers, and a retry would build a second one.
    let app: App | undefined;
    let server: http.Server | undefined;
    try {
      const connection = await getTeamsConfig();
      if (!connection) {
        logger.info('[TeamsAdapter] Teams not configured; adapter idle');
        return;
      }
      this.connection = connection;

      // The adapter serves every request on this server, and registers only the
      // messaging route on it; `app.stop()` closes it.
      server = http.createServer();
      app = new App({
        clientId: config.teamsAppId,
        clientSecret: config.teamsAppPassword,
        tenantId: config.teamsAppTenantId,
        httpServerAdapter: new ExpressAdapter(server),
        messagingEndpoint: TEAMS_MESSAGING_PATH,
        // Pinned so a stray DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS env var
        // can never disable JWT validation on the public endpoint.
        dangerouslyAllowUnauthenticatedRequests: false,
      });

      app.on('message', async ({ activity, send }) => {
        // `!this.app` covers a failed initialize: the route may already be
        // mounted (routeRegistered) and JWT validation needs only Microsoft's
        // keys, so a valid Bot Service POST still reaches here with no working
        // app. Dropping it avoids running a full turn whose reply cannot send.
        if (this.stopped || !this.app) return;
        // Ignore echoes of the bot's own posts — a delivered reply must never
        // re-enter chat().
        if (activity.from?.id && activity.recipient?.id && activity.from.id === activity.recipient.id) {
          return;
        }
        this.botAccountId = activity.recipient?.id ?? this.botAccountId;

        // Group chats are out of scope in v1.
        const conversationType = activity.conversation?.conversationType;
        if (conversationType !== 'personal' && conversationType !== 'channel') {
          logger.debug('[TeamsAdapter] ignoring %s conversation activity', String(conversationType));
          return;
        }

        // Brief working cue, sent once the adapter knows it answers; Teams
        // expires it after a few seconds.
        const signalWork = async (): Promise<void> => {
          try {
            await send(new TypingActivityInput());
          } catch (error: unknown) {
            logger.debug('[TeamsAdapter] typing activity failed: %s', String(error));
          }
        };

        // Ack the webhook fast: the turn runs for minutes, every reply goes
        // out proactively via deliver().
        void this.processMessage(activity, signalWork).catch((error: unknown) => {
          logger.error({ err: error, activityId: activity.id }, '[TeamsAdapter] failed to process activity');
        });
      });

      // Registers the route. The server listens here rather than in
      // `app.start()`, which binds every interface: this port keeps the
      // runtime's own bind address (`PRISM_HOST`).
      await app.initialize();
      await listen(server, config.teamsPort, config.host);
      this.app = app;
      this.server = server;

      logger.info(
        {
          tenantId: connection.tenantId,
          endpoint: `http://${config.host}:${config.teamsPort}${TEAMS_MESSAGING_PATH}`,
        },
        '[TeamsAdapter] initialized'
      );
      trackEvent('teams adapter initialized', null, {
        ...(config.agentId ? { 'agent.id': config.agentId } : {}),
        'teams.tenant': connection.tenantId,
      });
    } catch (error: unknown) {
      logger.error({ err: error }, '[TeamsAdapter] failed to initialize');
      // Release the SDK app and the server the bind may have left half-open,
      // so a failed initialize leaks nothing and a retry starts clean.
      try {
        await app?.stop();
      } catch (stopError: unknown) {
        logger.debug('[TeamsAdapter] stop after failed initialize failed: %s', String(stopError));
      }
      if (server?.listening) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
      this.app = undefined;
      this.server = undefined;
      this.connection = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const wasActive = this.app != null;
    try {
      await this.app?.stop();
      const server = this.server;
      if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch (error: unknown) {
      logger.debug('[TeamsAdapter] stop failed: %s', String(error));
    }
    this.app = undefined;
    this.server = undefined;
    this.connection = null;
    this.botAccountId = undefined;
    if (wasActive) {
      trackEvent(
        'teams adapter shutdown',
        null,
        config.agentId ? { 'agent.id': config.agentId } : {}
      );
    }
  }

  async isUserConnected(userId: string): Promise<boolean> {
    if (!this.app) return false;
    return (await teamsMappingService.countAllMappings(userId)) > 0;
  }

  /**
   * A Teams thread continues where it started. A channel thread stores
   * `${channelConversationId};messageid=${rootMessageId}`, so a continuation
   * posts into the original reply chain. A DM thread stores no reply chain and
   * carries no channel id, so the user's personal conversation is resolved:
   * the continuation stays in the DM instead of the mapping broadcast.
   */
  async threadDestination(threadId: string, originChannelId?: string): Promise<ChannelDestination> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { userId: true, agentId: true, externalThreadId: true },
    });
    const [channelConversationId, rootMessageId] = (thread?.externalThreadId ?? '').split(';messageid=');
    if (channelConversationId && rootMessageId) {
      return {
        channelId: channelConversationId,
        channelThreadId: rootMessageId,
        channelLabel: teamsChannelLabel(channelConversationId),
      };
    }
    let channelId = originChannelId;
    if (!channelId && thread) {
      const dm = await prisma.teamsMapping.findFirst({
        where: { lensUserId: thread.userId, agentId: thread.agentId, dmConversationId: { not: null } },
        select: { dmConversationId: true },
      });
      channelId = dm?.dmConversationId ?? undefined;
    }
    if (!channelId) {
      logger.warn(
        'No Teams conversation resolved for thread %s (no origin channel id and no DM mapping) — a "continue in thread" resume will not be delivered',
        threadId,
      );
    }
    // Personal chats have no reply chains, so the continuation posts top-level.
    return { channelId, channelLabel: channelId ? teamsChannelLabel(channelId) : undefined };
  }

  /**
   * The user's personal conversation, else the agent's main linked channel. A
   * channel destination carries its id: a Teams context without one is
   * DM-scoped and would deliver nothing in Team Mode.
   */
  async defaultDestination(
    agentId: string,
    userId: string,
  ): Promise<(ChannelDestination & { threadKey: string }) | null> {
    const dm = await prisma.teamsMapping.findFirst({
      where: { lensUserId: userId, agentId, dmConversationId: { not: null } },
      select: { dmConversationId: true },
    });
    if (dm?.dmConversationId) return { threadKey: dm.dmConversationId };
    const mainChannel = await teamsMappingService.getMainChannel(agentId);
    return mainChannel ? { threadKey: mainChannel, channelId: mainChannel } : null;
  }

  /**
   * Deliver a message to Teams — always a proactive send.
   *
   * - Channel-scoped (channelContext with channelId): threaded reply under the
   *   originating root activity.
   * - DM-scoped (Teams channelContext without channelId): the user's personal
   *   conversations only.
   * - Broadcast (no channelContext — heartbeat/cron/goal): every DM mapping
   *   plus exactly ONE channel, the agent's main channel (flagged, else the
   *   oldest linked).
   *
   * Log-not-throw on failure: the message is already persisted.
   */
  async deliver(
    userId: string,
    message: DeliverableMessage,
    channelContext?: ChannelContext
  ): Promise<void> {
    if (!this.app) return;

    // includeFeedback is ignored on Teams in v1 — feedback buttons need
    // Adaptive Card actions, which are deferred.
    const chunks = formatTeamsMessage(this.withAttachmentNotice(message.content, message.attachments), {
      triggeredBy: message.triggeredBy || undefined,
      toolCalls: (message.toolCalls as Array<{ tool: string }>) ?? undefined,
    });

    // Channel-scoped delivery: reply into the originating thread.
    if (channelContext?.channel === 'teams' && channelContext.channelId) {
      const sent = await this.sendChunks(channelContext.channelId, channelContext.channelThreadId, chunks);
      if (sent) {
        trackEvent('teams message delivered', userId, {
          ...(config.agentId ? { 'agent.id': config.agentId } : {}),
          'teams.delivery': 'channel',
        });
      }
      return;
    }

    // Scope by agent when the thread is known (mirrors the Slack adapter).
    const thread = await prisma.conversationThread.findUnique({
      where: { id: message.threadId },
      select: { agentId: true },
    });
    const mappings = await prisma.teamsMapping.findMany({
      where: {
        lensUserId: userId,
        ...(thread?.agentId && { agentId: thread.agentId }),
      },
      orderBy: { createdAt: 'asc' },
    });
    if (mappings.length === 0) return;

    // DM-scoped: a Teams DM turn carries channelContext without a channelId.
    // Post only to the user's personal conversations — never a channel.
    const dmScoped = channelContext?.channel === 'teams';

    // Autonomous output lands in exactly ONE channel — the main channel
    // (flagged, else oldest) — never every linked channel.
    const channelMappings = mappings.filter((m) => m.channelConversationId);
    const mainChannelId = dmScoped
      ? null
      : ((channelMappings.find((m) => m.isMainChannel) ?? channelMappings[0])
          ?.channelConversationId ?? null);

    let delivered = 0;
    for (const mapping of mappings) {
      if (mapping.dmConversationId) {
        // Personal chats have no threads — always post top-level.
        if (await this.sendChunks(mapping.dmConversationId, undefined, chunks)) delivered++;
      }
      if (mapping.channelConversationId && mapping.channelConversationId === mainChannelId) {
        if (await this.sendChunks(mapping.channelConversationId, undefined, chunks)) delivered++;
      }
    }

    if (delivered > 0) {
      trackEvent('teams message delivered', userId, {
        ...(thread?.agentId ? { 'agent.id': thread.agentId } : {}),
        'teams.delivery': 'mapping',
        'teams.mappings': String(delivered),
      });
    }
  }

  async listLinkedTargets(agentId: string): Promise<LinkedTarget[]> {
    const mappings = await prisma.teamsMapping.findMany({
      where: { agentId },
      orderBy: { createdAt: 'asc' },
    });
    const channels = mappings.filter((m) => m.channelConversationId);
    const mainChannelId =
      (channels.find((m) => m.isMainChannel) ?? channels[0])?.channelConversationId ?? null;

    const targets: LinkedTarget[] = [];
    for (const mapping of mappings) {
      if (mapping.channelConversationId) {
        targets.push({
          key: `teams:${mapping.channelConversationId}`,
          platform: 'teams',
          kind: 'channel',
          conversationId: mapping.channelConversationId,
          name: mapping.channelName,
          isMain: mapping.channelConversationId === mainChannelId,
        });
      }
      if (mapping.dmConversationId) {
        targets.push({
          key: `teams:${mapping.dmConversationId}`,
          platform: 'teams',
          kind: 'dm',
          conversationId: mapping.dmConversationId,
          name: mapping.teamsUserId ? `<@${mapping.teamsUserId}>` : null,
          isMain: false,
        });
      }
    }
    return targets;
  }

  /**
   * One proactive send, threaded under `thread` when given. Each mention token
   * becomes an `<at>` tag with a matching mention entity, which is what makes
   * Teams notify the person. Errors reach the caller, a tool that reports the
   * outcome to the agent.
   */
  async postToTarget(target: LinkedTarget, text: string, thread?: string): Promise<{ messageId: string }> {
    const app = this.app;
    if (!app) {
      throw new SendRefusedError('Microsoft Teams is not connected, so nothing can be sent there.', 'not_connected');
    }
    if (thread !== undefined && !TEAMS_MESSAGE_ID.test(thread)) {
      throw new SendRefusedError(
        `"${thread}" is not a Teams thread id. A thread id is the id of the thread's first message, a number.`,
        'bad_thread',
      );
    }
    if (thread !== undefined && target.kind === 'dm') {
      throw new SendRefusedError('A Teams personal chat has no threads. Send without a thread id.', 'bad_thread');
    }

    const activity = await this.withCheckedMentions(app, target, text);
    const sent = await this.sendWithRetry(() =>
      thread ? app.reply(target.conversationId, thread, activity) : app.send(target.conversationId, activity)
    );
    return { messageId: String(sent.id) };
  }

  /**
   * Refuse a mention token that is not an AAD object id, or that names a person
   * the conversation does not have as a member. The member lookup also gives
   * the display name the `<at>` tag needs.
   */
  private async withCheckedMentions(app: App, target: LinkedTarget, text: string): Promise<MessageActivityInput> {
    const tokens = [...text.matchAll(MENTION_TOKEN)];
    for (const [token, id] of tokens) {
      if (!AAD_OBJECT_ID.test(id)) {
        throw new SendRefusedError(
          `${token} is not a Teams user mention. Mention a person as <@AAD-OBJECT-ID>, with the id from a message you have seen.`,
          'bad_mention',
        );
      }
    }

    const members = new Map<string, { id: string; name: string }>();
    for (const [, id, embeddedName] of tokens) {
      if (members.has(id)) continue;
      try {
        const member = await app.api.conversations.getMemberById(target.conversationId, id);
        members.set(id, { id: member.id, name: member.name.replace(/[<>]/g, '') });
      } catch (error: unknown) {
        if (errorStatus(error) !== 404) throw error;
        throw new SendRefusedError(
          `${embeddedName || id} (<@${id}>) is not a member of ${describeTarget(target)}, so the message was not sent. Mention only people in that conversation.`,
          'not_member',
        );
      }
    }

    // An `<at>` tag the agent wrote has no entity behind it, so it is removed.
    const body = text
      .replace(/<\/?at\b[^>]*>/gi, '')
      .replace(MENTION_TOKEN, (_token, id: string) => `<at>${members.get(id)?.name}</at>`);
    const activity = new MessageActivityInput(body);
    for (const member of members.values()) {
      activity.addMention({ id: member.id, name: member.name, role: 'user' }, { addText: false, text: member.name });
    }
    return activity;
  }

  // ============================================================================
  // Inbound message handling
  // ============================================================================

  /**
   * The real work behind an inbound activity — runs after the webhook turn has
   * already been acknowledged.
   */
  private async processMessage(
    activity: IMessageActivity,
    signalWork: () => Promise<void>
  ): Promise<void> {
    const conversationType = activity.conversation?.conversationType;
    if (conversationType === 'personal') {
      await this.handleDmMessage(activity, signalWork);
      return;
    }
    // The message handler already returns for any conversation type other than
    // personal or channel, so there is no other case to handle here.
    await this.handleChannelMessage(activity, signalWork);
  }

  private async handleDmMessage(
    activity: IMessageActivity,
    signalWork: () => Promise<void>
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) return;

    const conversationId = activity.conversation.id;
    const teamsUserId = activity.from.aadObjectId ?? activity.from.id;
    const text = this.extractText(activity);
    if (!text && !activity.attachments?.length) return;
    await signalWork();

    // Verification-code fast path (same 6-hex flow as Slack).
    if (this.isVerificationCode(text)) {
      const result = await this.verifyDmLinkCode(text, teamsUserId, conversationId);
      await this.sendChunks(conversationId, undefined, [
        result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
      ]);
      return;
    }

    const mapping = await teamsMappingService.findUserMapping(connection.id, teamsUserId);
    if (!mapping?.lensUserId) {
      await this.sendChunks(conversationId, undefined, [
        "Hi! I don't recognize this Microsoft Teams account yet. Open the Lens Agents web app → " +
          'Channels → Microsoft Teams, generate a link code, and send the 6-character code to me here.',
      ]);
      return;
    }

    // Self-heal the proactive-send target if the conversation id drifted (and
    // capture it for rows linked before their first DM).
    if (mapping.dmConversationId !== conversationId) {
      await teamsMappingService.updateDmConversationId(mapping.id, conversationId);
    }

    // Personal chats are keyed by their conversation id, DATABASE-sourced —
    // Teams pushes every activity, so no live thread provider is needed.
    const thread = await conversationService.getOrCreateThreadByExternalId(
      mapping.lensUserId,
      mapping.agentId,
      conversationId
    );

    const files = await this.readFiles(activity, thread.id);
    const message = text || (files.names.length > 0 ? describeSharedFiles(files.names) : '');
    if (!message) return;

    await conversationEngineService.chat({
      userId: mapping.lensUserId,
      agentId: mapping.agentId,
      threadId: thread.id,
      message,
      metadata: { channel: 'teams' },
      ...this.fileTurnInput(files),
    });
  }

  private async handleChannelMessage(
    activity: IMessageActivity,
    signalWork: () => Promise<void>
  ): Promise<void> {
    if (!this.connection) return;

    // A channel activity's conversation id carries the thread root as a
    // ";messageid=" suffix. Strip it for mapping storage/lookup; keep the root
    // id for threaded replies. A top-level post is its own root.
    // `||` (not `??`): a malformed trailing suffix splits to '', which must
    // fall through to the activity id.
    const [channelConversationId, rootFromConversation] =
      activity.conversation.id.split(';messageid=');
    const rootMessageId = rootFromConversation || activity.id;

    const text = this.extractText(activity);
    if (!text && !activity.attachments?.length) return;

    // With the channel-message permission Teams delivers every message in the
    // team, not only the ones that mention the bot.
    if (!this.mentionsBot(activity)) {
      if (!text) return;
      await this.handleUnmentionedReply(activity, channelConversationId, rootMessageId, text, signalWork);
      return;
    }
    await signalWork();

    // Verification-code fast path — link this channel.
    if (this.isVerificationCode(text)) {
      const channelName = await this.resolveChannelName(activity, channelConversationId);
      const result = await this.verifyChannelLinkCode(text, channelConversationId, channelName);
      await this.sendChunks(channelConversationId, rootMessageId, [
        result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
      ]);
      return;
    }

    const mapping = await teamsMappingService.findByConversationId(channelConversationId);
    if (!mapping?.lensUserId) {
      await this.sendChunks(channelConversationId, rootMessageId, [
        "This channel isn't linked to an agent yet. Open the Lens Agents web app → Channels → " +
          'Microsoft Teams, generate a channel link code, and @mention me with the 6-character code.',
      ]);
      return;
    }

    await this.runChannelTurn(
      { lensUserId: mapping.lensUserId, agentId: mapping.agentId, channelName: mapping.channelName },
      activity,
      channelConversationId,
      rootMessageId,
      text
    );
  }

  /**
   * A message that does not mention the bot gets an answer only when it is a
   * reply in a linked channel's reply chain the bot has answered in, and the
   * thread classifier finds it asks the bot for something. A reply in such a
   * chain that gets no answer is stored in the thread, so the next turn and
   * the next classification read it. Replies under the bot's own top-level
   * posts (heartbeat and scheduled-task output) have no thread to find, so
   * they need a mention.
   */
  private async handleUnmentionedReply(
    activity: IMessageActivity,
    channelConversationId: string,
    rootMessageId: string,
    text: string,
    signalWork: () => Promise<void>
  ): Promise<void> {
    if (rootMessageId === activity.id) return;

    const mapping = await teamsMappingService.findByConversationId(channelConversationId);
    if (!mapping?.lensUserId) return;
    const thread = await conversationService.findThreadByExternalId(
      mapping.lensUserId,
      mapping.agentId,
      `${channelConversationId};messageid=${rootMessageId}`
    );
    if (!thread) return;

    const sender = this.sender(activity);
    // A reply that mentions somebody is addressed to them.
    const action = this.mentionsAnyone(activity)
      ? 'ignore'
      : (await this.classifyReply(thread.id, mapping.agentId, sender, text)).action;

    if (action === 'respond') {
      await signalWork();
      await this.runChannelTurn(
        { lensUserId: mapping.lensUserId, agentId: mapping.agentId, channelName: mapping.channelName },
        activity,
        channelConversationId,
        rootMessageId,
        text
      );
      return;
    }

    // This stores the reply directly rather than through chat()/claimOrOffer: it
    // is history for the next turn and the next classification to read, not a
    // turn of its own. If a turn claims this thread at this moment the running
    // turn does not see the reply, and the stored order can be USER, USER,
    // AGENT — which the provider accepts, since it merges consecutive user turns.
    await conversationService.addMessage(thread.id, {
      role: 'USER',
      content: this.buildSenderTaggedContent(sender.id, sender.name, text),
      triggeredBy: 'USER_INPUT',
      senderExternalId: sender.id,
      senderName: sender.name,
    });
  }

  /** The reply chain's stored history plus the arriving reply, for the classifier. */
  private async classifyReply(
    threadId: string,
    agentId: string,
    sender: { id: string; name?: string },
    text: string
  ): Promise<ThreadAction> {
    const history = await conversationService.getRecentMessages(threadId, THREAD_TRANSCRIPT_LINES - 1);
    const lines: ThreadLine[] = history
      .filter((m) => m.role === 'USER' || m.role === 'AGENT')
      .map((m) => ({
        fromBot: m.role === 'AGENT',
        author: m.senderName ?? m.senderExternalId ?? 'unknown',
        text: m.role === 'USER' ? this.stripSenderTag(m.content) : m.content,
      }));
    lines.push({ fromBot: false, author: sender.name ?? sender.id, text });
    return threadReplyClassifierService.classify({
      platform: { channel: this.name, name: 'Microsoft Teams' },
      agentId,
      lines,
    });
  }

  /** One turn in the reply chain rooted at `rootMessageId`. */
  private async runChannelTurn(
    mapping: { lensUserId: string; agentId: string; channelName: string | null },
    activity: IMessageActivity,
    channelConversationId: string,
    rootMessageId: string,
    text: string
  ): Promise<void> {
    const sender = this.sender(activity);

    // One conversation thread per Teams reply chain, keyed by the threaded
    // conversation id. DATABASE-sourced (no live provider in v1).
    const thread = await conversationService.getOrCreateThreadByExternalId(
      mapping.lensUserId,
      mapping.agentId,
      `${channelConversationId};messageid=${rootMessageId}`
    );

    const files = await this.readFiles(activity, thread.id);
    const message = text || (files.names.length > 0 ? describeSharedFiles(files.names) : '');
    if (!message) return;

    await conversationEngineService.chat({
      userId: mapping.lensUserId,
      agentId: mapping.agentId,
      threadId: thread.id,
      message: this.buildSenderTaggedContent(sender.id, sender.name, message),
      ...this.fileTurnInput(files),
      metadata: {
        channel: 'teams',
        channelId: channelConversationId,
        channelThreadId: rootMessageId,
        channelLabel: teamsChannelLabel(mapping.channelName ?? channelConversationId),
        senderExternalId: sender.id,
        senderName: sender.name,
      },
    });
  }

  /**
   * A channel message names the channel only sometimes, so the team's channel
   * list is the source. That list shows the General channel, whose id is the
   * team's id, without a name. A failed lookup links the channel unnamed.
   */
  private async resolveChannelName(
    activity: IMessageActivity,
    channelConversationId: string
  ): Promise<string | undefined> {
    const named = activity.channelData?.channel?.name;
    if (named) return named;
    const teamId = activity.channelData?.team?.id;
    if (!teamId || !this.app) return undefined;
    try {
      const channels = await this.app.api.teams.getConversations(teamId);
      const channel = channels.find((c) => c.id === channelConversationId);
      return channel?.name ?? (channelConversationId === teamId ? 'General' : undefined);
    } catch (error: unknown) {
      logger.warn({ err: error }, '[TeamsAdapter] channel name lookup failed; linking the channel unnamed');
      return undefined;
    }
  }

  // ============================================================================
  // Verification codes
  // ============================================================================

  private isVerificationCode(text: string): boolean {
    return /^[A-Fa-f0-9]{6}$/.test(text?.trim() || '');
  }

  private async verifyDmLinkCode(
    code: string,
    teamsUserId: string,
    dmConversationId: string
  ): Promise<{ success: boolean; message: string }> {
    const upperCode = code.toUpperCase();
    const verification = await prisma.teamsVerificationCode.findUnique({
      where: { code_type: { code: upperCode, type: 'DM' } },
    });

    if (!verification) {
      return { success: false, message: 'Invalid code. Please generate a new code from the Lens Agents web app.' };
    }

    if (new Date() > verification.expiresAt) {
      await prisma.teamsVerificationCode
        .delete({ where: { code_type: { code: upperCode, type: 'DM' } } })
        .catch(() => {});
      return { success: false, message: 'Code expired. Please generate a new code from the Lens Agents web app.' };
    }

    const existingLink = await prisma.teamsMapping.findFirst({
      where: { connectionId: verification.connectionId, teamsUserId },
    });
    if (existingLink) {
      if (existingLink.lensUserId === verification.lensUserId) {
        return {
          success: false,
          message: "Your Teams account is already linked to another agent. Unlink it first from that agent's settings.",
        };
      }
      return { success: false, message: 'This Teams account is already linked to another Lens Platform user.' };
    }

    // Personal and Team mode are mutually exclusive per agent (docs/teams.md):
    // a channel-linked agent cannot also take a personal link.
    const channelLink = await prisma.teamsMapping.findFirst({
      where: { agentId: verification.agentId, channelConversationId: { not: null } },
    });
    if (channelLink) {
      return {
        success: false,
        message: 'This agent is linked to one or more channels. Unlink those channels before linking a personal chat.',
      };
    }

    // Atomic: create mapping + consume code. The conversation id is captured
    // in the same transaction — it is what makes proactive DM sends possible.
    await prisma.$transaction([
      prisma.teamsMapping.create({
        data: {
          connectionId: verification.connectionId,
          agentId: verification.agentId,
          teamsUserId,
          lensUserId: verification.lensUserId,
          dmConversationId,
          tenantId: this.connection?.tenantId,
        },
      }),
      prisma.teamsVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }),
    ]);

    logger.info('Teams account linked via code: %s -> %s', teamsUserId, verification.lensUserId);
    trackEvent('teams dm linked', verification.lensUserId, {
      'agent.id': verification.agentId,
    });

    return {
      success: true,
      message: 'Your Teams account is now linked to Lens Platform! You can now chat with your agent here.',
    };
  }

  private async verifyChannelLinkCode(
    code: string,
    channelConversationId: string,
    channelName?: string
  ): Promise<{ success: boolean; message: string; agentName?: string }> {
    const upperCode = code.toUpperCase();
    const verification = await prisma.teamsVerificationCode.findUnique({
      where: { code_type: { code: upperCode, type: 'CHANNEL' } },
    });

    if (!verification) {
      return { success: false, message: 'Invalid code. Please generate a new code from the Lens Agents web app.' };
    }

    if (new Date() > verification.expiresAt) {
      await prisma.teamsVerificationCode
        .delete({ where: { code_type: { code: upperCode, type: 'CHANNEL' } } })
        .catch(() => {});
      return { success: false, message: 'Code expired. Please generate a new code from the Lens Agents web app.' };
    }

    const existing = await prisma.teamsMapping.findUnique({
      where: { channelConversationId },
    });
    if (existing) {
      return { success: false, message: 'This channel is already linked to an agent.' };
    }

    // Personal and Team mode are mutually exclusive per agent (docs/teams.md):
    // a personally-linked agent cannot also take a channel link.
    const dmLink = await prisma.teamsMapping.findFirst({
      where: { agentId: verification.agentId, dmConversationId: { not: null } },
    });
    if (dmLink) {
      return {
        success: false,
        message: 'This agent is linked to a personal chat. Unlink that personal chat before linking a channel.',
      };
    }

    await prisma.$transaction([
      prisma.teamsMapping.create({
        data: {
          connectionId: verification.connectionId,
          agentId: verification.agentId,
          channelConversationId,
          channelName: channelName ?? null,
          lensUserId: verification.lensUserId,
          teamsUserId: null,
          dmConversationId: null,
          tenantId: this.connection?.tenantId,
        },
      }),
      prisma.teamsVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'CHANNEL' } },
      }),
    ]);

    logger.info(
      "Teams channel linked via code: %s -> %s's agent",
      channelConversationId,
      verification.lensUserId
    );
    trackEvent('teams channel linked', verification.lensUserId, {
      'agent.id': verification.agentId,
    });

    return {
      success: true,
      message: `Channel linked to ${verification.agentName ?? 'your agent'}! Mention me anytime you need help.`,
      agentName: verification.agentName ?? undefined,
    };
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Inbound text. From `text` when present: the bot's own `<at>…</at>` mention
   * removed entirely, other participants' names kept as plain text. When `text`
   * is empty — a pasted or formatted message, whose body Teams puts only in a
   * `text/html` attachment — from that attachment instead, so a pasted
   * verification code is read like a typed one.
   */
  private extractText(activity: IMessageActivity): string {
    const withoutBotMention = this.botAccountId
      ? stripMentionsText(activity, { accountId: this.botAccountId })
      : activity.text;
    const text = (withoutBotMention ?? '').replace(/<\/?at[^>]*>/g, '').trim();
    if (text) return text;
    // A pasted or formatted message can arrive with an empty `text` and its body
    // only in a text/html attachment (`<p>…</p>`). Read it so a pasted
    // verification code is recognised the same as a typed one.
    return this.htmlAttachmentText(activity);
  }

  /**
   * The text of a message's `text/html` attachment; empty when there is none.
   * A pasted message carries its body here with `text` empty. The bot's own
   * mention is removed whole (found through the mention entities that name it),
   * so it does not prepend the bot's name and break a pasted code; other
   * participants' mention tags are stripped but their names kept, as the `text`
   * path does. Inline formatting is removed with no separator, so a code split
   * across it (`a1<strong>b2</strong>c3`) rejoins; `<br>` and closing block tags
   * become newlines, and only spaces and tabs are collapsed, so a multi-line
   * paste keeps its lines.
   */
  private htmlAttachmentText(activity: IMessageActivity): string {
    const html = activity.attachments?.find(
      (a) => a.contentType === 'text/html' && typeof a.content === 'string'
    )?.content;
    if (!html) return '';
    return this.dropBotMentions(html, activity)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|h[1-6]|pre|blockquote)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (m: string, d: string) => {
        const n = Number(d);
        return n <= 0x10ffff ? String.fromCodePoint(n) : m;
      })
      .replace(/&#x([0-9a-f]+);/gi, (m: string, h: string) => {
        const n = parseInt(h, 16);
        return n <= 0x10ffff ? String.fromCodePoint(n) : m;
      })
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /**
   * Remove the bot's own `<at>…</at>` mention elements from HTML, found through
   * the mention entities whose account is the bot. Other mentions are left for
   * the general tag strip, which keeps their names.
   */
  private dropBotMentions(html: string, activity: IMessageActivity): string {
    if (!this.botAccountId) return html;
    let out = html;
    for (const entity of activity.entities ?? []) {
      const mention = entity as { type?: string; mentioned?: { id?: string; name?: string } };
      if (mention.type !== 'mention' || mention.mentioned?.id !== this.botAccountId) continue;
      const name = mention.mentioned.name;
      if (!name) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`<at\\b[^>]*>\\s*${escaped}\\s*</at>`, 'gi'), '');
    }
    return out;
  }

  /** Read the message's files; a read that fails becomes a failure, never a throw. */
  private readFiles(activity: IMessageActivity, threadId: string): Promise<TeamsInboundFiles> {
    const app = this.app;
    if (!app || !activity.attachments?.length) {
      return Promise.resolve({ attachmentIds: [], failures: [], names: [] });
    }
    const get = async (client: typeof app.api.http, url: string): Promise<Buffer> => {
      try {
        const res = await client.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
          maxContentLength: MAX_FILE_SIZE_BYTES,
          timeout: FILE_DOWNLOAD_TIMEOUT_MS,
        });
        return Buffer.from(res.data);
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith('maxContentLength size of')) {
          throw new TeamsFileTooLargeError();
        }
        throw error;
      }
    };
    return readInboundFiles(
      activity.attachments,
      {
        bot: (url) => get(app.api.http, url),
        graph: (url) => get(app.graph.http, url),
        plain: (url) => this.fetchPlain(url),
      },
      { threadId }
    );
  }

  /** GET a pre-authenticated URL: no credential, through the runtime's proxy when one is set. */
  private async fetchPlain(url: string): Promise<Buffer> {
    // Loose shape: `dispatcher` is an undici extension to fetch's init.
    const init: Record<string, unknown> = { signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS) };
    const dispatcher = await getProxyDispatcher();
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await fetch(url, init as RequestInit);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { response: { status: res.status } });
    if (Number(res.headers.get('content-length') ?? 0) > MAX_FILE_SIZE_BYTES) {
      throw new TeamsFileTooLargeError();
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** The chat() fields a message's files add: the stored ids and a notice for failures. */
  private fileTurnInput(files: TeamsInboundFiles): { attachmentIds?: string[]; runtimeNotices?: string[] } {
    return {
      ...(files.attachmentIds.length > 0 ? { attachmentIds: files.attachmentIds } : {}),
      ...(files.failures.length > 0 ? { runtimeNotices: [buildFileFailureNotice(files.failures)] } : {}),
    };
  }

  /** Whether a mention entity names this bot. */
  private mentionsBot(activity: IMessageActivity): boolean {
    return (activity.entities ?? []).some(
      (entity) => entity.type === 'mention' && entity.mentioned?.id === activity.recipient.id
    );
  }

  private mentionsAnyone(activity: IMessageActivity): boolean {
    return (activity.entities ?? []).some((entity) => entity.type === 'mention');
  }

  /** The AAD object id when Teams sends one, else the Bot Framework id. */
  private sender(activity: IMessageActivity): { id: string; name?: string } {
    return { id: activity.from.aadObjectId ?? activity.from.id, name: activity.from.name };
  }

  /** The text of a stored channel message without its `buildSenderTaggedContent` prefix. */
  private stripSenderTag(content: string): string {
    return content.replace(/^<@[^>]*>: /, '');
  }

  /**
   * Prefix channel messages with the sender so a multi-user history stays
   * attributable — same `<@ID:Name>: text` shape the Slack adapter uses.
   */
  private buildSenderTaggedContent(
    teamsUserId: string,
    senderName: string | undefined,
    text: string
  ): string {
    if (!senderName) return text;
    const sanitized = senderName.replace(/[<>:\x00-\x1f]/g, '').trim();
    const tag = sanitized ? `<@${teamsUserId}:${sanitized}>` : `<@${teamsUserId}>`;
    return `${tag}: ${text}`;
  }

  /**
   * A bot has no upload into a Teams channel, so each shared file is a link to
   * the runtime's download route: at the public address when the runtime has
   * one, else at this machine's own port, where a local install's browser runs.
   * A container published on another host port needs `PRISM_PUBLIC_URL`.
   */
  private withAttachmentNotice(content: string, attachments?: AttachmentMeta[]): string {
    if (!attachments || attachments.length === 0) return content;
    const origin = config.publicUrl ?? `http://localhost:${config.port}`;
    const links = attachments
      .map((a) => `[${a.filename.replace(/[[\]]/g, '')}](${origin}/agents/attachments/${encodeURIComponent(a.id)})`)
      .join(', ');
    return `${content}\n\n📎 Shared file${attachments.length > 1 ? 's' : ''}: ${links}`;
  }

  /**
   * Send chunks sequentially to one conversation — threaded when a root
   * message id is given. Retries 429s honoring Retry-After. Logs, never
   * throws: the message is already persisted.
   */
  private async sendChunks(
    conversationId: string,
    rootMessageId: string | undefined,
    chunks: string[]
  ): Promise<boolean> {
    const app = this.app;
    if (!app) return false;
    for (const chunk of chunks) {
      try {
        await this.sendWithRetry(() =>
          rootMessageId
            ? app.reply(conversationId, rootMessageId, new MessageActivityInput(chunk))
            : app.send(conversationId, new MessageActivityInput(chunk))
        );
      } catch (error: unknown) {
        logger.error({ err: error, conversationId }, '[TeamsAdapter] send failed');
        trackEvent('teams message send failed', null, {
          ...(config.agentId ? { 'agent.id': config.agentId } : {}),
          ...errorShape(error),
        });
        return false; // remaining chunks of a failed message would arrive out of order
      }
    }
    return true;
  }

  private async sendWithRetry<T>(send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send();
      } catch (error: unknown) {
        if (errorStatus(error) !== 429 || attempt >= SEND_RETRIES) throw error;
        const delay = retryAfterMs(error) ?? 1000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}

// Export singleton instance
export const teamsAdapterService = new TeamsAdapterService();
