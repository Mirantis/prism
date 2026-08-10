/**
 * Protocol-level tests against a real local WebSocket server, so the frames the
 * session sends are checked as they'd go over the wire rather than through a mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { RealtimeSession } from '../realtime-session';

interface Harness {
  session: RealtimeSession;
  /** Frames the session sent, parsed. */
  sent: Array<Record<string, unknown>>;
  /** Push a server event to the session. */
  emit: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function harness(options: Partial<Parameters<typeof makeSession>[0]> = {}): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  const sent: Array<Record<string, unknown>> = [];
  let socket: ServerSocket | null = null;
  const connected = new Promise<void>((resolve) => {
    server.once('connection', (ws) => {
      socket = ws;
      ws.on('message', (data) => sent.push(JSON.parse(data.toString())));
      resolve();
    });
  });

  const session = makeSession({ port, ...options });
  await session.connect();
  await connected;
  // Let the initial session.update land before a test inspects the frames.
  await new Promise((r) => setTimeout(r, 20));

  return {
    session,
    sent,
    emit: (event) => socket?.send(JSON.stringify(event)),
    close: async () => {
      session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeSession(options: {
  port: number;
  addressedOnly?: boolean;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  instructions?: string;
}): RealtimeSession {
  return new RealtimeSession({
    instructions: options.instructions ?? 'You are Prism.',
    tools: options.tools ?? [],
    addressedOnly: options.addressedOnly,
    endpointOverride: { url: `ws://127.0.0.1:${options.port}`, headers: {} },
  });
}

let active: Harness | null = null;
beforeEach(() => {
  active = null;
});
afterEach(async () => {
  await active?.close();
});

describe('RealtimeSession configuration', () => {
  it('configures 24kHz pcm16 both ways with semantic VAD', async () => {
    active = await harness();
    const update = active.sent.find((f) => f.type === 'session.update') as
      | { session: Record<string, any> }
      | undefined;

    expect(update).toBeDefined();
    const audio = update!.session.audio;
    expect(audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(audio.input.turn_detection).toMatchObject({ type: 'semantic_vad', eagerness: 'low' });
  });

  it('lets the model answer on its own but never auto-interrupt', async () => {
    active = await harness();
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    expect(update.session.audio.input.turn_detection.create_response).toBe(true);
    // Server-side interruption would cut the bot off on a cough; barge-in is local.
    expect(update.session.audio.input.turn_detection.interrupt_response).toBe(false);
  });

  it('carries the agent system prompt as instructions', async () => {
    active = await harness({ instructions: '# Identity\n\nYou are **Prism**.' });
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    expect(update.session.instructions).toContain('You are **Prism**');
  });

  it('in addressed-only mode suppresses auto-response and enables transcription', async () => {
    active = await harness({ addressedOnly: true });
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    expect(update.session.audio.input.turn_detection.create_response).toBe(false);
    // Transcription is only for deciding who was addressed, never model input.
    expect(update.session.audio.input.transcription).toBeDefined();
  });

  it('declares the agent tools as function tools', async () => {
    active = await harness({
      tools: [
        { name: 'list_scheduled_tasks', description: 'List tasks', parameters: { type: 'object', properties: {} } },
      ],
    });
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    expect(update.session.tools).toEqual([
      { type: 'function', name: 'list_scheduled_tasks', description: 'List tasks', parameters: { type: 'object', properties: {} } },
    ]);
    expect(update.session.tool_choice).toBe('auto');
  });

  it('omits the tools block entirely when there are none', async () => {
    active = await harness({ tools: [] });
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    expect(update.session.tools).toBeUndefined();
  });
});

describe('RealtimeSession events', () => {
  it('decodes audio deltas to pcm buffers', async () => {
    active = await harness();
    const received: Array<{ pcm: Buffer; itemId: string }> = [];
    active.session.on('audio', (pcm, itemId) => received.push({ pcm, itemId }));

    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    active.emit({ type: 'response.output_audio.delta', delta: pcm.toString('base64'), item_id: 'item-1' });
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
    expect(received[0].pcm.equals(pcm)).toBe(true);
    expect(received[0].itemId).toBe('item-1');
  });

  it('also accepts the pre-GA audio event name', async () => {
    active = await harness();
    const received: Buffer[] = [];
    active.session.on('audio', (pcm) => received.push(pcm));

    active.emit({ type: 'response.audio.delta', delta: Buffer.from([9, 9]).toString('base64'), item_id: 'i' });
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
  });

  it('surfaces speech start and stop', async () => {
    active = await harness();
    const events: string[] = [];
    active.session.on('speechStarted', () => events.push('start'));
    active.session.on('speechStopped', () => events.push('stop'));

    active.emit({ type: 'input_audio_buffer.speech_started' });
    active.emit({ type: 'input_audio_buffer.speech_stopped' });
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toEqual(['start', 'stop']);
  });

  it('surfaces a finished function call', async () => {
    active = await harness();
    const calls: unknown[] = [];
    active.session.on('functionCall', (c) => calls.push(c));

    active.emit({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'list_scheduled_tasks',
      arguments: '{"limit":3}',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toEqual([{ callId: 'call-1', name: 'list_scheduled_tasks', argumentsJson: '{"limit":3}' }]);
  });

  it('ignores a malformed function call rather than emitting a half event', async () => {
    active = await harness();
    const calls: unknown[] = [];
    active.session.on('functionCall', (c) => calls.push(c));

    active.emit({ type: 'response.function_call_arguments.done', arguments: '{}' });
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toEqual([]);
  });

  it('reports an API error without closing', async () => {
    active = await harness();
    const errors: string[] = [];
    active.session.on('apiError', (m) => errors.push(m));

    active.emit({ type: 'error', error: { message: 'rate limited' } });
    await new Promise((r) => setTimeout(r, 20));

    expect(errors).toEqual(['rate limited']);
    expect(active.session.isOpen).toBe(true);
  });

  it('survives an unparseable frame', async () => {
    active = await harness();
    active.emit({ type: 'session.updated' });
    await new Promise((r) => setTimeout(r, 20));
    expect(active.session.isOpen).toBe(true);
  });
});

describe('RealtimeSession outbound frames', () => {
  it('base64-encodes appended audio', async () => {
    active = await harness();
    active.session.sendAudio(Buffer.from([0x10, 0x20]));
    await new Promise((r) => setTimeout(r, 20));

    const append = active.sent.find((f) => f.type === 'input_audio_buffer.append');
    expect(append).toMatchObject({ audio: Buffer.from([0x10, 0x20]).toString('base64') });
  });

  it('skips an empty audio buffer', async () => {
    active = await harness();
    active.session.sendAudio(Buffer.alloc(0));
    await new Promise((r) => setTimeout(r, 20));

    expect(active.sent.filter((f) => f.type === 'input_audio_buffer.append')).toHaveLength(0);
  });

  it('truncates the spoken item at what was actually heard', async () => {
    active = await harness();
    active.emit({ type: 'response.created' });
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item-7' });
    await new Promise((r) => setTimeout(r, 20));

    active.session.interrupt(1234.6);
    await new Promise((r) => setTimeout(r, 20));

    expect(active.sent.some((f) => f.type === 'response.cancel')).toBe(true);
    expect(active.sent.find((f) => f.type === 'conversation.item.truncate')).toMatchObject({
      item_id: 'item-7',
      content_index: 0,
      audio_end_ms: 1235,
    });
  });

  it('does not cancel when no response is in flight', async () => {
    active = await harness();
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item-8' });
    await new Promise((r) => setTimeout(r, 20));

    active.session.interrupt(100);
    await new Promise((r) => setTimeout(r, 20));

    expect(active.sent.some((f) => f.type === 'response.cancel')).toBe(false);
    // The truncate still goes: the item exists even if generation finished.
    expect(active.sent.some((f) => f.type === 'conversation.item.truncate')).toBe(true);
  });

  it('discards audio that was already in flight when the interrupt committed', async () => {
    active = await harness();
    const received: Buffer[] = [];
    active.session.on('audio', (pcm) => received.push(pcm));

    active.emit({ type: 'response.created' });
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item-1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);

    active.session.interrupt(500);

    // The socket keeps delivering the abandoned response's tail. Forwarding it
    // would restart playback over the person who just interrupted, and would push
    // played-ms past the audio_end_ms already reported.
    active.emit({ type: 'response.output_audio.delta', delta: 'BBBB', item_id: 'item-1' });
    active.emit({ type: 'response.output_audio.delta', delta: 'CCCC', item_id: 'item-1' });
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
  });

  it('still plays the next utterance after an interrupt', async () => {
    active = await harness();
    const received: string[] = [];
    active.session.on('audio', (_pcm, itemId) => received.push(itemId));

    active.emit({ type: 'response.created' });
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item-1' });
    await new Promise((r) => setTimeout(r, 20));
    active.session.interrupt(100);

    active.emit({ type: 'response.output_audio.delta', delta: 'DDDD', item_id: 'item-2' });
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toEqual(['item-1', 'item-2']);
  });

  it('truncates only once per interrupted item', async () => {
    active = await harness();
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item-9' });
    await new Promise((r) => setTimeout(r, 20));

    active.session.interrupt(100);
    active.session.interrupt(200);
    await new Promise((r) => setTimeout(r, 20));

    expect(active.sent.filter((f) => f.type === 'conversation.item.truncate')).toHaveLength(1);
  });

  it('follows a tool result with an explicit response request', async () => {
    active = await harness();
    active.session.sendFunctionOutput('call-1', '{"ok":true}');
    await new Promise((r) => setTimeout(r, 20));

    const item = active.sent.find((f) => f.type === 'conversation.item.create') as { item: Record<string, unknown> };
    expect(item.item).toEqual({ type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' });
    // Without this the answer is never spoken.
    expect(active.sent.some((f) => f.type === 'response.create')).toBe(true);
  });

  it('defers a response request until the open response finishes', async () => {
    active = await harness();
    active.emit({ type: 'response.created' });
    await new Promise((r) => setTimeout(r, 20));

    // A tool that answers fast gets here before response.done: the API rejects a
    // second response.create, so the answer would never be spoken.
    active.session.sendFunctionOutput('call-1', '{"ok":true}');
    await new Promise((r) => setTimeout(r, 20));
    expect(active.sent.filter((f) => f.type === 'response.create')).toHaveLength(0);

    active.emit({ type: 'response.done' });
    await new Promise((r) => setTimeout(r, 20));

    expect(active.sent.filter((f) => f.type === 'response.create')).toHaveLength(1);
  });

  it('abandons a deferred response when a human takes the floor', async () => {
    active = await harness();
    active.emit({ type: 'response.created' });
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'i-1' });
    await new Promise((r) => setTimeout(r, 20));

    active.session.sendFunctionOutput('call-1', '{"ok":true}');
    active.session.interrupt(200);
    active.emit({ type: 'response.done' });
    await new Promise((r) => setTimeout(r, 20));

    // The human's speech decides the next turn, not a queued tool answer.
    expect(active.sent.filter((f) => f.type === 'response.create')).toHaveLength(0);
  });

  it('injects context as a user message', async () => {
    active = await harness();
    active.session.sendContext('You have just been admitted.');
    await new Promise((r) => setTimeout(r, 20));

    const item = active.sent.find((f) => f.type === 'conversation.item.create') as { item: Record<string, any> };
    expect(item.item.role).toBe('user');
    expect(item.item.content[0].text).toBe('You have just been admitted.');
  });

  it('drops sends after close instead of throwing', async () => {
    active = await harness();
    active.session.close();
    await new Promise((r) => setTimeout(r, 20));

    expect(() => active!.session.sendAudio(Buffer.from([1, 2]))).not.toThrow();
    expect(active.session.isOpen).toBe(false);
  });
});

describe('RealtimeSession connection failure', () => {
  it('rejects with a clear message when the socket cannot open', async () => {
    const session = new RealtimeSession({
      instructions: 'x',
      tools: [],
      // Port 1 is reserved and refuses connections.
      endpointOverride: { url: 'ws://127.0.0.1:1', headers: {} },
    });

    await expect(session.connect()).rejects.toThrow(/Realtime connection failed/);
  });
});
