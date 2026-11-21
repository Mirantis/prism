/**
 * Protocol-level tests against a real local WebSocket server, so the frames the
 * session sends are checked as they'd go over the wire rather than through a mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { RealtimeSession } from '../realtime-session';
import { recordRealtimeUsage } from '../realtime-usage';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../realtime-usage', () => ({ recordRealtimeUsage: vi.fn() }));

const SPEND = { purpose: 'meeting', requestId: 'call-1' } as const;

/** Every `warn` line emitted so far, joined — enough to assert one was written. */
function warnings(): string {
  return vi
    .mocked(logger.warn)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
}

interface Harness {
  session: RealtimeSession;
  /** Frames the session sent, parsed. */
  sent: Array<Record<string, unknown>>;
  /** Push a server event to the session. */
  emit: (event: Record<string, unknown>) => void;
  /** Close the socket from the server's side, as OpenAI would on a drop. */
  dropFromServer: () => void;
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
    dropFromServer: () => socket?.close(1011, 'server gone'),
    close: async () => {
      session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeSession(options: {
  port: number;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  instructions?: string;
}): RealtimeSession {
  return new RealtimeSession({
    instructions: options.instructions ?? 'You are Prism.',
    tools: options.tools ?? [],
    endpointOverride: { url: `ws://127.0.0.1:${options.port}`, headers: {} },
    spend: SPEND,
  });
}

/** Base64 for `ms` of pcm16 @24kHz — lets a test emit a realistic amount of audio. */
function silenceDelta(ms: number): string {
  return Buffer.alloc(Math.round((ms / 1000) * 24000) * 2).toString('base64');
}

let active: Harness | null = null;
beforeEach(() => {
  active = null;
  vi.mocked(logger.warn).mockClear();
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
    // `medium` rather than `low`: semantic VAD still judges meaning rather than
    // silence, so a mid-thought pause isn't read as the end of a turn, but it stops
    // waiting as long to say so — dead air before every answer was the single
    // biggest source of perceived latency on a live call.
    expect(audio.input.turn_detection).toMatchObject({
      type: 'semantic_vad',
      eagerness: 'medium',
    });
  });

  it('asks the model to reason before it answers or picks a tool', async () => {
    // Sending nothing here is not neutral: the API's own default is `low`, and
    // this model drives the agent's real toolset from an unauthenticated room.
    active = await harness();
    const update = active.sent.find((f) => f.type === 'session.update') as {
      session: Record<string, any>;
    };

    expect(update.session.reasoning).toEqual({ effort: 'high' });
  });

  it('sends no reasoning block at all when the level is handed back to the API', async () => {
    // The opt-out has to omit the key, not send an empty one: `effort: null` is a
    // rejected session parameter, which ends the call rather than lowering it.
    const restore = config.openaiRealtimeReasoningEffort;
    (config as { openaiRealtimeReasoningEffort: string | null }).openaiRealtimeReasoningEffort =
      null;
    try {
      active = await harness();
      const update = active.sent.find((f) => f.type === 'session.update') as {
        session: Record<string, any>;
      };

      expect('reasoning' in update.session).toBe(false);
    } finally {
      (config as { openaiRealtimeReasoningEffort: string | null }).openaiRealtimeReasoningEffort =
        restore;
    }
  });

  it('never lets the server answer or interrupt on its own', async () => {
    active = await harness();
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    // The room is one mixed channel, so "someone stopped talking" says nothing
    // about who they meant. Responses are asked for by response-policy.ts.
    expect(update.session.audio.input.turn_detection.create_response).toBe(false);
    // Server-side interruption would cut the agent off on a cough; barge-in is local.
    expect(update.session.audio.input.turn_detection.interrupt_response).toBe(false);
  });

  it('carries the agent system prompt as instructions', async () => {
    active = await harness({ instructions: '# Identity\n\nYou are **Prism**.' });
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    expect(update.session.instructions).toContain('You are **Prism**');
  });

  it('asks for no transcription when the words will not be written down', async () => {
    // Nothing decides anything from the transcript any more, so under the default
    // `off` it was billing per audio minute for text that was then deliberately
    // dropped.
    active = await harness();
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    expect('transcription' in update.session.audio.input).toBe(false);
  });

  it('transcribes when the log contains the words', async () => {
    const restore = config.meetingTranscriptLogging;
    (config as { meetingTranscriptLogging: string }).meetingTranscriptLogging = 'full';
    try {
      active = await harness();
      const update = active.sent.find((f) => f.type === 'session.update') as {
        session: Record<string, any>;
      };

      // No language: a call can be in any language, and the transcriber detects it.
      expect(update.session.audio.input.transcription).toEqual({
        model: 'gpt-realtime-whisper',
      });
    } finally {
      (config as { meetingTranscriptLogging: string }).meetingTranscriptLogging = restore;
    }
  });

  it('sends no noise-reduction key by default, because Meet has already cleaned this audio', async () => {
    // The whole key has to go, not a null one: the API rejects a null here, which
    // would end the call rather than disable the filter. Reducing again is a second
    // pass over a mix Meet has already suppressed, cancelled and levelled — and under
    // `far_field` a live agent stopped reacting to a person in the room while still
    // answering the other agent's much louder synthesized voice.
    active = await harness();
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    expect(update.session.audio.input).not.toHaveProperty('noise_reduction');
    // The rest of the input config must survive the omission.
    expect(update.session.audio.input.turn_detection.type).toBe('semantic_vad');
  });

  it('asks for reduction when an operator sets one', async () => {
    vi.mocked(config).noiseReduction = 'far_field';
    active = await harness();
    const update = active.sent.find((f) => f.type === 'session.update') as { session: Record<string, any> };

    expect(update.session.audio.input.noise_reduction).toEqual({ type: 'far_field' });
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
  it('records the usage of every finished response and transcription', async () => {
    active = await harness();
    vi.mocked(recordRealtimeUsage).mockClear();
    const usage = { input_tokens: 120, output_tokens: 40, input_token_details: { audio_tokens: 100 } };

    active.emit({ type: 'response.done', response: { id: 'resp-1', status: 'completed', usage } });
    active.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'hello',
      usage: { type: 'tokens', input_tokens: 30, output_tokens: 2 },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(recordRealtimeUsage).mock.calls).toEqual([
      [SPEND, config.openaiRealtimeModel, usage],
      [SPEND, config.openaiTranscriptionModel, { type: 'tokens', input_tokens: 30, output_tokens: 2 }],
    ]);
  });

  it('reports a committed utterance, which is the cue to decide on answering', async () => {
    active = await harness();
    const committed: string[] = [];
    active.session.on('utteranceCommitted', (itemId) => committed.push(itemId));

    active.emit({ type: 'input_audio_buffer.committed', item_id: 'item-7' });
    await new Promise((r) => setTimeout(r, 20));

    // Arrives before any transcript exists, which is what lets a one-to-one call
    // answer as promptly as it did when the server created responses itself.
    expect(committed).toEqual(['item-7']);
  });

  it('tracks spoken turns for a probe to draw context from, tool output excluded', async () => {
    active = await harness();

    const spoken = (id: string) => ({
      id,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_audio' }],
    });
    active.emit({ type: 'conversation.item.added', item: spoken('u-1') });
    active.emit({ type: 'conversation.item.added', item: { id: 'a-1', type: 'message', role: 'assistant' } });
    // One tool result can be 12,000 characters — measured at ~2,900 tokens — and
    // says nothing about who was addressed. Including it would make a probe cost
    // more than the room does.
    active.emit({ type: 'conversation.item.added', item: { id: 'fc-1', type: 'function_call', name: 'shell_exec' } });
    active.emit({
      type: 'conversation.item.added',
      item: { id: 'fo-1', type: 'function_call_output', call_id: 'c1' },
    });
    // Injected by the runtime rather than said out loud — an admission note or a
    // roster update. It would otherwise fill the window with our own writing.
    active.emit({
      type: 'conversation.item.added',
      item: { id: 'ctx-1', type: 'message', role: 'user', content: [{ type: 'input_text' }] },
    });
    active.emit({ type: 'conversation.item.added', item: spoken('u-2') });
    await new Promise((r) => setTimeout(r, 20));

    expect(active.session.recentConversationItems(10)).toEqual(['u-1', 'a-1', 'u-2']);
    // Oldest first, so a window takes the newest by slicing the tail.
    expect(active.session.recentConversationItems(2)).toEqual(['a-1', 'u-2']);
    expect(active.session.recentConversationItems(0)).toEqual([]);
  });

  it('does not record the same turn twice when both item events arrive', async () => {
    active = await harness();
    const turn = { id: 'u-1', type: 'message', role: 'user', content: [{ type: 'input_audio' }] };
    active.emit({ type: 'conversation.item.added', item: turn });
    active.emit({ type: 'conversation.item.created', item: turn });
    await new Promise((r) => setTimeout(r, 20));

    expect(active.session.recentConversationItems(10)).toEqual(['u-1']);
  });

  // Both of the following leave the agent silent through an utterance without the
  // gate ever being consulted, which from outside looks exactly like a gate that
  // heard the sentence and judged it unaddressed. They are logged loudly enough to
  // be read back from a deployed container, because that is the only thing that
  // tells the two apart.
  it('warns when transcription fails, since the call cannot then be read back', async () => {
    active = await harness();

    active.emit({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'item-8',
      error: { message: 'audio too short' },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(warnings()).toContain('item-8');
    expect(warnings()).toContain('audio too short');
    expect(warnings()).toMatch(/will not appear in the log/);
  });

  it('warns when a completed transcription carries no text', async () => {
    active = await harness();
    const seen: string[] = [];
    active.session.on('transcript', (_id, text) => seen.push(text));

    active.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-6',
      transcript: '   ',
    });
    await new Promise((r) => setTimeout(r, 20));

    // Still emits nothing — the change is that it no longer does so silently.
    expect(seen).toEqual([]);
    expect(warnings()).toContain('item-6');
    expect(warnings()).toMatch(/came back empty/);
  });

  it('tags a transcript with the item it belongs to', async () => {
    active = await harness();
    const seen: Array<[string, string]> = [];
    active.session.on('transcript', (itemId, text) => seen.push([itemId, text]));

    active.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-7',
      transcript: '  Prism, check the cluster  ',
    });
    await new Promise((r) => setTimeout(r, 20));

    // The id is what stops the commit path and this one both answering the same
    // utterance — a duplicate would be queued, not dropped, and spoken twice.
    expect(seen).toEqual([['item-7', 'Prism, check the cluster']]);
  });

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
    active.emit({ type: 'response.created', response: { id: 'resp-1' } });
    // Enough generated audio that the truncation point below is legal.
    active.emit({ type: 'response.output_audio.delta', delta: silenceDelta(2000), item_id: 'item-7', response_id: 'resp-1' });
    await new Promise((r) => setTimeout(r, 20));

    active.session.interrupt([{ itemId: 'item-7', playedMs: 1234.6, sentMs: 2000 }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(active.sent.some((f) => f.type === 'response.cancel')).toBe(true);
    expect(active.sent.find((f) => f.type === 'conversation.item.truncate')).toMatchObject({
      item_id: 'item-7',
      content_index: 0,
      // played + 50ms of slack, per OpenAI's transport: cutting at exactly the
      // measured played-ms makes the model repeat the last word or two.
      audio_end_ms: 1284,
    });
  });

  it('truncates every audio item of an interrupted turn', async () => {
    active = await harness();
    // gpt-realtime-2.x speaks a native preamble as its own item, then the answer as
    // another. Truncating only the newest leaves the preamble in context as words
    // the model believes it delivered.
    active.emit({ type: 'response.created', response: { id: 'resp-1' } });
    active.emit({ type: 'response.output_audio.delta', delta: silenceDelta(1000), item_id: 'preamble', response_id: 'resp-1' });
    active.emit({ type: 'response.output_audio.delta', delta: silenceDelta(1000), item_id: 'answer', response_id: 'resp-1' });
    await new Promise((r) => setTimeout(r, 20));

    active.session.interrupt([
      // A fully-played preamble: sent == played, so the slack is clamped away.
      { itemId: 'preamble', playedMs: 800, sentMs: 800 },
      { itemId: 'answer', playedMs: 120, sentMs: 1000 },
    ]);
    await new Promise((r) => setTimeout(r, 20));

    const truncates = active.sent.filter((f) => f.type === 'conversation.item.truncate');
    expect(truncates).toHaveLength(2);
    expect(truncates[0]).toMatchObject({ item_id: 'preamble', audio_end_ms: 800 });
    expect(truncates[1]).toMatchObject({ item_id: 'answer', audio_end_ms: 170 });
  });

  it('does not cancel when no response is in flight', async () => {
    active = await harness();
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item-8' });
    await new Promise((r) => setTimeout(r, 20));

    active.session.interrupt([{ itemId: 'item-8', playedMs: 100, sentMs: 100 }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(active.sent.some((f) => f.type === 'response.cancel')).toBe(false);
    // The truncate still goes: the item exists even if generation finished.
    expect(active.sent.some((f) => f.type === 'conversation.item.truncate')).toBe(true);
  });

  it('discards audio that was already in flight when the interrupt committed', async () => {
    active = await harness();
    const received: Buffer[] = [];
    active.session.on('audio', (pcm) => received.push(pcm));

    active.emit({ type: 'response.created', response: { id: 'resp-1' } });
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item-1', response_id: 'resp-1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);

    active.session.interrupt([{ itemId: 'item-1', playedMs: 500, sentMs: 500 }]);

    // The socket keeps delivering the abandoned turn's tail. Forwarding it would
    // restart playback over the person who just interrupted.
    active.emit({ type: 'response.output_audio.delta', delta: 'BBBB', item_id: 'item-1', response_id: 'resp-1' });
    // A *later item* of the same abandoned turn must be dropped too — an item-keyed
    // discard set would happily play this one.
    active.emit({ type: 'response.output_audio.delta', delta: 'CCCC', item_id: 'item-2', response_id: 'resp-1' });
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
  });

  it('still plays the next turn after an interrupt', async () => {
    active = await harness();
    const received: string[] = [];
    active.session.on('audio', (_pcm, itemId) => received.push(itemId));

    active.emit({ type: 'response.created', response: { id: 'resp-1' } });
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item-1', response_id: 'resp-1' });
    await new Promise((r) => setTimeout(r, 20));
    active.session.interrupt([{ itemId: 'item-1', playedMs: 100, sentMs: 100 }]);

    // A genuinely new turn must still be heard.
    active.emit({ type: 'response.created', response: { id: 'resp-2' } });
    active.emit({ type: 'response.output_audio.delta', delta: 'DDDD', item_id: 'item-2', response_id: 'resp-2' });
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toEqual(['item-1', 'item-2']);
  });

  it('caps audio_end_ms at what the server actually generated', async () => {
    active = await harness();
    active.emit({ type: 'response.created', response: { id: 'resp-1' } });
    // 8 base64 chars -> 6 bytes -> 3 samples -> ~0.125ms of generated audio.
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAAAAAA', item_id: 'item-x', response_id: 'resp-1' });
    await new Promise((r) => setTimeout(r, 20));

    // A played-ms beyond the item's real duration is rejected by the API outright,
    // which would turn a barge-in into a protocol error mid-call.
    active.session.interrupt([{ itemId: 'item-x', playedMs: 99_999, sentMs: 99_999 }]);
    await new Promise((r) => setTimeout(r, 20));

    const truncate = active.sent.find((f) => f.type === 'conversation.item.truncate') as { audio_end_ms: number };
    expect(truncate.audio_end_ms).toBeLessThan(10);
  });

  it('truncates an item that never started at zero', async () => {
    active = await harness();
    active.emit({ type: 'response.created', response: { id: 'resp-1' } });
    active.emit({ type: 'response.output_audio.delta', delta: silenceDelta(500), item_id: 'heard', response_id: 'resp-1' });
    active.emit({ type: 'response.output_audio.delta', delta: silenceDelta(500), item_id: 'unheard', response_id: 'resp-1' });
    await new Promise((r) => setTimeout(r, 20));

    active.session.interrupt([
      { itemId: 'heard', playedMs: 300, sentMs: 300 },
      // Queued but never handed to the device: nothing was heard, so its transcript
      // must leave the context entirely rather than gain 50ms of slack.
      { itemId: 'unheard', playedMs: 0, sentMs: 0 },
    ]);
    await new Promise((r) => setTimeout(r, 20));

    const truncates = active.sent.filter((f) => f.type === 'conversation.item.truncate');
    expect(truncates[1]).toMatchObject({ item_id: 'unheard', audio_end_ms: 0 });
  });

  it('sends nothing when there is nothing left to truncate', async () => {
    active = await harness();
    active.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item-9' });
    await new Promise((r) => setTimeout(r, 20));

    // Playback reports the items; a second interrupt with an empty list (everything
    // already flushed) must not invent a truncate.
    active.session.interrupt([{ itemId: 'item-9', playedMs: 100, sentMs: 100 }]);
    active.session.interrupt([]);
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
    active.session.interrupt([{ itemId: 'i-1', playedMs: 200, sentMs: 200 }]);
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

  it('sends a screenshot as an image item nobody said', async () => {
    // Two things ride on this frame's shape. The Realtime API takes an image only in a
    // user message, and the addressed gate's window keeps `input_audio` items — so an
    // item with no audio part is not counted as a turn in the room.
    active = await harness();
    active.session.sendImage('data:image/jpeg;base64,AAAA', 'This is your screen.');
    await new Promise((r) => setTimeout(r, 20));

    const item = active.sent.find((f) => f.type === 'conversation.item.create') as {
      item: Record<string, any>;
    };
    expect(item.item.type).toBe('message');
    expect(item.item.role).toBe('user');
    expect(item.item.content).toEqual([
      { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
      { type: 'input_text', text: 'This is your screen.' },
    ]);
    expect(item.item.content.some((part: { type: string }) => part.type === 'input_audio')).toBe(
      false,
    );
  });

  it("sends a recording as one item per window, each labelled beside its audio", async () => {
    active = await harness();
    active.session.sendRecording(
      [
        { label: '0:00', images: ['data:image/jpeg;base64,AAAA'], audio: Buffer.from([1, 2, 3, 4]) },
        { label: '0:30', images: [], audio: Buffer.from([5, 6]) },
      ],
      'Your user recorded their screen.',
    );
    await new Promise((r) => setTimeout(r, 20));

    const items = active.sent.filter((f) => f.type === 'conversation.item.create') as Array<{
      item: Record<string, any>;
    }>;
    // The note first, then a window each.
    expect(items).toHaveLength(3);
    expect(items[0].item.content).toEqual([
      { type: 'input_text', text: 'Your user recorded their screen.' },
    ]);
    expect(items[1].item.role).toBe('user');
    expect(items[1].item.content).toEqual([
      { type: 'input_text', text: 'At 0:00:' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
      { type: 'input_audio', audio: Buffer.from([1, 2, 3, 4]).toString('base64') },
    ]);
    // A window with nothing on the screen is still its own item, so the narration over it
    // keeps its place in the order.
    expect(items[2].item.content).toEqual([
      { type: 'input_text', text: 'At 0:30:' },
      { type: 'input_audio', audio: Buffer.from([5, 6]).toString('base64') },
    ]);
  });

  it('keeps a recording out of the window a probe re-reads', async () => {
    // A segment holds up to half a minute of audio, and a probe runs on every utterance.
    // Counting one as a turn in the room would have every later probe re-read the whole
    // recording. The label beside the audio is what tells the two apart.
    active = await harness();
    active.emit({
      type: 'conversation.item.added',
      item: { id: 'u-1', type: 'message', role: 'user', content: [{ type: 'input_audio' }] },
    });
    active.emit({
      type: 'conversation.item.added',
      item: {
        id: 'rec-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text' }, { type: 'input_image' }, { type: 'input_audio' }],
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(active.session.recentConversationItems(10)).toEqual(['u-1']);
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
  it('reports a rejected handshake status without retrying or logging secrets', async () => {
    let attempts = 0;
    const server = new WebSocketServer({
      port: 0,
      verifyClient: (_info, done) => { attempts += 1; done(false, 403, 'Forbidden'); },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const session = new RealtimeSession({
      instructions: 'x', tools: [],
      endpointOverride: { url: `ws://127.0.0.1:${port}/?secret=hidden`, headers: { Authorization: 'Bearer hidden-key' } },
      spend: SPEND,
    });
    try {
      await expect(session.connect()).rejects.toThrow(/Unexpected server response: 403/);
      expect(attempts).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 403, host: `127.0.0.1:${port}` }),
        '[Meeting] Realtime handshake failed',
      );
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('hidden');
    } finally {
      session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects with a clear message when the socket cannot open', async () => {
    const session = new RealtimeSession({
      instructions: 'x',
      tools: [],
      // Port 1 is reserved and refuses connections.
      endpointOverride: { url: 'ws://127.0.0.1:1', headers: {} },
      spend: SPEND,
    });

    await expect(session.connect()).rejects.toThrow(/Realtime connection failed/);
  });
});

/**
 * A question asked beside the conversation, so the agent can be asked "was that
 * for you?" without the asking becoming something it said.
 *
 * The risk these cover is not the frame — it is that a second response now exists
 * on a session whose bookkeeping was written for exactly one. Each test below is a
 * way the conversation's own turn gets corrupted by the probe finishing, failing,
 * or merely opening.
 */
describe('RealtimeSession out-of-band probes', () => {
  /**
   * The probe frame. Both kinds of request carry an `event_id`; only a probe
   * carries a `response` body, since the conversation's asks for nothing special.
   */
  function probeFrame(sent: Array<Record<string, unknown>>): Record<string, any> | undefined {
    return sent.find((f) => f.type === 'response.create' && f.response) as
      | Record<string, any>
      | undefined;
  }

  /** Requests the conversation made for itself. */
  function mainRequests(sent: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return sent.filter((f) => f.type === 'response.create' && !f.response);
  }

  /** Answer a probe the way the server would, by the id it was opened with. */
  function answerProbe(h: Harness, responseId: string, text: string): void {
    h.emit({
      type: 'response.done',
      response: { id: responseId, status: 'completed', output: [{ content: [{ text }] }] },
    });
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

  it('asks out of band, out of conversation, and without tools', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'Answer YES or NO.',
      input: [{ type: 'item_reference', id: 'item-7' }],
      metadata: { purpose: 'addressed-gate' },
      deadlineMs: 500,
      maxOutputTokens: 16,
      reasoningEffort: 'low',
    });
    await settle();

    const frame = probeFrame(active.sent)!;
    expect(frame).toBeDefined();
    // Out of the conversation, so a verdict never becomes part of what the agent
    // has said — and a word rather than speech.
    expect(frame.response.conversation).toBe('none');
    expect(frame.response.output_modalities).toEqual(['text']);
    expect(frame.response.instructions).toBe('Answer YES or NO.');
    // One reference, naming the utterance being judged. No audio is re-sent.
    expect(frame.response.input).toEqual([{ type: 'item_reference', id: 'item-7' }]);
    expect(frame.response.max_output_tokens).toBe(16);
    // Not inherited from the session, which runs at `high` for the agent's own
    // turns. A probe that thinks first spends its budget before writing a word.
    expect(frame.response.reasoning).toEqual({ effort: 'low' });
    // The session's tools are the agent's real ones, shell included. A probe reads
    // an untrusted utterance, so it must not be able to reach them.
    expect(frame.response.tools).toEqual([]);
    expect(frame.response.tool_choice).toBe('none');
    // The caller's metadata survives beside the marker that routes the reply.
    expect(frame.response.metadata.purpose).toBe('addressed-gate');
    expect(frame.response.metadata.prism_oob).toBe(frame.event_id);

    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    await settle();
    answerProbe(active, 'r-probe', 'YES');
    await expect(verdict).resolves.toBe('YES');
  });

  it('matches a verdict by its echoed marker when the open event was missed', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    const sendId = probeFrame(active.sent)!.event_id as string;

    // No `response.created` to record an id against — so the marker the server
    // echoes on `response.done` is the only way back to the waiting caller.
    active.emit({
      type: 'response.done',
      response: {
        id: 'r-unseen',
        status: 'completed',
        metadata: { prism_oob: sendId },
        output: [{ content: [{ text: 'YES' }] }],
      },
    });

    await expect(verdict).resolves.toBe('YES');
  });

  it('reads a verdict that arrives only as deltas', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();

    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    active.emit({ type: 'response.output_text.delta', response_id: 'r-probe', delta: 'NO' });
    active.emit({ type: 'response.done', response: { id: 'r-probe', status: 'completed' } });

    await expect(verdict).resolves.toBe('NO');
  });

  it('does not let a probe finishing release the conversation slot', async () => {
    active = await harness();
    // The agent is speaking.
    active.emit({ type: 'response.created', response: { id: 'r-main' } });
    await settle();

    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    await settle();

    // A tool result lands mid-turn and is deferred, as it always was.
    active.session.sendFunctionOutput('call-1', '{"ok":true}');
    await settle();
    expect(mainRequests(active.sent)).toHaveLength(0);

    // The probe finishes first. It must not look like the speaking turn ending:
    // that would fire the deferred request over the agent's own voice.
    answerProbe(active, 'r-probe', 'YES');
    await expect(verdict).resolves.toBe('YES');
    await settle();
    expect(mainRequests(active.sent)).toHaveLength(0);

    // Only the real turn ending releases it.
    active.emit({ type: 'response.done', response: { id: 'r-main', status: 'completed' } });
    await settle();
    expect(mainRequests(active.sent)).toHaveLength(1);
  });

  it('does not count a probe as a response the room heard', async () => {
    active = await harness();
    const done = vi.fn();
    active.session.on('responseDone', done);

    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    answerProbe(active, 'r-probe', 'NO');
    await verdict;

    // `responseDone` drives the spoken-response count and the latency marker.
    expect(done).not.toHaveBeenCalled();
  });

  it('cancels the speaking turn by id, leaving a probe in flight alone', async () => {
    active = await harness();
    active.emit({ type: 'response.created', response: { id: 'r-main' } });
    active.emit({ type: 'response.output_audio.delta', delta: silenceDelta(200), item_id: 'i-1' });
    await settle();

    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-2' }],
      deadlineMs: 500,
    });
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    await settle();

    // Somebody talks over the agent.
    active.session.interrupt([{ itemId: 'i-1', playedMs: 100, sentMs: 200 }]);
    await settle();

    const cancel = active.sent.find((f) => f.type === 'response.cancel') as Record<string, unknown>;
    // Named, so the probe cannot be what gets cancelled.
    expect(cancel.response_id).toBe('r-main');

    // The interrupted turn's tail is dropped...
    const audio = vi.fn();
    active.session.on('audio', audio);
    active.emit({
      type: 'response.output_audio.delta',
      delta: 'AAAA',
      item_id: 'i-1',
      response_id: 'r-main',
    });
    await settle();
    expect(audio).not.toHaveBeenCalled();

    // ...while the verdict for the interrupter's own utterance still lands.
    answerProbe(active, 'r-probe', 'YES');
    await expect(verdict).resolves.toBe('YES');
  });

  it('keeps two probes apart when the model answers them out of order', async () => {
    active = await harness();
    const first = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-1' } });
    await settle();

    const second = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-2' }],
      deadlineMs: 500,
    });
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-2' } });
    await settle();

    // Answered newest-first. Each verdict must land on its own utterance — this is
    // the whole reason a probe names the item it is judging.
    answerProbe(active, 'r-2', 'YES');
    answerProbe(active, 'r-1', 'NO');

    await expect(first).resolves.toBe('NO');
    await expect(second).resolves.toBe('YES');
  });

  it('gives up on a probe the server never answers, and ignores a late verdict', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 40,
    });
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });

    // No answer: silence is reported as silence, and the caller decides.
    await expect(verdict).resolves.toBeNull();
    expect(warnings()).toMatch(/went unanswered/);

    // A verdict nobody is waiting for must not throw or resolve twice.
    answerProbe(active, 'r-probe', 'YES');
    await settle();
  });

  it('fails a rejected probe by its event id without touching the conversation', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    const sendId = probeFrame(active.sent)!.event_id as string;

    // A rejected response.create never opens a response, so the echoed client
    // event_id is the only thing that says which request failed.
    // `error.event_id` names the client event that failed; the top-level one is the
    // server's id for the error itself. Reading the wrong one matched nothing, so
    // every rejection fell through and queued a phantom conversation response.
    active.emit({
      type: 'error',
      event_id: 'event_server_side',
      error: {
        message: 'Conversation already has an active response in progress',
        event_id: sendId,
      },
    });
    await expect(verdict).resolves.toBeNull();

    // The rejection must not queue a phantom answer: were the probe's failure read
    // as the conversation's, this request would be deferred rather than sent, and
    // would later speak unprompted.
    active.session.requestResponse();
    await settle();
    expect(mainRequests(active.sent)).toHaveLength(1);
  });

  it('never executes a tool call arriving on a probe', async () => {
    active = await harness();
    const calls = vi.fn();
    active.session.on('functionCall', calls);

    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    await settle();

    active.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'r-probe',
      call_id: 'call-1',
      name: 'shell_exec',
      arguments: '{"command":"rm -rf /"}',
    });
    await settle();

    // A meeting is unauthenticated speech and `meeting` mode withholds nothing.
    expect(calls).not.toHaveBeenCalled();
    expect(warnings()).toMatch(/out-of-band response/);

    answerProbe(active, 'r-probe', 'NO');
    await verdict;
  });

  it('attributes an opened response correctly when metadata is not echoed', async () => {
    active = await harness();
    // The conversation's own request is on the wire...
    active.session.requestResponse();
    await settle();
    // ...so a bare response.created belongs to it, not to any probe.
    active.emit({ type: 'response.created', response: { id: 'r-main' } });
    await settle();

    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    // Nothing outstanding for the conversation now, and a probe is waiting, so a
    // bare response.created is the probe's.
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    active.emit({ type: 'response.output_text.delta', response_id: 'r-probe', delta: 'YES' });
    active.emit({ type: 'response.done', response: { id: 'r-probe', status: 'completed' } });

    await expect(verdict).resolves.toBe('YES');

    // The speaking turn is still the one a barge-in cancels.
    active.session.interrupt([]);
    await settle();
    const cancel = active.sent.find((f) => f.type === 'response.cancel') as Record<string, unknown>;
    expect(cancel.response_id).toBe('r-main');
  });

  it('ignores a completion for a response that is no longer the live one', async () => {
    active = await harness();
    active.emit({ type: 'response.created', response: { id: 'r-a' } });
    active.emit({ type: 'response.output_audio.delta', delta: silenceDelta(200), item_id: 'i-1' });
    await settle();

    // A barge-in cancels A, then B is asked for and opens.
    active.session.interrupt([{ itemId: 'i-1', playedMs: 100, sentMs: 200 }]);
    active.session.requestResponse();
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-b' } });
    await settle();

    // A's cancelled completion arrives late. Clearing the slot here would wipe B's
    // state while B is still speaking.
    active.emit({ type: 'response.done', response: { id: 'r-a', status: 'cancelled' } });
    await settle();

    // B is still the live response, so a second interruption still cancels it...
    const cancelsBefore = active.sent.filter((f) => f.type === 'response.cancel').length;
    active.session.interrupt([]);
    await settle();
    const cancels = active.sent.filter((f) => f.type === 'response.cancel') as Record<
      string,
      unknown
    >[];
    expect(cancels).toHaveLength(cancelsBefore + 1);
    expect(cancels.at(-1)?.response_id).toBe('r-b');
  });

  it('keeps a live response when a cancel reports nothing to cancel', async () => {
    active = await harness();
    active.session.requestResponse();
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-live' } });
    await settle();

    // The error answers an *earlier* cancel. Releasing the flags for it would
    // strand the response that is running now.
    active.emit({ type: 'error', error: { message: 'Cancellation failed: no active response' } });
    await settle();

    active.session.interrupt([]);
    await settle();
    const cancel = active.sent.find((f) => f.type === 'response.cancel') as Record<string, unknown>;
    expect(cancel.response_id).toBe('r-live');
  });

  it('still recognises a rejection for a probe that has already given up', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 40,
    });
    await settle();
    const sendId = probeFrame(active.sent)!.event_id as string;
    await expect(verdict).resolves.toBeNull();

    // The rejection outlives the caller. Read as the conversation's, it would set
    // `responsePending` and speak an answer nothing asked for.
    active.emit({
      type: 'error',
      error: {
        message: 'Conversation already has an active response in progress',
        event_id: sendId,
      },
    });
    await settle();

    const before = mainRequests(active.sent).length;
    active.session.requestResponse();
    await settle();
    expect(mainRequests(active.sent)).toHaveLength(before + 1);
  });

  it('keeps a probe attributable for longer than the conversation waits', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      // Longer than the 5s the conversation's watchdog allows, which is the window
      // that used to discard a probe's queue entry while the probe was still live.
      deadlineMs: 8_000,
    });
    await settle();

    // No metadata on the open event, so attribution rides the send queue alone.
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    active.emit({ type: 'response.output_text.delta', response_id: 'r-probe', delta: 'YES' });
    active.emit({ type: 'response.done', response: { id: 'r-probe', status: 'completed' } });

    await expect(verdict).resolves.toBe('YES');
  });

  it('says why a probe answered nothing, rather than leaving it to timing', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    await settle();

    // The shape a live call produced: completed, inside the deadline, no rejection
    // — and empty, because the budget went on reasoning before the word.
    active.emit({
      type: 'response.done',
      response: {
        id: 'r-probe',
        status: 'incomplete',
        status_details: { reason: 'max_output_tokens' },
        usage: { output_token_details: { reasoning_tokens: 64, text_tokens: 0 } },
        output: [],
      },
    });

    await expect(verdict).resolves.toBeNull();
    // Without this the log cannot tell an exhausted budget from a rejection or a
    // timeout, which is what made ten of these take a session to explain.
    expect(warnings()).toMatch(/answered nothing/);
    expect(warnings()).toMatch(/max_output_tokens/);
    expect(warnings()).toMatch(/reasoning_tokens/);
  });

  it('resolves a probe left in flight when the call ends', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 10_000,
    });
    await settle();

    active.session.close();

    // Otherwise a caller waits the whole deadline after the meeting is over.
    await expect(verdict).resolves.toBeNull();
  });

  it('answers null rather than hanging when the socket is already shut', async () => {
    active = await harness();
    active.session.close();
    const before = active.sent.length;

    // Answered from the closed socket, not by waiting out the deadline — so this
    // must resolve without a frame ever going out.
    await expect(
      active.session.requestOutOfBandText({ instructions: 'gate', deadlineMs: 10_000 }),
    ).resolves.toBeNull();
    expect(active.sent).toHaveLength(before);
  });

  it('places two responses opening at once by the order they were asked for', async () => {
    active = await harness();
    // A probe goes out, and before the server acknowledges it the conversation
    // asks for a response too — routine, since a tool result or the previous
    // utterance's verdict can land at any moment.
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-2' }],
      deadlineMs: 500,
    });
    active.session.requestResponse();
    await settle();

    // Both open, bare, in the order they were sent. Swapping them would hand the
    // conversation's slot to the probe, and nothing would ever release it.
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    active.emit({ type: 'response.created', response: { id: 'r-main' } });
    await settle();

    // The speaking turn is the one a barge-in cancels...
    active.session.interrupt([]);
    await settle();
    const cancel = active.sent.find((f) => f.type === 'response.cancel') as Record<string, unknown>;
    expect(cancel.response_id).toBe('r-main');

    // ...the probe still resolves...
    answerProbe(active, 'r-probe', 'YES');
    await expect(verdict).resolves.toBe('YES');

    // ...and the session can still speak afterwards. A misplacement here left
    // `responseActive` set for good and the agent mute for the rest of the call.
    active.emit({ type: 'response.done', response: { id: 'r-main', status: 'completed' } });
    await settle();
    const before = mainRequests(active.sent).length;
    active.session.requestResponse();
    await settle();
    expect(mainRequests(active.sent)).toHaveLength(before + 1);
  });

  it('forgets a rejected conversation request so it cannot misplace a later one', async () => {
    active = await harness();
    active.session.requestResponse();
    await settle();
    const rejected = (mainRequests(active.sent)[0] as Record<string, unknown>).event_id as string;

    // The server refuses it, naming the request. No `response.created` is coming.
    active.emit({
      type: 'error',
      event_id: 'event_server_side',
      error: {
        message: 'Conversation already has an active response in progress',
        event_id: rejected,
      },
    });
    await settle();

    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    // Left in the queue, the dead request would claim this event and the probe
    // would be read as the conversation's.
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    active.emit({ type: 'response.output_text.delta', response_id: 'r-probe', delta: 'NO' });
    active.emit({ type: 'response.done', response: { id: 'r-probe', status: 'completed' } });

    await expect(verdict).resolves.toBe('NO');
  });

  it('never plays audio that arrives on a probe', async () => {
    active = await harness();
    const audio = vi.fn();
    active.session.on('audio', audio);

    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 500,
    });
    await settle();
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    await settle();

    // A probe asks for text. Audio on one is a contract violation, not something
    // to put in the room.
    active.emit({
      type: 'response.output_audio.delta',
      delta: silenceDelta(100),
      item_id: 'i-x',
      response_id: 'r-probe',
    });
    await settle();
    expect(audio).not.toHaveBeenCalled();

    answerProbe(active, 'r-probe', 'NO');
    await verdict;
  });

  it('still refuses a tool call on a probe that has already given up', async () => {
    active = await harness();
    const calls = vi.fn();
    active.session.on('functionCall', calls);

    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 40,
    });
    active.emit({ type: 'response.created', response: { id: 'r-probe' } });
    await expect(verdict).resolves.toBeNull();

    // The deadline passing does not stop the server generating — and a response
    // misbehaving badly enough to time out is exactly when it might emit
    // something it was told it had no tools for.
    active.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'r-probe',
      call_id: 'call-1',
      name: 'shell_exec',
      arguments: '{"command":"rm -rf /"}',
    });
    await settle();

    expect(calls).not.toHaveBeenCalled();
  });

  it('does not let a response we know is out-of-band claim the conversation slot', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 200,
    });
    await settle();
    const sendId = probeFrame(active.sent)!.event_id as string;
    await expect(verdict).resolves.toBeNull();

    // Opens after its probe gave up, but still carries our marker. Treating it as
    // the conversation's would claim a slot that nothing then releases.
    active.emit({
      type: 'response.created',
      response: { id: 'r-late', metadata: { prism_oob: sendId } },
    });
    await settle();

    const before = mainRequests(active.sent).length;
    active.session.requestResponse();
    await settle();
    expect(mainRequests(active.sent)).toHaveLength(before + 1);
  });

  it('settles a probe when the server drops the socket', async () => {
    active = await harness();
    const verdict = active.session.requestOutOfBandText({
      instructions: 'gate',
      input: [{ type: 'item_reference', id: 'i-1' }],
      deadlineMs: 10_000,
    });
    await settle();

    // The common way a call ends. Waiting out the deadline after the socket is
    // gone would hold the gate — and so the room — for ten seconds.
    active.dropFromServer();

    await expect(verdict).resolves.toBeNull();
  });
});
