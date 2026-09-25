/**
 * The GPT-Live wire protocol, against a local server that answers the way the live
 * endpoint does.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'net';
import { LiveSession, type LiveSessionOptions } from '../live-session';
import { startLiveServer, type LiveServer } from '../../../test-utils/live-server';

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
});

async function open(overrides: Partial<LiveSessionOptions> = {}): Promise<{ server: LiveServer; session: LiveSession }> {
  server = await startLiveServer();
  session = new LiveSession({
    instructions: 'You are Prism, the voice.',
    voice: 'marin',
    endpointOverride: { url: server.url, headers: {} },
    ...overrides,
  });
  await session.connect();
  return { server, session };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('LiveSession', () => {
  it('starts the session with the voice, delegating to the client', async () => {
    const { server } = await open();
    const start = await server.started;

    expect(start.session).toEqual({
      model: 'gpt-live-1',
      instructions: 'You are Prism, the voice.',
      audio: { output: { voice: 'marin' } },
      delegation: { type: 'client' },
    });
  });

  it('rejects a start the API refuses, naming why', async () => {
    server = await startLiveServer({ refuseWith: { code: 'model_not_found', message: 'The model does not exist' } });
    session = new LiveSession({
      instructions: 'x',
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

  it('sends a delegation result and its progress with the delegation id', async () => {
    const { server, session } = await open();

    session.appendThinking('Still working: 3 steps so far.', 'item_1');
    session.appendCommentary('You have two tasks scheduled.', 'item_1');
    await server.waitFor((f) => f.type === 'session.commentary.append');

    const appends = server.sent.filter((f) => f.type === 'session.thinking.append' || f.type === 'session.commentary.append');
    expect(appends.map(({ type, delegation_id }) => ({ type, delegation_id }))).toEqual([
      { type: 'session.thinking.append', delegation_id: 'item_1' },
      { type: 'session.commentary.append', delegation_id: 'item_1' },
    ]);
  });

  it('reports a delegation with where it falls, and the transcript with its timing', async () => {
    // Frames as the API sends them for client delegation.
    const { server, session } = await open();
    const delegations: [string, number | null][] = [];
    const heard: [string, string, number | null][] = [];
    session.on('delegation', (id, offsetMs) => delegations.push([id, offsetMs]));
    session.on('transcript', (side, delta, startMs) => heard.push([side, delta, startMs]));

    server.emit({ type: 'session.input_transcript.delta', delta: 'What is on my', start_ms: 600, end_ms: 800 });
    server.emit({ type: 'session.output_transcript.delta', delta: 'One sec.', start_ms: 1200, end_ms: 1400 });
    server.emit({
      type: 'session.delegation.created',
      offset_ms: 1000,
      delegation: { id: 'item_delegation_123', type: 'delegation', target: 'client' },
    });
    await tick();

    expect(heard).toEqual([
      ['input', 'What is on my', 600],
      ['output', 'One sec.', 1200],
    ]);
    expect(delegations).toEqual([['item_delegation_123', 1000]]);
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
