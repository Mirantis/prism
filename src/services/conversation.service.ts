/**
 * Conversation Service
 *
 * Manages conversation threads and messages for the personal agent.
 * Handles thread creation, message persistence, and retrieval.
 */

import {
  ConversationThread,
  ConversationMessage,
  MessageRole,
  MessageTrigger,
  ThreadSource,
  Prisma,
} from '@prisma/client';
import { EventEmitter } from 'node:events';
import prisma from '../lib/prisma';
import { config } from '../config';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { deriveThreadTitle } from '../utils/thread-title';
import { agentMessageKind } from '../lib/agent-message-kind';
import type { AgentMessageKind } from '../protocol/chat-protocol';
import { ThreadMessageProvider } from './thread-provider.interface';
import { DatabaseThreadProvider } from './providers/database-thread.provider';
import { attachmentService, type AttachmentMeta } from './attachment.service';
import { runtimeStateService, SINGLE_THREAD } from './runtime-state.service';
// The pure derivation, not contextUsageService — that service imports this
// module, so depending on it here would be a cycle.
import { buildContextSnapshot, type ContextUsageSnapshot } from '../lib/context-window';
/** A message a compaction summary replaced, as the history tool reads it. */
export type CompactedMessage = Pick<ConversationMessage, 'role' | 'content' | 'toolCalls' | 'internalStep' | 'createdAt'>;

const COMPACTED_SEARCH_BATCH = 200;

// ============================================================================
// Types
// ============================================================================

export interface MessageInput {
  /**
   * The row's id, when the sender chose it. A chat client names its message so a
   * resend after a dropped connection finds the row it already wrote instead of
   * writing a second one. Omitted, the database mints one.
   */
  id?: string;
  content: string;
  role: MessageRole;
  triggeredBy: MessageTrigger;
  /**
   * The webhook subscription that produced a WEBHOOK message, or the kind of an
   * AGENT_MESSAGE, for the model's history.
   */
  triggerName?: string;
  toolCalls?: unknown[];
  blocks?: unknown[];
  // Multi-user context (for channel messages)
  senderExternalId?: string; // The sender's id in the channel the message came from
  senderName?: string; // Human-readable display name
  /** The id the message has outside this database, such as another agent's message id. */
  externalMessageId?: string;
  /**
   * Marks a row the runtime wrote for the model, never for the reader.
   *
   * **An internal row is never shown to the end user.** Every client history read
   * asks for `view: 'client'`, and both thread providers answer that with
   * `internalStep: false` in the WHERE clause — so every client and channel
   * omit it, while the model-context read replays it. It also never names a thread,
   * and it is reported separately in `message added` telemetry so it cannot be
   * counted as something a user sent.
   *
   * Two writers today: concise mode's intermediate steps, and a turn's recalled
   * memories. Omit (or false) for a normal, user-visible message.
   */
  internalStep?: boolean;
}

/** One page of a thread's client history: `limit` messages, the newest ones or those before `before`. */
export interface MessagePage {
  limit: number;
  /** A message id; the page ends just before it. */
  before?: string;
}

/** A web thread came into being — emitted as `'thread'` on `conversationService.events`. */
export interface ThreadCreated {
  userId: string;
  threadId: string;
  title: string | null;
  createdAt: Date;
}

/**
 * A client's copy of a stored message names its sender as the chat socket's
 * `message` event does, so history and live messages have one shape: a client
 * that tells its own messages from others' by `senderId`, or labels another
 * agent's by `agentMessageKind`, must find them on both.
 */
function withSender<T extends ConversationMessage>(
  message: T,
): T & { senderId: string | null; agentMessageKind: AgentMessageKind | null } {
  return { ...message, senderId: message.senderExternalId ?? null, agentMessageKind: agentMessageKind(message) };
}

export interface MessageWithAttachments extends ConversationMessage {
  attachments?: AttachmentMeta[];
}

export interface ThreadWithMessages extends ConversationThread {
  messages: MessageWithAttachments[];
  /**
   * Context occupancy derived from the thread's stored snapshot, so a reload
   * restores the context-window indicator without waiting for the next turn.
   * Null before the thread's first turn, or when `contextModel`'s window is
   * unknown.
   */
  contextUsage: ContextUsageSnapshot | null;
}

// ============================================================================
// Conversation Service
// ============================================================================

class ConversationService {
  /** Emits `'thread'` ({@link ThreadCreated}) when a web thread is created. */
  readonly events = new EventEmitter();
  private databaseProvider = new DatabaseThreadProvider();
  private liveProviders = new Map<ThreadSource, ThreadMessageProvider>();

  /**
   * Single-thread mode's one conversation, stored under `SINGLE_THREAD` so no later
   * write moves it. With none stored, or once its thread is gone, it is the web thread
   * the person wrote in last, else the newest web thread. A daily session reset in
   * multi-thread mode leaves an empty newest thread, which must not hide the
   * conversation the person had.
   */
  private async singleThread(agentId: string, userId: string): Promise<ConversationThread | null> {
    const storedId = await runtimeStateService.get(SINGLE_THREAD);
    const stored = storedId
      ? await prisma.conversationThread.findFirst({ where: { id: storedId, agentId, userId, externalThreadId: null } })
      : null;
    if (stored) return stored;

    const lastWritten = await prisma.conversationMessage.findFirst({
      where: {
        role: MessageRole.USER,
        triggeredBy: MessageTrigger.USER_INPUT,
        internalStep: false,
        thread: { agentId, userId, externalThreadId: null },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { thread: true },
    });
    const chosen = lastWritten?.thread ?? (await this.newestWebThread(agentId, userId));
    if (chosen) await runtimeStateService.set(SINGLE_THREAD, chosen.id);
    return chosen;
  }

  /**
   * Forget single-thread mode's conversation, so the next single-thread boot keeps the
   * conversation the person wrote in last rather than the one it kept before.
   */
  async forgetSingleThread(): Promise<void> {
    await runtimeStateService.delete(SINGLE_THREAD);
  }

  /**
   * The thread a run or a chat turn that names `threadId` writes to. In single-thread
   * mode another web thread resolves to the one conversation, so a task or goal bound
   * to an older conversation answers where every client shows it.
   */
  async writableThreadId(threadId: string): Promise<string> {
    if (config.threadMode !== 'single') return threadId;
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { agentId: true, userId: true, externalThreadId: true },
    });
    if (!thread || thread.externalThreadId !== null) return threadId;
    return (await this.getOrCreateLatestThread(thread.agentId, thread.userId)).id;
  }

  private newestWebThread(agentId: string, userId: string): Promise<ConversationThread | null> {
    return prisma.conversationThread.findFirst({
      where: { agentId, userId, externalThreadId: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The threads a client may list, read or write to. In single-thread mode that is
   * the one conversation and the channel threads; every other web thread stays in
   * the database for when the agent runs in multi-thread mode again.
   */
  async clientThreadFilter(agentId: string, userId: string): Promise<Prisma.ConversationThreadWhereInput> {
    if (config.threadMode !== 'single') return {};
    const conversation = await this.singleThread(agentId, userId);
    return { OR: [{ externalThreadId: { not: null } }, { id: conversation?.id ?? '' }] };
  }

  /** Serve every thread of `source` from `provider`, which reads the channel live. */
  registerThreadProvider(source: ThreadSource, provider: ThreadMessageProvider): void {
    this.liveProviders.set(source, provider);
  }

  private providerFor(source: ThreadSource | undefined): ThreadMessageProvider {
    return (source && this.liveProviders.get(source)) || this.databaseProvider;
  }

  /**
   * Resolve the message provider for a thread based on its threadSource.
   */
  private async resolveProvider(threadId: string): Promise<ThreadMessageProvider> {
    return this.providerFor(await this.getThreadSource(threadId));
  }

  /** Where a thread's messages are read from, or undefined for a thread that does not exist. */
  async getThreadSource(threadId: string): Promise<ThreadSource | undefined> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { threadSource: true },
    });
    return thread?.threadSource;
  }

  /**
   * Get or create the latest database conversation thread for a user.
   *
   * There is no "active" flag — the runtime uses the most recently created
   * web thread, or the one conversation in single-thread mode (see
   * findLatestWebThread). Channel threads (externalThreadId set) are excluded; those are
   * resolved via getOrCreateThreadByExternalId. Creates a fresh thread when the
   * user has none yet.
   */
  async getOrCreateLatestThread(agentId: string, userId: string): Promise<ConversationThread> {
    let thread = await this.findLatestWebThread(agentId, userId);

    if (!thread) {
      thread = await prisma.conversationThread.create({
        data: { agentId, userId },
      });
      logger.info('Created new conversation thread for user %s (threadId: %s)', userId, thread.id);
      trackEvent('thread created', userId, {
        'agent.id': agentId,
        'thread.id': thread.id,
        'thread.source': 'database',
      });
      this.announceThread(thread);
    }

    return thread;
  }

  /**
   * The user's latest web thread, or null when there is none. Creates nothing.
   * In single-thread mode it is the one conversation.
   */
  async findLatestWebThread(agentId: string, userId: string): Promise<ConversationThread | null> {
    if (config.threadMode === 'single') return this.singleThread(agentId, userId);
    return this.newestWebThread(agentId, userId);
  }

  /**
   * Say that a web thread exists, so every open client can list it — a
   * conversation started on one device shows up on the others without a reload.
   * Channel-agnostic, like `threadTitleService`: transports subscribe.
   */
  private announceThread(thread: ConversationThread): void {
    this.events.emit('thread', {
      userId: thread.userId,
      threadId: thread.id,
      title: thread.title,
      createdAt: thread.createdAt,
    } satisfies ThreadCreated);
  }

  /**
   * Create a brand-new database conversation thread. Used when the CLI opens or
   * a session resets so the conversation starts fresh — the newly created thread
   * becomes the latest (see getOrCreateLatestThread), so no archiving is needed.
   *
   * `options.workspaceRoot` optionally records the working directory this
   * conversation is rooted in (e.g. the CLI's launch cwd). It's persisted once
   * here and never changed; shell tools later use it as their cwd. Empty /
   * whitespace-only values are ignored.
   *
   * In single-thread mode it creates nothing and returns the one conversation,
   * whose workspace root stays the one it was created with.
   */
  async startNewThread(
    agentId: string,
    userId: string,
    options?: { workspaceRoot?: string },
  ): Promise<ConversationThread> {
    if (config.threadMode === 'single') return this.getOrCreateLatestThread(agentId, userId);
    const workspaceRoot = options?.workspaceRoot?.trim();
    const thread = await prisma.conversationThread.create({
      data: {
        agentId,
        userId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    });
    logger.info('Started new conversation thread for user %s (threadId: %s)', userId, thread.id);
    trackEvent('thread created', userId, {
      'agent.id': agentId,
      'thread.id': thread.id,
      'thread.source': 'database',
    });
    this.announceThread(thread);

    return thread;
  }

  /**
   * Start a fresh conversation, reusing the newest thread when it is still
   * untouched (zero messages) so repeated "new conversation" clicks don't pile
   * up empty threads. Threads rooted in a workspace are never reused — the CLI
   * creates one (with a workspaceRoot) on every launch, and handing that
   * session's thread to the web would make them share it.
   *
   * In single-thread mode it returns the one conversation.
   */
  async getOrCreateFreshThread(agentId: string, userId: string): Promise<ConversationThread> {
    if (config.threadMode === 'single') return this.getOrCreateLatestThread(agentId, userId);
    const newest = await prisma.conversationThread.findFirst({
      where: {
        agentId,
        userId,
        externalThreadId: null,
        threadSource: ThreadSource.DATABASE,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Counted separately rather than via `include: { _count: … }` on the query
    // above: that would attach a `_count` field to the returned row, so a reused
    // thread and a newly created one would serialize to different shapes.
    if (newest && !newest.workspaceRoot) {
      const messageCount = await prisma.conversationMessage.count({
        where: { threadId: newest.id },
      });
      if (messageCount === 0) return newest;
    }

    return this.startNewThread(agentId, userId);
  }

  /**
   * Read a thread's persisted workspace root (the directory it's rooted in),
   * or null if unset. Used by the conversation engine to scope shell tools to
   * the thread's workspace when one was recorded at creation.
   */
  async getThreadWorkspaceRoot(threadId: string): Promise<string | null> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { workspaceRoot: true },
    });
    return thread?.workspaceRoot ?? null;
  }

  /**
   * Get or create a conversation thread bound to a specific external thread ID,
   * for a channel where each of its threads maps to its own conversation.
   * `live` marks a thread whose history the channel keeps: it is read through
   * the provider registered for `live.source`.
   */
  async getOrCreateThreadByExternalId(
    userId: string,
    agentId: string,
    externalThreadId: string,
    live?: { source: ThreadSource; channelId: string },
  ): Promise<ConversationThread> {
    const liveFields = live && { threadSource: live.source, externalChannelId: live.channelId };
    const thread = await prisma.conversationThread.upsert({
      where: {
        agentId_userId_externalThreadId: { agentId, userId, externalThreadId },
      },
      create: { agentId, userId, externalThreadId, ...liveFields },
      // Update the channel id if provided (in case it was missing before)
      update: { ...liveFields },
    });

    // Upsert can't report create-vs-update; on create both timestamps carry
    // the same initial value, while the update path bumps @updatedAt.
    if (
      thread?.createdAt instanceof Date &&
      thread.updatedAt instanceof Date &&
      thread.createdAt.getTime() === thread.updatedAt.getTime()
    ) {
      trackEvent('thread created', userId, {
        'agent.id': agentId,
        'thread.id': thread.id,
        'thread.source': (live?.source ?? ThreadSource.DATABASE).toLowerCase(),
      });
    }

    return thread;
  }

  /** The thread bound to an external thread ID, without creating one. */
  async findThreadByExternalId(
    userId: string,
    agentId: string,
    externalThreadId: string,
  ): Promise<ConversationThread | null> {
    return prisma.conversationThread.findUnique({
      where: {
        agentId_userId_externalThreadId: { agentId, userId, externalThreadId },
      },
    });
  }

  /**
   * Get a thread by ID (with ownership check). With `page`, it holds that page of
   * messages instead of the whole history.
   */
  async getThread(
    userId: string,
    agentId: string,
    threadId: string,
    page?: MessagePage,
  ): Promise<ThreadWithMessages | null> {
    const thread = await prisma.conversationThread.findFirst({
      where: {
        id: threadId,
        agentId,
        userId,
        ...(await this.clientThreadFilter(agentId, userId)),
      },
    });

    if (!thread) return null;

    const provider = this.providerFor(thread.threadSource);

    // CLIENT history (web SPA): hide concise-mode internal steps. The model path
    // (getThreadContext) reads without this option so it still replays them.
    const read = page
      ? await provider.getRecentMessages(threadId, page.limit, { view: 'client', before: page.before })
      : await provider.getMessages(threadId, { view: 'client' });
    const messages = await this.withHiddenStepToolCalls(threadId, read);

    // Attach file metadata (no bytes) so the web UI renders chips on history.
    const withAttachments: MessageWithAttachments[] =
      await attachmentService.attachMetaToMessages(messages);

    // Derived here rather than in each client: the percentage needs the model's
    // context window, which only the runtime has (the models.dev catalog isn't
    // importable from the web/cli workspaces). Null until the thread's first turn
    // completes, or when the stored model is unrecognized.
    const contextUsage = buildContextSnapshot(threadId, thread.contextModel, thread.contextTokens);

    return { ...thread, messages: withAttachments.map(withSender), contextUsage };
  }

  /**
   * Lightweight ownership/existence check: returns the thread id when it
   * belongs to this agent+user, else null. Unlike getThread it does NOT load
   * the thread's messages or attachment metadata, so callers that only need to
   * authorize a thread id (e.g. the CLI's /messages replay) stay cheap.
   */
  async getOwnedThreadId(userId: string, agentId: string, threadId: string): Promise<string | null> {
    const thread = await prisma.conversationThread.findFirst({
      where: { id: threadId, agentId, userId, ...(await this.clientThreadFilter(agentId, userId)) },
      select: { id: true },
    });
    return thread?.id ?? null;
  }

  /**
   * List all threads for a user
   */
  async listThreads(
    userId: string,
    agentId: string,
    options?: { limit?: number; threadSource?: ThreadSource }
  ): Promise<ConversationThread[]> {
    return prisma.conversationThread.findMany({
      where: {
        agentId,
        userId,
        ...(await this.clientThreadFilter(agentId, userId)),
        // The DATABASE set is the web/CLI-resumable one. Genuine web/CLI threads
        // are always created with externalThreadId: null (getOrCreateLatestThread
        // / startNewThread); externalId-keyed DATABASE threads (a channel's
        // top-level DM, keyed by its conversation id) are conversation records,
        // not resumable threads — exclude them so they don't surface in Recents
        // or the resume picker. Listing another source is untouched.
        ...(options?.threadSource === ThreadSource.DATABASE
          ? { threadSource: ThreadSource.DATABASE, externalThreadId: null }
          : options?.threadSource
            ? { threadSource: options.threadSource }
            : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: options?.limit ?? 20,
    });
  }

  /**
   * Add a message to a thread.
   *
   * Returns the created message plus `titleSet` — the title just assigned to
   * the thread from this (first user) message, or null when no title was set
   * (non-USER, empty content, or the thread is already titled). Callers use it
   * to push a live title update to clients.
   */
  async addMessage(
    threadId: string,
    input: MessageInput
  ): Promise<{ message: ConversationMessage; titleSet: string | null }> {
    const message = await prisma.conversationMessage.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        threadId,
        role: input.role,
        content: input.content,
        triggeredBy: input.triggeredBy,
        triggerName: input.triggerName,
        toolCalls: input.toolCalls as Prisma.InputJsonValue | undefined,
        blocks: input.blocks as Prisma.InputJsonValue | undefined,
        senderExternalId: input.senderExternalId,
        senderName: input.senderName,
        externalMessageId: input.externalMessageId,
        internalStep: input.internalStep,
      },
    });

    // Update thread's updatedAt
    const thread = await prisma.conversationThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });

    trackEvent('message added', null, {
      ...(thread?.agentId ? { 'agent.id': thread.agentId } : {}),
      'thread.id': threadId,
      'message.role': input.role,
      'message.triggered_by': input.triggeredBy,
      // Internal rows are written by the runtime, not sent by anyone. Without this a
      // recalling chat turn adds a second `role=USER` count and every message-volume
      // metric steps at deploy for a reason that is not user behaviour.
      'message.internal': String(Boolean(input.internalStep)),
    });

    // Name the thread after the user's first message (first 3 words, capped).
    // `title: null` makes this atomic and one-shot — it fires only for the very
    // first user message with text and is a no-op for every later message.
    // `count > 0` means this call actually set it, so callers can broadcast it.
    // Never from an internal row: those are written for model context and are not
    // the user's words. A first message carrying only a file leaves the title unset
    // (its text is empty), and the turn's recalled memories would otherwise be the
    // next USER row with text and name the thread after themselves.
    let titleSet: string | null = null;
    if (input.role === 'USER' && !input.internalStep) {
      const title = deriveThreadTitle(input.content);
      if (title) {
        const res = await prisma.conversationThread.updateMany({
          where: { id: threadId, title: null },
          data: { title },
        });
        if (res.count > 0) titleSet = title;
      }
    }

    return { message, titleSet };
  }

  /**
   * Store the external message ID on a persisted message: the id the channel
   * gave the posted copy. Links DB records back to channel messages for tool
   * call enrichment.
   */
  async setExternalMessageId(messageId: string, externalMessageId: string): Promise<void> {
    await prisma.conversationMessage.update({
      where: { id: messageId },
      data: { externalMessageId },
    });
  }

  /**
   * Get recent messages from a thread for CLIENT history (`GET /messages`): the
   * newest `limit`, or the `limit` before the message `before`. Hides
   * concise-mode internal steps — the model path uses getThreadContext.
   */
  async getRecentMessages(
    threadId: string,
    limit: number = 20,
    before?: string,
  ): Promise<ConversationMessage[]> {
    const provider = await this.resolveProvider(threadId);
    const messages = await provider.getRecentMessages(threadId, limit, { view: 'client', before });
    return (await this.withHiddenStepToolCalls(threadId, messages)).map(withSender);
  }

  /**
   * Whether two or more people wrote in the thread. Every row counts, compacted
   * ones too, and no row is deleted, so once true it stays true.
   */
  async hasSeveralSenders(threadId: string): Promise<boolean> {
    const senders = await prisma.conversationMessage.findMany({
      where: {
        threadId,
        role: MessageRole.USER,
        triggeredBy: MessageTrigger.USER_INPUT,
        senderExternalId: { not: null },
      },
      distinct: ['senderExternalId'],
      select: { senderExternalId: true },
      take: 2,
    });
    return senders.length > 1;
  }

  /** The oldest message of a stored thread, internal steps left out: in a channel thread, the first one the agent saw. */
  async getFirstMessage(threadId: string): Promise<ConversationMessage | null> {
    return prisma.conversationMessage.findFirst({
      where: { threadId, internalStep: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * The messages a client is shown, each agent message with the tool calls of
   * the concise-mode steps its turn hid, ahead of its own. A client acts on some
   * results, such as an MCP tool that asks the person for something, and a
   * concise turn shows it the answer alone. Only the copies change: the model
   * replays each call once, from its own step. Live delivery and history read
   * the same rows, so a reload shows what the live reply showed.
   *
   * A hidden step is shown on the first message at or after it that answers a
   * person, passing over one nobody asked for, such as a heartbeat's. When the
   * person's own message comes first, the step is shown nowhere: that keeps a
   * cancelled turn's calls off the next answer. Another agent's message asks like
   * a person's, so it counts the same. A message sent to steer a running turn is
   * a person's message too, so the steps before it are not shown either: the
   * rarer case, traded for not telling the two apart.
   */
  async withHiddenStepToolCalls<T extends ConversationMessage>(threadId: string, messages: T[]): Promise<T[]> {
    const asking: MessageTrigger[] = [MessageTrigger.USER_INPUT, MessageTrigger.AGENT_MESSAGE];
    const visible = [...messages].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const first = visible[0];
    const last = visible.at(-1);
    if (!first || !last || !visible.some((message) => message.role === MessageRole.AGENT)) return messages;

    // The window starts at the last row before the first message that a person sent
    // or that answers one. A step before that row is shown on it or nowhere. A step
    // after it can belong to an answer here, even past a heartbeat's row, so a page
    // shows what the whole history shows.
    const before = await prisma.conversationMessage.findFirst({
      where: {
        threadId,
        internalStep: false,
        triggeredBy: { in: asking },
        createdAt: { lt: first.createdAt },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    const steps = await prisma.conversationMessage.findMany({
      where: {
        threadId,
        role: MessageRole.AGENT,
        internalStep: true,
        createdAt: { ...(before ? { gt: before.createdAt } : {}), lte: last.createdAt },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { createdAt: true, toolCalls: true },
    });

    const hidden = new Map<string, Prisma.JsonArray>();
    for (const step of steps) {
      if (!Array.isArray(step.toolCalls) || step.toolCalls.length === 0) continue;
      const shownOn = visible.find(
        (message) => asking.includes(message.triggeredBy) && message.createdAt.getTime() >= step.createdAt.getTime(),
      );
      if (shownOn?.role !== MessageRole.AGENT) continue;
      hidden.set(shownOn.id, [...(hidden.get(shownOn.id) ?? []), ...step.toolCalls]);
    }
    if (hidden.size === 0) return messages;
    return messages.map((message) => {
      const calls = hidden.get(message.id);
      if (!calls) return message;
      return { ...message, toolCalls: [...calls, ...(Array.isArray(message.toolCalls) ? message.toolCalls : [])] };
    });
  }

  /**
   * Record this thread's latest context-occupancy snapshot.
   *
   * `contextTokens` is a per-turn measurement (the provider-reported prompt size
   * plus that turn's output), NOT a running total — each call overwrites the
   * previous value. `contextModel` is stored alongside so the percentage is
   * recomputed against the right window even after the agent's model changes.
   *
   * `updateMany` so a thread deleted mid-turn is a silent no-op rather than a
   * thrown P2025, matching `updateThreadTitle`.
   */
  async setThreadContextUsage(threadId: string, contextTokens: number, contextModel: string): Promise<void> {
    await prisma.conversationThread.updateMany({
      where: { id: threadId },
      data: { contextTokens, contextModel },
    });
  }

  /** The thread's latest context measurement in tokens, or null when it has none. */
  async getThreadContextTokens(threadId: string): Promise<number | null> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { contextTokens: true },
    });
    return thread?.contextTokens ?? null;
  }

  /**
   * Update thread title
   */
  async updateThreadTitle(
    agentId: string,
    userId: string,
    threadId: string,
    title: string
  ): Promise<void> {
    await prisma.conversationThread.updateMany({
      where: { id: threadId, agentId, userId },
      data: { title },
    });
  }

  /**
   * Get thread with compaction summary (for context building).
   * Compaction itself (summarize + mark rows) lives in `compaction.service.ts`.
   */
  async getThreadContext(threadId: string): Promise<{
    compactionSummary: string | null;
    threadSource: ThreadSource;
    messages: ConversationMessage[];
  }> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: {
        compactionSummary: true,
        threadSource: true,
      },
    });

    const threadSource = thread?.threadSource ?? ThreadSource.DATABASE;
    const messages = await this.providerFor(threadSource).getMessages(threadId);

    return {
      compactionSummary: thread?.compactionSummary ?? null,
      threadSource,
      messages,
    };
  }

  /**
   * One page of the messages a compaction summary replaced, oldest first, and
   * whether more follow. `query` keeps the messages whose text or tool calls hold
   * it, ignoring case. Internal steps are included, since they hold tool calls.
   *
   * The search reads the thread's compacted rows in batches and matches in code:
   * the tool calls are a JSON array, which no Prisma filter on SQLite searches. Each
   * page reads from the thread's first compacted row again, which a long
   * conversation pays for with a full read per page.
   */
  async listCompactedMessages(
    threadId: string,
    options: { query?: string; offset: number; limit: number },
  ): Promise<{ messages: CompactedMessage[]; more: boolean }> {
    const where = { threadId, isCompacted: true };
    const select = { id: true, role: true, content: true, toolCalls: true, internalStep: true, createdAt: true } as const;
    const orderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
    const want = options.offset + options.limit + 1;

    let found: CompactedMessage[];
    if (!options.query) {
      found = await prisma.conversationMessage.findMany({ where, select, orderBy, skip: options.offset, take: options.limit + 1 });
    } else {
      const needle = options.query.toLowerCase();
      const matches: CompactedMessage[] = [];
      let after: string | undefined;
      while (matches.length < want) {
        const batch = await prisma.conversationMessage.findMany({
          where,
          select,
          orderBy,
          take: COMPACTED_SEARCH_BATCH,
          ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        });
        for (const message of batch) {
          const text = `${message.content}\n${message.toolCalls ? JSON.stringify(message.toolCalls) : ''}`;
          if (text.toLowerCase().includes(needle)) matches.push(message);
        }
        if (batch.length < COMPACTED_SEARCH_BATCH) break;
        after = batch[batch.length - 1].id;
      }
      found = matches.slice(options.offset);
    }
    return { messages: found.slice(0, options.limit), more: found.length > options.limit };
  }

  /**
   * Set the external thread ID on an existing thread.
   * Used to link an internal thread to an external channel thread.
   * Always overwrites any existing external ID — the latest channel thread wins.
   */
  async setExternalId(threadId: string, externalThreadId: string): Promise<void> {
    await prisma.conversationThread.updateMany({
      where: { id: threadId },
      data: { externalThreadId },
    });
    trackEvent('thread external id set', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'thread.id': threadId,
    });
  }
}

// Export singleton instance
export const conversationService = new ConversationService();
