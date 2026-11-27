/**
 * The ACP agent against the SDK's own client, connected in process, with a
 * runtime that keeps conversations in memory and publishes the chat socket's
 * frames by hand, in the order the real runtime sends them.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { client, methods, type SessionNotification } from '@agentclientprotocol/sdk';
import type { OutgoingMessage, TurnOutcome, TurnState } from '../chat-protocol.js';
import type { ThreadSummary, TuiMessage } from '../tui-adapter.js';
import { acpAgent } from './acp-agent.js';
import { HISTORY_PAGE, type Runtime } from './runtime.js';

const THREAD = '11111111-1111-4111-8111-111111111111';
const OTHER_THREAD = '22222222-2222-4222-8222-222222222222';

function message(fields: Partial<TuiMessage> & { id: string }): TuiMessage {
  return {
    threadId: THREAD,
    role: 'AGENT',
    content: '',
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    createdAt: '2026-11-18T12:00:00.000Z',
    ...fields,
  };
}

/** A promise a test opens by hand, to hold a read or an upload in flight. */
function gate(): { opened: Promise<void>; open(): void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

class FakeRuntime implements Runtime {
  readonly events = new EventEmitter();
  readonly sent: OutgoingMessage[] = [];
  readonly cancelled: string[] = [];
  readonly uploads: Array<{ data: Uint8Array; filename: string }> = [];
  /** Each conversation's stored messages, oldest first. */
  readonly stored = new Map<string, TuiMessage[]>();
  threads: ThreadSummary[] = [];
  createdIn: string | undefined;
  /** False while the socket is down: a cancel is then not sent. */
  live = true;
  /** How many of the next history reads fail, as when the runtime does not answer. */
  failingReads = 0;
  /** When set, a history read or an upload answers only once it opens. */
  readGate: Promise<void> | null = null;
  uploadGate: Promise<void> | null = null;

  async createThread(cwd: string): Promise<string> {
    this.createdIn = cwd;
    if (!this.stored.has(THREAD)) this.stored.set(THREAD, []);
    return THREAD;
  }

  /** The folders the bridge asked for, in order. This runtime answers with every folder's threads, as an older one does. */
  readonly listedRoots: Array<string | undefined> = [];

  async listThreads(workspaceRoot?: string): Promise<ThreadSummary[]> {
    this.listedRoots.push(workspaceRoot);
    return this.threads;
  }

  attachmentUrl(attachmentId: string): string {
    return `http://runtime.test/agents/attachments/${attachmentId}`;
  }

  async messages(threadId: string, before?: string): Promise<TuiMessage[] | null> {
    if (this.failingReads > 0) {
      this.failingReads -= 1;
      throw new Error('the runtime did not answer');
    }
    const all = this.stored.get(threadId);
    // The page is read now, and answered when the gate opens.
    const end = all && before ? all.findIndex((m) => m.id === before) : (all?.length ?? 0);
    const page = all ? all.slice(Math.max(0, end - HISTORY_PAGE), end) : null;
    await this.readGate;
    return page;
  }

  async upload(data: Uint8Array, filename: string): Promise<string> {
    this.uploads.push({ data, filename });
    await this.uploadGate;
    return `attachment-${this.uploads.length}`;
  }

  send(outgoing: OutgoingMessage): void {
    this.sent.push(outgoing);
  }

  cancel(threadId: string): boolean {
    if (this.live) this.cancelled.push(threadId);
    return this.live;
  }

  close(): void {}

  /** Store a message without an event, as one the socket missed. */
  store(fields: Partial<TuiMessage> & { id: string }): TuiMessage {
    const stored = message(fields);
    this.stored.set(stored.threadId, [...(this.stored.get(stored.threadId) ?? []), stored]);
    return stored;
  }

  /** Store a message and publish it, as the runtime does for every client. */
  publish(fields: Partial<TuiMessage> & { id: string }): void {
    this.events.emit('event', { type: 'message', seq: 0, payload: this.store(fields) });
  }

  turn(state: TurnState, outcome?: TurnOutcome, error?: string, threadId = THREAD): void {
    this.events.emit('event', { type: 'turn', seq: 0, payload: { threadId, state, outcome, error } });
  }

  /** Report the step the running turn is on, as the runtime does at each step's first tool call. */
  step(index: number, tool: string): void {
    this.events.emit('event', { type: 'turn', seq: 0, payload: { threadId: THREAD, state: 'running', step: { index, tool } } });
  }

  /** Confirm a message, which the runtime does once a turn has it. `duplicate`: it was stored before, and sent again. */
  confirm(sent: OutgoingMessage, duplicate = false): void {
    this.events.emit('sent', { messageId: sent.id, seq: 0, queued: false, duplicate });
  }

  /** Take a client's message the way the runtime does: publish it, start its turn, confirm it. */
  accept(sent: OutgoingMessage): void {
    this.publish({ id: sent.id, role: 'USER', content: sent.content });
    this.turn('running');
    this.confirm(sent);
  }

  welcome(resumed: boolean, working: string[] = []): void {
    this.events.emit('welcome', {
      resumed,
      snapshot: { turns: working.map((threadId) => ({ threadId, state: 'running' })) },
    });
  }
}

async function connect(runtime = new FakeRuntime()) {
  const updates: SessionNotification[] = [];
  const editor = client({ name: 'test-editor' }).onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params);
  });
  const { agent } = editor.connect(acpAgent(runtime, 'test'));
  await agent.request(methods.agent.initialize, { protocolVersion: 1 });
  return { runtime, updates, agent };
}

async function connectWithSession(runtime = new FakeRuntime()) {
  const connected = await connect(runtime);
  const { sessionId } = await connected.agent.request(methods.agent.session.new, { cwd: '/repo', mcpServers: [] });
  return { ...connected, sessionId };
}

/** Send a prompt and wait until the bridge has handed it to the runtime. */
async function prompt(
  { agent, runtime, sessionId }: Awaited<ReturnType<typeof connectWithSession>>,
  text: string,
) {
  const count = runtime.sent.length;
  const response = agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(count + 1));
  return { response, sent: runtime.sent[count] };
}

function textChunk(sessionId: string, kind: 'agent_message_chunk' | 'user_message_chunk', id: string, text: string) {
  return { sessionId, update: { sessionUpdate: kind, messageId: id, content: { type: 'text', text } } };
}

/** Let the bridge's queued work and the in-process connection settle. */
const settled = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Whether a response has arrived, without waiting for it. */
function watch(response: Promise<unknown>): { answer: unknown } {
  const seen: { answer: unknown } = { answer: undefined };
  void response.then((value) => (seen.answer = value));
  return seen;
}

describe('a session', () => {
  it('is a conversation rooted in the client working directory', async () => {
    const { runtime, sessionId } = await connectWithSession();

    expect(sessionId).toBe(THREAD);
    expect(runtime.createdIn).toBe('/repo');
  });

  it('lists the conversations that have a working directory, and only those of the asked one', async () => {
    const { runtime, agent } = await connect();
    const thread = { updatedAt: '2026-11-18T12:00:00.000Z', branch: null, contextUsage: null };
    runtime.threads = [
      { ...thread, id: THREAD, title: 'Fix the build', workspaceRoot: '/repo' },
      { ...thread, id: OTHER_THREAD, title: 'Elsewhere', workspaceRoot: '/other' },
      { ...thread, id: '33333333-3333-4333-8333-333333333333', title: 'Web chat', workspaceRoot: null },
    ];

    const all = await agent.request(methods.agent.session.list, {});
    const inRepo = await agent.request(methods.agent.session.list, { cwd: '/repo' });

    expect(all.sessions.map((s) => s.sessionId)).toEqual([THREAD, OTHER_THREAD]);
    // The runtime is asked for the folder, so its limit counts that folder's conversations.
    expect(runtime.listedRoots).toEqual([undefined, '/repo']);
    expect(inRepo.sessions).toEqual([
      { sessionId: THREAD, cwd: '/repo', title: 'Fix the build', updatedAt: '2026-11-18T12:00:00.000Z' },
    ]);
  });

  it('loads with its whole history, oldest first, across pages', async () => {
    const { runtime, updates, agent } = await connect();
    for (let i = 0; i < HISTORY_PAGE + 2; i++) {
      runtime.store({ id: `m${i}`, role: i % 2 === 0 ? 'USER' : 'AGENT', content: `text ${i}` });
    }

    await agent.request(methods.agent.session.load, { sessionId: THREAD, cwd: '/repo', mcpServers: [] });

    expect(updates).toHaveLength(HISTORY_PAGE + 2);
    expect(updates[0]).toEqual(textChunk(THREAD, 'user_message_chunk', 'm0', 'text 0'));
    expect(updates[1]).toEqual(textChunk(THREAD, 'agent_message_chunk', 'm1', 'text 1'));
    expect(updates.at(-1)).toEqual(
      textChunk(THREAD, 'agent_message_chunk', `m${HISTORY_PAGE + 1}`, `text ${HISTORY_PAGE + 1}`),
    );
  });

  it('resumes without its history, and forwards what comes after', async () => {
    const { runtime, updates, agent } = await connect();
    runtime.store({ id: 'old', content: 'An earlier reply' });

    await agent.request(methods.agent.session.resume, { sessionId: THREAD, cwd: '/repo', mcpServers: [] });
    runtime.publish({ id: 'new', content: 'A later reply' });
    await settled();

    expect(updates).toEqual([textChunk(THREAD, 'agent_message_chunk', 'new', 'A later reply')]);
  });

  it('is not found when the runtime has no such conversation', async () => {
    const { agent } = await connect();

    const resumed = agent.request(methods.agent.session.resume, { sessionId: THREAD, cwd: '/repo', mcpServers: [] });

    await expect(resumed).rejects.toMatchObject({ code: -32002, data: { sessionId: THREAD } });
  });

  it('gets no message of a conversation this client has not opened', async () => {
    const { runtime, updates } = await connectWithSession();

    runtime.publish({ id: 'elsewhere', threadId: OTHER_THREAD, content: 'For another conversation' });
    await settled();

    expect(updates).toEqual([]);
  });
});

describe('a prompt', () => {
  it('is one message, answered when the turn that has it goes idle', async () => {
    const session = await connectWithSession();
    const { runtime, updates, sessionId } = session;
    const { response, sent } = await prompt(session, 'Hello');

    expect(sent).toMatchObject({ threadId: THREAD, content: 'Hello', attachmentIds: [] });
    runtime.accept(sent);
    runtime.publish({ id: 'reply', content: 'Hi there' });
    runtime.turn('idle', 'completed');

    await expect(response).resolves.toEqual({ stopReason: 'end_turn' });
    // The client drew its own prompt, so only the reply came back, and it came before the response.
    expect(updates).toEqual([textChunk(sessionId, 'agent_message_chunk', 'reply', 'Hi there')]);
  });

  it('shows each tool call of a reply before the reply text', async () => {
    const session = await connectWithSession();
    const { runtime, updates, sessionId } = session;
    const { response, sent } = await prompt(session, 'Where are you?');
    // The first call is as a runtime stored it, with the folder replaced.
    const pwdOutput = '{"stdout":"/repo\\n","stderr":"","exitCode":0}';

    runtime.accept(sent);
    runtime.publish({
      id: 'reply',
      content: '/repo',
      toolCalls: [
        { tool: 'shell_exec', input: '{"command":"pwd"}', output: pwdOutput, success: true, timestamp: '' },
        { tool: 'shell_read_file', input: '{"path":"c.txt"}', output: 'No such file', success: false, timestamp: '' },
      ],
    });
    runtime.turn('idle', 'completed');
    await response;

    expect(updates).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'reply:0',
          title: 'shell_exec',
          status: 'completed',
          rawInput: { command: 'pwd' },
          content: [{ type: 'content', content: { type: 'text', text: pwdOutput } }],
        },
      },
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'reply:1',
          title: 'shell_read_file',
          status: 'failed',
          rawInput: { path: 'c.txt' },
          content: [{ type: 'content', content: { type: 'text', text: 'No such file' } }],
        },
      },
      textChunk(sessionId, 'agent_message_chunk', 'reply', '/repo'),
    ]);
  });

  it('is not answered by the idle of the turn before its own, which ends after the message is published', async () => {
    const session = await connectWithSession();
    const { runtime } = session;
    const { response, sent } = await prompt(session, 'Next question');
    const seen = watch(response);

    // The runtime publishes a message before it gives it to a turn, and the turn before can end in between.
    runtime.publish({ id: sent.id, role: 'USER', content: 'Next question' });
    runtime.turn('idle', 'completed');
    runtime.turn('running');
    runtime.confirm(sent);
    await settled();
    expect(seen.answer).toBeUndefined();

    runtime.turn('idle', 'completed');
    await expect(response).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('sent while a turn runs joins that turn, and both prompts end with it', async () => {
    const session = await connectWithSession();
    const { runtime } = session;
    const first = await prompt(session, 'Do the long thing');
    runtime.accept(first.sent);

    const second = await prompt(session, 'Change of plan');
    runtime.publish({ id: second.sent.id, role: 'USER', content: 'Change of plan' });
    runtime.confirm(second.sent);
    runtime.turn('idle', 'completed');

    await expect(first.response).resolves.toEqual({ stopReason: 'end_turn' });
    await expect(second.response).resolves.toEqual({ stopReason: 'end_turn' });
    expect(runtime.sent.map((m) => m.threadId)).toEqual([THREAD, THREAD]);
  });

  it('ends as cancelled when the client cancels the turn', async () => {
    const session = await connectWithSession();
    const { runtime, agent, sessionId } = session;
    const { response, sent } = await prompt(session, 'Keep working');
    runtime.accept(sent);

    await agent.notify(methods.agent.session.cancel, { sessionId });
    await vi.waitFor(() => expect(runtime.cancelled).toEqual([THREAD]));
    runtime.turn('idle', 'cancelled');

    await expect(response).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('does not cancel again at a step of the turn it cancelled', async () => {
    const session = await connectWithSession();
    const { runtime, agent, sessionId } = session;
    const { response, sent } = await prompt(session, 'Keep working');
    runtime.accept(sent);
    await agent.notify(methods.agent.session.cancel, { sessionId });
    await vi.waitFor(() => expect(runtime.cancelled).toEqual([THREAD]));

    runtime.step(2, 'web_search');
    runtime.turn('running');
    await settled();
    expect(runtime.cancelled).toEqual([THREAD]);
    runtime.turn('idle', 'cancelled');
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('leaves a newer turn alone when its own turn was cancelled while the socket was away', async () => {
    const session = await connectWithSession();
    const { runtime, agent, sessionId } = session;
    const { response, sent } = await prompt(session, 'Keep working');
    runtime.accept(sent);
    await agent.notify(methods.agent.session.cancel, { sessionId });
    await vi.waitFor(() => expect(runtime.cancelled).toEqual([THREAD]));

    // The socket comes back with another client's turn running, and then sends the missed events.
    runtime.welcome(true, [THREAD]);
    runtime.turn('idle', 'cancelled');
    runtime.turn('running');
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' });
    await settled();

    expect(runtime.cancelled).toEqual([THREAD]);
  });

  it('is cancelled when its turn starts only after the cancel, and a later turn is left alone', async () => {
    const session = await connectWithSession();
    const { runtime, agent, sessionId } = session;
    const { response, sent } = await prompt(session, 'Keep working');

    await agent.notify(methods.agent.session.cancel, { sessionId });
    await vi.waitFor(() => expect(runtime.cancelled).toEqual([THREAD]));
    runtime.accept(sent);
    await vi.waitFor(() => expect(runtime.cancelled).toEqual([THREAD, THREAD]));
    runtime.turn('idle', 'cancelled');
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' });

    runtime.turn('running');
    await settled();
    expect(runtime.cancelled).toEqual([THREAD, THREAD]);
  });

  it('is not stopped by the cancel of the prompt before it, also when it is made before that prompt ends', async () => {
    const session = await connectWithSession();
    const { runtime, agent, sessionId } = session;
    const first = await prompt(session, 'Keep working');
    runtime.accept(first.sent);
    await agent.notify(methods.agent.session.cancel, { sessionId });
    await vi.waitFor(() => expect(runtime.cancelled).toEqual([THREAD]));

    const second = await prompt(session, 'Do this now');
    runtime.turn('idle', 'cancelled');
    await expect(first.response).resolves.toEqual({ stopReason: 'cancelled' });
    runtime.accept(second.sent);
    runtime.turn('idle', 'completed');

    await expect(second.response).resolves.toEqual({ stopReason: 'end_turn' });
    expect(runtime.cancelled).toEqual([THREAD]);
  });

  it('is cancelled when the cancel comes while its image uploads', async () => {
    const { runtime, agent, sessionId } = await connectWithSession();
    const upload = gate();
    runtime.uploadGate = upload.opened;

    const response = agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'image', data: Buffer.from('a png').toString('base64'), mimeType: 'image/png' }],
    });
    await vi.waitFor(() => expect(runtime.uploads).toHaveLength(1));
    await agent.notify(methods.agent.session.cancel, { sessionId });
    await vi.waitFor(() => expect(runtime.cancelled).toEqual([THREAD]));

    upload.open();
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1));
    runtime.accept(runtime.sent[0]);
    await vi.waitFor(() => expect(runtime.cancelled).toEqual([THREAD, THREAD]));
    runtime.turn('idle', 'cancelled');
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('fails with the turn error when the turn failed', async () => {
    const session = await connectWithSession();
    const { runtime } = session;
    const { response, sent } = await prompt(session, 'Hello');

    runtime.accept(sent);
    runtime.turn('idle', 'failed', 'The AI spending limit is reached.');

    await expect(response).rejects.toMatchObject({
      code: -32603,
      message: 'Internal error: The AI spending limit is reached.',
    });
  });

  it('fails with the reason when the runtime refuses the message, and a cancel does not outlive it', async () => {
    const session = await connectWithSession();
    const { runtime, agent, sessionId } = session;
    const refused = await prompt(session, 'Hello');
    await agent.notify(methods.agent.session.cancel, { sessionId });
    await vi.waitFor(() => expect(runtime.cancelled).toEqual([THREAD]));

    runtime.events.emit('sendFailed', {
      messageId: refused.sent.id,
      code: 'unavailable',
      message: 'The agent is still starting.',
    });
    await expect(refused.response).rejects.toMatchObject({ message: 'Internal error: The agent is still starting.' });

    const next = await prompt(session, 'Hello again');
    runtime.accept(next.sent);
    await settled();
    expect(runtime.cancelled).toEqual([THREAD]);
  });

  it('uploads an image and names it on the message, and writes a linked file as its path', async () => {
    const session = await connectWithSession();
    const { runtime, agent, sessionId } = session;
    const png = Buffer.from('not really a png');

    void agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: 'text', text: 'Compare ' },
        { type: 'resource_link', uri: 'file:///repo/src/main.ts#L10:20', name: 'main.ts' },
        { type: 'text', text: ' with this screenshot.' },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ],
    });
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1));

    expect(runtime.sent[0]).toMatchObject({
      content: 'Compare /repo/src/main.ts#L10:20 with this screenshot.',
      attachmentIds: ['attachment-1'],
    });
    expect(runtime.uploads).toEqual([{ data: png, filename: 'image.png' }]);
  });

  it('keeps a linked file apart from the link or the text next to it', async () => {
    const { runtime, agent, sessionId } = await connectWithSession();

    void agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: 'text', text: 'Compare' },
        { type: 'resource_link', uri: 'file:///repo/a.ts', name: 'a.ts' },
        { type: 'resource_link', uri: 'file:///repo/b.ts', name: 'b.ts' },
        { type: 'text', text: 'and say which is newer.' },
      ],
    });
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1));

    expect(runtime.sent[0].content).toBe('Compare /repo/a.ts /repo/b.ts and say which is newer.');
  });

  it('reaches the runtime after the prompt before it, also while that one uploads an image', async () => {
    const { runtime, agent, sessionId } = await connectWithSession();
    const upload = gate();
    runtime.uploadGate = upload.opened;

    void agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image', data: Buffer.from('a png').toString('base64'), mimeType: 'image/png' },
      ],
    });
    await vi.waitFor(() => expect(runtime.uploads).toHaveLength(1));
    void agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Answer briefly.' }] });
    await settled();
    expect(runtime.sent).toEqual([]);

    upload.open();
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(2));
    expect(runtime.sent.map((m) => m.content)).toEqual(['What is in this picture?', 'Answer briefly.']);
  });
});

describe('a file of a message', () => {
  const report = { id: 'file-1', filename: 'report.pdf', mediaType: 'application/pdf', sizeBytes: 48211, category: 'document' };
  const reportLink = {
    type: 'resource_link',
    uri: 'http://runtime.test/agents/attachments/file-1',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: 48211,
  };

  it('that the agent shares shows as a link after the text', async () => {
    const { runtime, updates, sessionId } = await connectWithSession();

    runtime.publish({ id: 'shared', content: 'Here is the report.', attachments: [report] });
    await settled();

    expect(updates).toEqual([
      textChunk(sessionId, 'agent_message_chunk', 'shared', 'Here is the report.'),
      { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'shared', content: reportLink } },
    ]);
  });

  it('shows in a loaded session also when the message has no text, and not once its bytes are gone', async () => {
    const { runtime, updates, agent } = await connect();
    runtime.store({ id: 'picture', role: 'USER', attachments: [report] });
    runtime.store({ id: 'old', role: 'USER', attachments: [{ ...report, id: 'file-0', expired: true }] });

    await agent.request(methods.agent.session.load, { sessionId: THREAD, cwd: '/repo', mcpServers: [] });

    expect(updates).toEqual([
      { sessionId: THREAD, update: { sessionUpdate: 'user_message_chunk', messageId: 'picture', content: reportLink } },
    ]);
  });
});

describe('a message nobody prompted for', () => {
  it('from another client of the conversation arrives as a user message', async () => {
    const { runtime, updates, sessionId } = await connectWithSession();

    runtime.publish({ id: 'theirs', role: 'USER', content: 'Typed in the web UI' });
    await settled();

    expect(updates).toEqual([textChunk(sessionId, 'user_message_chunk', 'theirs', 'Typed in the web UI')]);
  });

  it('from the agent arrives between prompts', async () => {
    const { runtime, updates, sessionId } = await connectWithSession();

    runtime.publish({ id: 'scheduled', content: 'The nightly build failed.', triggeredBy: 'CRON' });
    await settled();

    expect(updates).toEqual([textChunk(sessionId, 'agent_message_chunk', 'scheduled', 'The nightly build failed.')]);
  });

  it('is sent once when the runtime publishes it again after a change in place', async () => {
    const { runtime, updates } = await connectWithSession();

    runtime.publish({ id: 'card', content: 'Which branch?' });
    runtime.publish({ id: 'card', content: 'Which branch?' });
    await settled();

    expect(updates).toHaveLength(1);
  });
});

describe('conversation state', () => {
  it('reports a new title and the context in use', async () => {
    const { runtime, updates, sessionId } = await connectWithSession();

    runtime.events.emit('event', { type: 'thread', seq: 0, payload: { threadId: THREAD, title: 'Fix the build' } });
    runtime.events.emit('event', {
      type: 'context',
      seq: 0,
      payload: { threadId: THREAD, modelId: 'm', usedTokens: 1200, windowTokens: 200000, usedPercent: 1 },
    });
    await settled();

    expect(updates).toEqual([
      { sessionId, update: { sessionUpdate: 'session_info_update', title: 'Fix the build' } },
      { sessionId, update: { sessionUpdate: 'usage_update', used: 1200, size: 200000 } },
    ]);
  });
});

describe('a socket that came back', () => {
  it('without the missed events: the missed messages are sent and a prompt whose turn ended is answered', async () => {
    const session = await connectWithSession();
    const { runtime, updates, sessionId } = session;
    const { response, sent } = await prompt(session, 'Hello');
    runtime.accept(sent);

    runtime.store({ id: 'reply', content: 'Answered while you were away' });
    runtime.welcome(false);

    await expect(response).resolves.toEqual({ stopReason: 'end_turn' });
    expect(updates).toEqual([textChunk(sessionId, 'agent_message_chunk', 'reply', 'Answered while you were away')]);
  });

  it('without the missed events: every missed message is sent, back to the last one the client has', async () => {
    const session = await connectWithSession();
    const { runtime, updates } = session;
    const { response, sent } = await prompt(session, 'Hello');
    runtime.accept(sent);
    runtime.publish({ id: 'seen', content: 'The last reply before the gap' });
    await settled();
    updates.length = 0;

    const missed = HISTORY_PAGE + 50;
    for (let i = 0; i < missed; i++) runtime.store({ id: `gap-${i}`, content: `missed ${i}` });
    runtime.welcome(false);

    await expect(response).resolves.toEqual({ stopReason: 'end_turn' });
    expect(updates).toHaveLength(missed);
    expect(updates[0]).toEqual(textChunk(THREAD, 'agent_message_chunk', 'gap-0', 'missed 0'));
    expect(updates.at(-1)).toEqual(
      textChunk(THREAD, 'agent_message_chunk', `gap-${missed - 1}`, `missed ${missed - 1}`),
    );
  });

  it('without the missed events: the replies missed before a prompt made while the socket was down are sent', async () => {
    const session = await connectWithSession();
    const { runtime, updates } = session;
    runtime.publish({ id: 'seen', content: 'The last reply before the gap' });
    await settled();
    updates.length = 0;

    const missed = HISTORY_PAGE + 50;
    for (let i = 0; i < missed; i++) runtime.store({ id: `gap-${i}`, content: `missed ${i}` });
    // The prompt waits for the socket, and the runtime stores it after everything the client missed.
    const { sent } = await prompt(session, 'Hello');
    runtime.store({ id: sent.id, role: 'USER', content: 'Hello' });
    runtime.welcome(false);
    await vi.waitFor(() => expect(updates).toHaveLength(missed));
    await settled();

    expect(updates).toHaveLength(missed);
    expect(updates[0]).toEqual(textChunk(THREAD, 'agent_message_chunk', 'gap-0', 'missed 0'));
  });

  it('without the missed events: the history from before a resumed session is not sent', async () => {
    const { runtime, updates, agent } = await connect();
    for (let i = 0; i < HISTORY_PAGE + 50; i++) runtime.store({ id: `old-${i}`, content: `old ${i}` });
    await agent.request(methods.agent.session.resume, { sessionId: THREAD, cwd: '/repo', mcpServers: [] });

    const missed = HISTORY_PAGE + 50;
    for (let i = 0; i < missed; i++) runtime.store({ id: `gap-${i}`, content: `missed ${i}` });
    runtime.welcome(false);
    await vi.waitFor(() => expect(updates).toHaveLength(missed));
    await settled();

    expect(updates).toHaveLength(missed);
    expect(updates[0]).toEqual(textChunk(THREAD, 'agent_message_chunk', 'gap-0', 'missed 0'));
  });

  it('without the missed events: the prompt is answered also when the first read of the messages fails', async () => {
    const session = await connectWithSession();
    const { runtime } = session;
    const { response, sent } = await prompt(session, 'Hello');
    runtime.accept(sent);
    await settled();
    runtime.store({ id: 'reply', content: 'Answered while you were away' });

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      runtime.failingReads = 1;
      runtime.welcome(false);
      await settled();
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }

    await expect(response).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('without the missed events: a turn that ends while the messages are read keeps its reply and its outcome', async () => {
    const session = await connectWithSession();
    const { runtime, updates, sessionId } = session;
    const { response, sent } = await prompt(session, 'Keep working');
    runtime.accept(sent);
    await settled();

    const read = gate();
    runtime.readGate = read.opened;
    runtime.welcome(false, [THREAD]);
    await settled();
    runtime.publish({ id: 'reply', content: 'Stopped here' });
    runtime.turn('idle', 'cancelled');
    read.open();

    await expect(response).resolves.toEqual({ stopReason: 'cancelled' });
    expect(updates).toEqual([textChunk(sessionId, 'agent_message_chunk', 'reply', 'Stopped here')]);
  });

  it('without the missed events: a prompt made while the socket was down is left to its own turn', async () => {
    const session = await connectWithSession();
    const { runtime } = session;
    const { response, sent } = await prompt(session, 'Hello');
    const seen = watch(response);

    // The socket sends the waiting prompt right after the welcome, so the read that follows already holds it.
    runtime.store({ id: sent.id, role: 'USER', content: 'Hello' });
    runtime.welcome(false);
    runtime.turn('running');
    runtime.confirm(sent);
    await settled();
    expect(seen.answer).toBeUndefined();

    runtime.turn('idle', 'completed');
    await expect(response).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('without the missed events: a prompt whose first confirmation was lost ends when it is confirmed again', async () => {
    const session = await connectWithSession();
    const { runtime, updates, sessionId } = session;
    const { response, sent } = await prompt(session, 'Hello');

    // The runtime took the message and answered it, and the socket was away for all of it.
    runtime.store({ id: sent.id, role: 'USER', content: 'Hello' });
    runtime.store({ id: 'reply', content: 'Answered while you were away' });
    runtime.welcome(false);
    runtime.confirm(sent, true);

    await expect(response).resolves.toEqual({ stopReason: 'end_turn' });
    expect(updates).toEqual([textChunk(sessionId, 'agent_message_chunk', 'reply', 'Answered while you were away')]);
  });

  it('with the missed events: a prompt whose first confirmation was lost ends with the turn they show', async () => {
    const session = await connectWithSession();
    const { runtime } = session;
    const { response, sent } = await prompt(session, 'Hello');
    const seen = watch(response);

    // The missed events come first, the end of the turn among them, and then the second confirmation.
    runtime.welcome(true);
    runtime.publish({ id: sent.id, role: 'USER', content: 'Hello' });
    runtime.turn('running');
    runtime.turn('idle', 'completed');
    await settled();
    expect(seen.answer).toBeUndefined();

    runtime.confirm(sent, true);
    await expect(response).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('with the missed events: a prompt whose first confirmation was lost fails when the turn they show failed', async () => {
    const session = await connectWithSession();
    const { runtime } = session;
    const { response, sent } = await prompt(session, 'Hello');

    runtime.welcome(true);
    runtime.publish({ id: sent.id, role: 'USER', content: 'Hello' });
    runtime.turn('running');
    runtime.turn('idle', 'failed', 'The AI spending limit is reached.');
    runtime.confirm(sent, true);

    await expect(response).rejects.toMatchObject({ message: 'Internal error: The AI spending limit is reached.' });
  });

  it('with the missed events: a prompt whose first confirmation was lost is cancelled when the turn they show was', async () => {
    const session = await connectWithSession();
    const { runtime } = session;
    const { response, sent } = await prompt(session, 'Hello');

    runtime.welcome(true);
    runtime.publish({ id: sent.id, role: 'USER', content: 'Hello' });
    runtime.turn('running');
    runtime.turn('idle', 'cancelled');
    runtime.confirm(sent, true);

    await expect(response).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('with the missed events: a prompt confirmed again while its turn still runs waits for that turn', async () => {
    const session = await connectWithSession();
    const { runtime } = session;
    const { response, sent } = await prompt(session, 'Hello');
    const seen = watch(response);

    runtime.welcome(true);
    runtime.publish({ id: sent.id, role: 'USER', content: 'Hello' });
    runtime.turn('running');
    runtime.confirm(sent, true);
    await settled();
    expect(seen.answer).toBeUndefined();

    runtime.turn('idle', 'cancelled');
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('with the missed events: nothing is read from history, since the events follow', async () => {
    const { runtime, updates } = await connectWithSession();

    runtime.store({ id: 'missed', content: 'Arrives as an event next' });
    runtime.welcome(true);
    await settled();

    expect(updates).toEqual([]);
  });

  it('starts a session on a conversation that already works, and waits for that turn after a second confirmation', async () => {
    const { runtime, agent } = await connect();
    runtime.stored.set(THREAD, []);
    runtime.turn('running');
    await agent.request(methods.agent.session.resume, { sessionId: THREAD, cwd: '/repo', mcpServers: [] });
    const session = { runtime, agent, sessionId: THREAD, updates: [] };
    const { response, sent } = await prompt(session, 'One more thing');
    const seen = watch(response);

    runtime.welcome(true);
    runtime.confirm(sent, true);
    await settled();
    expect(seen.answer).toBeUndefined();

    runtime.turn('idle', 'completed');
    await expect(response).resolves.toEqual({ stopReason: 'end_turn' });
  });
});
