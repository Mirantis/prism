/**
 * Prism as an Agent Client Protocol agent.
 *
 * An ACP session is one Prism conversation, and the session id is the thread
 * id. A prompt is a message sent on the chat socket, and its response is that
 * conversation's turn going idle. Every other message of the conversation, the
 * agent's or another client's, goes to the ACP client as a session update,
 * during a prompt and between prompts.
 */

import { randomUUID } from 'node:crypto';
import {
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type PromptResponse,
  type SessionInfo,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk';
import {
  TURN_FAILED_TEXT,
  type SendAckPayload,
  type StreamEvent,
  type TurnEventPayload,
  type TurnState,
  type WelcomePayload,
} from '../chat-protocol.js';
import { coerceMessage, type ContextUsage, type TuiMessage } from '../tui-adapter.js';
import type { SendFailure } from '../ws-client.js';
import { messageUpdates } from './message-updates.js';
import { promptContent } from './prompt-content.js';
import { HISTORY_PAGE, type Runtime } from './runtime.js';

const CATCH_UP_RETRY_MS = 2_000;

interface PendingPrompt {
  messageId: string;
  /**
   * True once the runtime has given the message to a turn, so the next idle turn
   * of the conversation is the one that answered it. The runtime confirms a
   * message only after that, and publishes it before.
   */
  scheduled: boolean;
  /** True once the client cancelled it. Until it ends, a turn that starts on the conversation is stopped too. */
  cancelled: boolean;
  resolve(stopReason: StopReason): void;
  reject(error: RequestError): void;
}

class Session {
  /** The messages this session has received from the runtime: the history it attached after, and each one since. */
  readonly received = new Set<string>();
  /** The client's own prompts. The client drew them, so the runtime's copy is not sent back. */
  readonly own = new Set<string>();
  prompts: PendingPrompt[] = [];
  /** How the conversation's last turn ended, for a prompt that is confirmed only after it. */
  lastTurn: Pick<TurnEventPayload, 'outcome' | 'error'> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private sends: Promise<void> = Promise.resolve();

  /** `state`: the conversation's turn, as of the frames this session has handled. */
  constructor(
    readonly id: string,
    public state: TurnState,
  ) {}

  /** Whether a turn runs or waits on the conversation. */
  get working(): boolean {
    return this.state !== 'idle';
  }

  /** Run `work` after the sends before it, so the runtime gets the client's prompts in their order. */
  send(work: () => Promise<void>): Promise<void> {
    const result = this.sends.then(work);
    this.sends = result.catch(() => undefined);
    return result;
  }

  /** Run `work` after everything queued before it, so the session sees the socket's frames in their order. */
  run(work: () => Promise<void>): Promise<void> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** One ACP client's sessions, between the runtime and that client. */
class Bridge {
  private readonly sessions = new Map<string, Session>();
  /** The conversations with a turn running or queued, as the socket last said. A session starts from it. */
  private readonly turns = new Map<string, Exclude<TurnState, 'idle'>>();

  constructor(
    private readonly runtime: Runtime,
    private readonly client: AgentContext,
  ) {
    runtime.events.on('welcome', (welcome: WelcomePayload) => this.onWelcome(welcome));
    runtime.events.on('event', (event: StreamEvent) => this.onEvent(event));
    runtime.events.on('sent', (ack: SendAckPayload) => this.onSent(ack));
    runtime.events.on('sendFailed', (failure: SendFailure) => this.onSendFailed(failure));
  }

  async create(cwd: string): Promise<string> {
    const threadId = await this.runtime.createThread(cwd);
    await this.attach(threadId, false);
    return threadId;
  }

  /**
   * Forward a conversation's messages from here on. With `replay` its whole
   * history goes first. Without, the client is taken to have the history.
   */
  attach(threadId: string, replay: boolean): Promise<void> {
    const session = this.sessions.get(threadId) ?? new Session(threadId, this.turns.get(threadId) ?? 'idle');
    // Registered before the read, so a message that arrives during it waits in the queue behind it.
    this.sessions.set(threadId, session);
    return session.run(async () => {
      const history = await this.history(threadId, replay);
      if (!history) {
        this.sessions.delete(threadId);
        throw RequestError.sessionNotFound(threadId);
      }
      if (!replay) {
        for (const message of history) session.received.add(message.id);
        return;
      }
      session.received.clear();
      session.own.clear();
      for (const message of history) await this.forward(session, message);
    });
  }

  async list(cwd?: string | null): Promise<SessionInfo[]> {
    const threads = await this.runtime.listThreads(cwd ?? undefined);
    // A session has a working directory, so a conversation started without one is not listed.
    // A runtime from before the folder filter answers with every folder, so the folder is checked here too.
    return threads.flatMap((thread) =>
      thread.workspaceRoot && (!cwd || thread.workspaceRoot === cwd)
        ? [{ sessionId: thread.id, cwd: thread.workspaceRoot, title: thread.title, updatedAt: thread.updatedAt }]
        : [],
    );
  }

  prompt(sessionId: string, blocks: ContentBlock[]): Promise<PromptResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) throw RequestError.sessionNotFound(sessionId);
    const { text, images } = promptContent(blocks);
    const messageId = randomUUID();
    session.own.add(messageId);
    return new Promise<PromptResponse>((resolve, reject) => {
      const prompt: PendingPrompt = {
        messageId,
        scheduled: false,
        cancelled: false,
        resolve: (stopReason) => resolve({ stopReason }),
        reject,
      };
      // Waiting from before the uploads, so a cancel during them holds for the turn that follows.
      session.prompts.push(prompt);
      session
        .send(async () => {
          const attachmentIds = await Promise.all(
            images.map((image) => this.runtime.upload(image.data, image.filename)),
          );
          // A prompt sent while a turn runs goes to that turn, and both prompts end when it does.
          this.runtime.send({ id: messageId, threadId: sessionId, content: text, attachmentIds });
        })
        .catch((error: RequestError) => this.end(session, [prompt], () => reject(error)));
    });
  }

  /**
   * Stop the turn the session's prompts wait for. A prompt that is not sent yet
   * starts its turn afterwards, so the cancel is asked again when a turn starts
   * while one of those prompts still waits. A prompt made after the cancel is
   * not one of them.
   */
  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.prompts.length === 0) return;
    for (const prompt of session.prompts) prompt.cancelled = true;
    this.runtime.cancel(sessionId);
  }

  private onWelcome(welcome: WelcomePayload): void {
    this.turns.clear();
    for (const turn of welcome.snapshot.turns) this.turns.set(turn.threadId, turn.state);
    // A resumed socket sends every missed event next, and the session follows those.
    if (welcome.resumed) return;
    for (const session of this.sessions.values()) {
      const state = this.turns.get(session.id) ?? 'idle';
      this.queue(session.id, () => this.catchUp(session, state));
    }
  }

  private onEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'message': {
        const message = coerceMessage(event.payload);
        if (message) this.queue(message.threadId, (session) => this.forward(session, message));
        return;
      }
      case 'turn': {
        const turn = event.payload as TurnEventPayload;
        if (turn.state === 'idle') this.turns.delete(turn.threadId);
        else this.turns.set(turn.threadId, turn.state);
        this.queue(turn.threadId, async (session) => {
          // A `running` event while the turn already runs reports its step, not a new turn.
          const started = turn.state !== session.state;
          session.state = turn.state;
          if (session.working) {
            // In the session's order, so a cancel that ended with the turn before does not stop this one.
            if (started && session.prompts.some((prompt) => prompt.cancelled)) this.runtime.cancel(session.id);
            return;
          }
          session.lastTurn = turn;
          this.settle(session, turn, session.prompts);
        });
        return;
      }
      case 'thread': {
        const { threadId, title } = event.payload as { threadId: string; title: string | null };
        this.queue(threadId, () => this.update(threadId, { sessionUpdate: 'session_info_update', title }));
        return;
      }
      case 'context': {
        const usage = event.payload as ContextUsage;
        this.queue(usage.threadId, () =>
          this.update(usage.threadId, {
            sessionUpdate: 'usage_update',
            used: usage.usedTokens,
            size: usage.windowTokens,
          }),
        );
        return;
      }
    }
  }

  private onSent(ack: SendAckPayload): void {
    const found = this.promptOf(ack.messageId);
    if (!found) return;
    // In the queue, behind the idle of a turn that ended before the runtime scheduled this message.
    this.queue(found.session.id, async (session) => {
      found.prompt.scheduled = true;
      // A message confirmed a second time was stored before the socket went away. With no turn on
      // the conversation now, its turn ended while the confirmation was lost.
      if (ack.duplicate && !session.working) {
        this.settle(session, session.lastTurn ?? { outcome: 'completed' }, [found.prompt]);
      }
    });
  }

  private onSendFailed(failure: SendFailure): void {
    const found = this.promptOf(failure.messageId);
    if (!found) return;
    this.end(found.session, [found.prompt], (prompt) =>
      prompt.reject(RequestError.internalError(undefined, failure.message)),
    );
  }

  private promptOf(messageId: string): { session: Session; prompt: PendingPrompt } | undefined {
    for (const session of this.sessions.values()) {
      const prompt = session.prompts.find((pending) => pending.messageId === messageId);
      if (prompt) return { session, prompt };
    }
    return undefined;
  }

  /** Queue work on a session this connection has open. An event of any other conversation is dropped. */
  private queue(threadId: string, work: (session: Session) => Promise<void>): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.run(() => work(session)).catch((err: Error) => process.stderr.write(`prism acp: ${err.message}\n`));
  }

  /** Send a message the session receives for the first time, unless it is the client's own prompt. */
  private async forward(session: Session, message: TuiMessage): Promise<void> {
    // A message arrives again when it changes in place, and ACP v1 has no update for a sent message.
    if (session.received.has(message.id)) return;
    session.received.add(message.id);
    if (session.own.has(message.id)) return;
    const updates = messageUpdates(message, (attachmentId) => this.runtime.attachmentUrl(attachmentId));
    for (const update of updates) await this.update(session.id, update);
  }

  /** Answer those of `prompts` that the turn which just ended had been given. */
  private settle(session: Session, turn: Pick<TurnEventPayload, 'outcome' | 'error'>, prompts: PendingPrompt[]): void {
    this.end(
      session,
      prompts.filter((prompt) => prompt.scheduled),
      (prompt) => {
        if (turn.outcome === 'failed') {
          prompt.reject(RequestError.internalError(undefined, turn.error ?? TURN_FAILED_TEXT));
          return;
        }
        // A conversation that goes idle with no outcome only ever waited, and a wait ends early by a cancel alone.
        prompt.resolve(turn.outcome === 'completed' ? 'end_turn' : 'cancelled');
      },
    );
  }

  /** Take the prompts that still wait off the session, and finish each. */
  private end(session: Session, prompts: PendingPrompt[], finish: (prompt: PendingPrompt) => void): void {
    const ending = prompts.filter((prompt) => session.prompts.includes(prompt));
    session.prompts = session.prompts.filter((prompt) => !ending.includes(prompt));
    ending.forEach(finish);
  }

  /**
   * After the socket came back without the missed events: send what the client
   * missed. `state` is the conversation's turn at the welcome. When no turn
   * works, the turn of the prompts the runtime had confirmed ended while the
   * socket was away, and they end here. A prompt sent after the welcome is
   * confirmed after it, and ends with its own turn.
   */
  private async catchUp(session: Session, state: TurnState): Promise<void> {
    session.state = state;
    const working = session.working;
    session.lastTurn = undefined;
    const confirmed = session.prompts.filter((prompt) => prompt.scheduled);
    for (const message of await this.missed(session)) await this.forward(session, message);
    if (!working) this.settle(session, { outcome: 'completed' }, confirmed);
  }

  /**
   * The conversation from the oldest message this session has received, oldest
   * first: the pages back to that message, or to the conversation's start when
   * it has received none. A prompt the client made while the socket was down is
   * not such a message: the runtime stores it after the replies the client missed.
   */
  private async missed(session: Session): Promise<TuiMessage[]> {
    const messages: TuiMessage[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.page(session.id, before);
      messages.unshift(...page);
      const has = messages.findIndex((message) => session.received.has(message.id));
      if (has >= 0) return messages.slice(has);
      if (page.length < HISTORY_PAGE) return messages;
      before = page[0].id;
    }
  }

  /**
   * One page of the conversation, asked for until the runtime answers. A prompt
   * whose turn ended while the socket was away ends only after this read.
   */
  private async page(threadId: string, before: string | undefined): Promise<TuiMessage[]> {
    for (;;) {
      try {
        return (await this.runtime.messages(threadId, before)) ?? [];
      } catch {
        // Unreferenced, so a client that has gone does not keep the process alive for the next try.
        await new Promise((resolve) => setTimeout(resolve, CATCH_UP_RETRY_MS).unref());
      }
    }
  }

  /** The conversation's newest page, or with `whole` every page, oldest first. Null when there is no such conversation. */
  private async history(threadId: string, whole: boolean): Promise<TuiMessage[] | null> {
    const messages: TuiMessage[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.runtime.messages(threadId, before);
      if (!page) return null;
      messages.unshift(...page);
      if (!whole || page.length < HISTORY_PAGE) return messages;
      before = page[0].id;
    }
  }

  private update(sessionId: string, update: SessionUpdate): Promise<void> {
    return this.client.notify(methods.client.session.update, { sessionId, update });
  }
}

/** The agent app. `connect` it to a stream to serve one ACP client. */
export function acpAgent(runtime: Runtime, version: string): AgentApp {
  // Set when the client connects, which is before the app handles the client's first message.
  let bridge: Bridge;
  return agent({ name: 'prism' })
    .onConnect((connection) => {
      bridge = new Bridge(runtime, connection.client);
    })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'prism', title: 'Prism', version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {}, resume: {} },
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => ({ sessionId: await bridge.create(params.cwd) }))
    .onRequest(methods.agent.session.load, ({ params }) => bridge.attach(params.sessionId, true))
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      await bridge.attach(params.sessionId, false);
      return {};
    })
    .onRequest(methods.agent.session.list, async ({ params }) => ({ sessions: await bridge.list(params.cwd) }))
    .onRequest(methods.agent.session.prompt, ({ params }) => bridge.prompt(params.sessionId, params.prompt))
    .onNotification(methods.agent.session.cancel, ({ params }) => bridge.cancel(params.sessionId));
}
