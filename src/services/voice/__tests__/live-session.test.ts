/**
 * The GPT-Live wire protocol, against a local server that answers the way the live
 * endpoint does.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'net';
import { config } from '../../../config';
import { LiveSession, type LiveSessionOptions } from '../live-session';
import {
  functionCallEvent,
  responseCompletedEvent,
  startLiveServer,
  type LiveServer,
} from '../../../test-utils/live-server';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let server: LiveServer | null = null;
let session: LiveSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
  await server?.dispose();
  server = null;
  vi.mocked(config).openaiRealtimeReasoningEffort = 'medium';
});

async function open(overrides: Partial<LiveSessionOptions> = {}): Promise<{ server: LiveServer; session: LiveSession }> {
  server = await startLiveServer();
  session = new LiveSession({
    instructions: 'You are Prism, the voice.',
    backendInstructions: 'You are Prism, the backend.',
    tools: [{ name: 'get_time', description: 'Current time.', parameters: { type: 'object', properties: {} } }],
    voice: 'marin',
    endpointOverride: { url: server.url, headers: {} },
    ...overrides,
  });
  await session.connect();
  return { server, session };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('LiveSession', () => {
  it('starts the session with the voice, the backend and the tools', async () => {
    const { server } = await open();
    const start = await server.started;

    expect(start.session).toEqual({
      model: 'gpt-live-1',
      instructions: 'You are Prism, the voice.',
      audio: { output: { voice: 'marin' } },
      delegation: {
        type: 'responses',
        responses: {
          model: 'gpt-6-sol',
          instructions: 'You are Prism, the backend.',
          reasoning: { effort: 'medium' },
          tools: [{ type: 'function', name: 'get_time', description: 'Current time.', parameters: { type: 'object', properties: {} } }],
          tool_choice: 'auto',
        },
      },
    });
  });

  it('leaves the reasoning level to the API when config sends none', async () => {
    vi.mocked(config).openaiRealtimeReasoningEffort = null;
    const { server } = await open({ tools: [] });
    const start = await server.started;

    expect(start.session.delegation.responses).toEqual({
      model: 'gpt-6-sol',
      instructions: 'You are Prism, the backend.',
    });
  });

  it('rejects a start the API refuses, naming why', async () => {
    server = await startLiveServer({ refuseWith: { code: 'model_not_found', message: 'The model does not exist' } });
    session = new LiveSession({
      instructions: 'x',
      backendInstructions: 'y',
      tools: [],
      endpointOverride: { url: server.url, headers: {} },
    });

    await expect(session.connect()).rejects.toThrow(/refused: The model does not exist/);
  });

  it('rejects a start that never gets past the handshake, without crashing', async () => {
    // Accepts the TCP connection and never answers the upgrade.
    const held: net.Socket[] = [];
    const stalled = net.createServer((socket) => void held.push(socket));
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const port = (stalled.address() as net.AddressInfo).port;
    const live = new LiveSession({
      instructions: 'x',
      backendInstructions: 'y',
      tools: [],
      endpointOverride: { url: `ws://127.0.0.1:${port}/v1/live/sessions`, headers: {} },
      startTimeoutMs: 100,
    });

    try {
      await expect(live.connect()).rejects.toThrow(/did not start in time/);
      // The terminated socket reports its error a tick later; nothing may throw then.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });

  it('sends audio and emits the voice audio it receives', async () => {
    const { server, session } = await open();
    const heard: Buffer[] = [];
    session.on('audio', (pcm) => heard.push(pcm));

    session.sendAudio(Buffer.from([1, 0, 2, 0]));
    server.emit({ type: 'session.output_audio.delta', delta: Buffer.from([3, 0, 4, 0]).toString('base64') });
    await server.waitFor((f) => f.type === 'session.input_audio.append');
    await tick();

    expect(server.sent.find((f) => f.type === 'session.input_audio.append')?.audio).toBe(
      Buffer.from([1, 0, 2, 0]).toString('base64'),
    );
    expect(heard).toEqual([Buffer.from([3, 0, 4, 0])]);
  });

  it('answers every call of a response together, after the response completes', async () => {
    const { server, session } = await open();
    const calls: string[] = [];
    session.on('functionCall', (call) => calls.push(call.name));

    server.emit(functionCallEvent('call_1', 'get_time'));
    server.emit(functionCallEvent('call_2', 'get_time'));
    await tick();
    session.sendFunctionOutput('call_1', '{"time":"3:45 PM"}');
    server.emit(responseCompletedEvent());
    await tick();

    // The second call has no output yet, so nothing goes back.
    expect(server.sent.filter((f) => f.type === 'response.item.create')).toHaveLength(0);

    session.sendFunctionOutput('call_2', '{"time":"3:46 PM"}');
    await server.waitFor((f) => f.type === 'response.create');

    const replies = server.sent.filter((f) => f.type === 'response.item.create' || f.type === 'response.create');
    expect(calls).toEqual(['get_time', 'get_time']);
    expect(replies).toEqual([
      { type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: '{"time":"3:45 PM"}' } },
      { type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_2', output: '{"time":"3:46 PM"}' } },
      { type: 'response.create' },
    ]);
  });

  it('holds a picture shown during a tool call until the call is answered', async () => {
    const { server, session } = await open();

    server.emit(functionCallEvent('call_1', 'see_screen'));
    await tick();
    session.showBackend([{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }], false);
    session.sendFunctionOutput('call_1', 'This is what my screen is showing.');
    server.emit(responseCompletedEvent());
    await server.waitFor((f) => f.type === 'response.create');

    expect(server.sent.filter((f) => f.type.startsWith('response.')).map((f) => f.item?.type ?? f.type)).toEqual([
      'function_call_output',
      'message',
      'response.create',
    ]);
  });

  it('asks the backend to answer a picture shown outside a tool call when told to', async () => {
    const { server, session } = await open();

    session.showBackend([{ type: 'input_text', text: 'The user shared their screen.' }], true);
    await server.waitFor((f) => f.type === 'response.create');

    expect(server.sent.find((f) => f.type === 'response.item.create')?.item).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'The user shared their screen.' }],
    });
  });

  it('sends context as session-wide appends', async () => {
    const { server, session } = await open();

    session.appendInstructions('Your microphone is off.');
    session.appendThinking('Emma is speaking now.');
    session.appendCommentary('Greet the room.');
    await server.waitFor((f) => f.type === 'session.commentary.append');

    const appends = server.sent.filter((f) => f.type.endsWith('.append') && f.type !== 'session.input_audio.append');
    expect(appends.map(({ type, delegation_id, content }) => ({ type, delegation_id, content }))).toEqual([
      { type: 'session.instructions.append', delegation_id: null, content: 'Your microphone is off.' },
      { type: 'session.thinking.append', delegation_id: null, content: 'Emma is speaking now.' },
      { type: 'session.commentary.append', delegation_id: null, content: 'Greet the room.' },
    ]);
  });

  it('reports the backend usage and the delegations', async () => {
    const { server, session } = await open();
    const usage: { inputTokens: number; outputTokens: number }[] = [];
    let delegations = 0;
    session.on('backendUsage', (u) => usage.push(u));
    session.on('delegation', () => (delegations += 1));

    server.emit({ type: 'session.delegation.created', delegation: { id: 'item_1', type: 'delegation', target: 'responses' } });
    server.emit(responseCompletedEvent(813, 14));
    await tick();

    expect(delegations).toBe(1);
    expect(usage).toEqual([{ inputTokens: 813, outputTokens: 14 }]);
  });

  it('reports the API close reason and the voice time when the server ends the session', async () => {
    const { server, session } = await open();
    const closed = new Promise<[string, number | null]>((resolve) =>
      session.on('closed', (reason, seconds) => resolve([reason, seconds])),
    );

    server.closeWith('expired', 7200);

    await expect(closed).resolves.toEqual(['expired', 7200]);
    expect(session.isOpen).toBe(false);
  });

  it('closes with session.close and resolves once the final usage has arrived', async () => {
    const { server, session: live } = await open();
    const closed = new Promise<[string, number | null]>((resolve) =>
      live.on('closed', (reason, seconds) => resolve([reason, seconds])),
    );

    await live.close();
    session = null;

    expect(server.sent.at(-1)).toEqual({ type: 'session.close' });
    await expect(closed).resolves.toEqual(['close_requested', 42]);
  });
});
