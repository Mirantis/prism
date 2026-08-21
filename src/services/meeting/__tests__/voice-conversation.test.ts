/**
 * The seam between a dead Realtime session and the service that owns the call.
 *
 * Run against a real local WebSocket server rather than a mocked session, because
 * the distinction being tested — a close the server initiated versus one we asked
 * for — only exists at the socket level.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { VoiceConversation } from '../voice-conversation';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Every `info` line emitted so far, joined — the latency figures live here. */
function infoLines(): string {
  return vi
    .mocked(logger.info)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
}

/**
 * Requests the conversation made for itself — the ones that put the agent's voice
 * in the room. A gate probe is also a `response.create`, but carries a `response`
 * body; the conversation's asks for nothing special.
 */
function spokenRequests(sent: Record<string, unknown>[]): Record<string, unknown>[] {
  return sent.filter((e) => e.type === 'response.create' && !e.response);
}

/** The gate probe on the wire, if one has been sent. */
function probeSent(sent: Record<string, unknown>[]): Record<string, any> | undefined {
  return sent.find((e) => e.type === 'response.create' && e.response) as
    | Record<string, any>
    | undefined;
}

beforeEach(() => {
  vi.mocked(logger.info).mockClear();
  vi.mocked(config).meetingTranscriptLogging = 'off';
});

interface Harness {
  conversation: VoiceConversation;
  /** Close the socket from the server's side, as OpenAI would on a drop. */
  dropFromServer: () => void;
  lost: string[];
  dispose: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  let socket: ServerSocket | null = null;
  const connected = new Promise<void>((resolve) => {
    server.once('connection', (ws) => {
      socket = ws;
      resolve();
    });
  });

  const lost: string[] = [];
  const conversation = new VoiceConversation({
    instructions: 'You are Prism.',
    tools: { declarations: [], count: 0, execute: vi.fn() },
    sink: { write: vi.fn() },
    agentName: 'Prism',
    endpointOverride: { url: `ws://127.0.0.1:${port}`, headers: {} },
    onSessionLost: (reason) => lost.push(reason),
  });
  await conversation.start();
  await connected;

  return {
    conversation,
    lost,
    dropFromServer: () => socket?.close(1011, 'server gone'),
    dispose: async () => {
      conversation.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A live socket that can push the events OpenAI would send and record what the
 * client sends back — `response.create` being the one that puts the agent's voice
 * in the room.
 */
async function speakingHarness(): Promise<{
  h: Harness;
  send: (event: Record<string, unknown>) => void;
  sent: Record<string, unknown>[];
}> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  const sent: Record<string, unknown>[] = [];
  let socket: ServerSocket | null = null;
  const connected = new Promise<void>((resolve) => {
    server.once('connection', (ws) => {
      socket = ws;
      ws.on('message', (raw) => {
        try {
          sent.push(JSON.parse(String(raw)) as Record<string, unknown>);
        } catch {
          // Audio frames and anything else unparseable are not what is measured.
        }
      });
      resolve();
    });
  });

  const conversation = new VoiceConversation({
    instructions: 'You are Emma.',
    tools: { declarations: [], count: 0, execute: vi.fn() },
    sink: { write: vi.fn() },
    agentName: 'Emma',
    // Named, so every utterance goes to the gate rather than being answered outright.
    responseMode: 'addressed',
    endpointOverride: { url: `ws://127.0.0.1:${port}`, headers: {} },
  });
  await conversation.start();
  await connected;

  return {
    h: {
      conversation,
      lost: [],
      dropFromServer: () => socket?.close(1011, 'server gone'),
      dispose: async () => {
        conversation.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    },
    send: (event) => socket?.send(JSON.stringify(event)),
    sent,
  };
}

/** Give the close frame a turn to land. */
const settle = () => new Promise((r) => setTimeout(r, 20));

let active: Harness | null = null;
afterEach(async () => {
  await active?.dispose();
  active = null;
});

describe('losing the Realtime session', () => {
  it('reports a close the server initiated', async () => {
    active = await harness();

    active.dropFromServer();
    await settle();

    // The owner needs to hear about this: the browser is still sitting in the
    // meeting, but nothing can be said or heard any more.
    expect(active.lost).toHaveLength(1);
    expect(active.lost[0]).toContain('server gone');
  });

  it('says nothing about a close it asked for itself', async () => {
    active = await harness();

    active.conversation.stop();
    await settle();

    expect(active.lost).toEqual([]);
  });

  it('reports a close only once', async () => {
    active = await harness();

    active.dropFromServer();
    await settle();
    // A teardown following the loss must not look like a second loss.
    active.conversation.stop();
    await settle();

    expect(active.lost).toHaveLength(1);
  });
});

describe('telling the session who is in the room', () => {
  it('hints the transcriber and informs the model, once per change', async () => {
    const { h, sent } = await speakingHarness();
    active = h;

    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);
    await settle();

    // The *last* one: the session is configured at connect with the agent's own
    // name already, so the first `session.update` is that one, not the roster.
    const updates = sent.filter((e) => e.type === 'session.update');
    const update = updates[updates.length - 1];
    const keywords = (
      update?.session as { audio?: { input?: { transcription?: { keywords?: string[] } } } }
    )?.audio?.input?.transcription?.keywords;
    // The agent's own name leads: it is the one word the gate cannot work without.
    expect(keywords?.[0]).toBe('Emma');
    expect(keywords).toContain('Mario Sarcher');

    // The model is told separately — it cannot read the transcriber's config, and
    // "who is in this call?" is a question the room actually asks.
    const context = sent.filter((e) => e.type === 'conversation.item.create');
    expect(JSON.stringify(context)).toContain('Mario Sarcher');
    // ...and not told it is talking to itself.
    expect(JSON.stringify(context)).not.toContain('are now: Emma');

    // Re-sending an unchanged roster would mutate a live session every poll.
    const before = sent.length;
    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);
    await settle();
    expect(sent.length).toBe(before);
  });
});

describe('a roster read from a moving UI', () => {
  it('ignores a reordering of the same people', async () => {
    const { h, sent } = await speakingHarness();
    active = h;

    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);
    await settle();
    const before = sent.length;

    // Meet reorders tiles by who is speaking, so the same room arrives in a
    // different order every poll. Treated as a change, each one mutated the live
    // transcriber config and pushed another roster item into the model's context.
    h.conversation.setParticipantNames(['Lee', 'Emma', 'Mario Sarcher']);
    await settle();

    expect(sent.length).toBe(before);
  });

  it('does not tell the model it is alone when the scrape found only itself', async () => {
    const { h, sent } = await speakingHarness();
    active = h;

    // A grid that has not painted yet, or has virtualized everyone off-screen.
    // That is a failed read, not an empty room — and saying so mid-meeting is a
    // false statement the model may act on.
    h.conversation.setParticipantNames(['Emma']);
    await settle();

    expect(JSON.stringify(sent)).not.toContain('alone');
    expect(sent.filter((e) => e.type === 'conversation.item.create')).toHaveLength(0);
  });
});

/**
 * The whole decision, end to end over a real socket: the turn detector closes an
 * utterance, the gate is asked about that utterance, and the answer follows or
 * does not.
 */
describe('deciding whether to answer', () => {
  /** Answer the probe the client has sent, the way the server would. */
  async function answerGate(
    send: (event: Record<string, unknown>) => void,
    sent: Record<string, unknown>[],
    verdict: 'YES' | 'NO',
    responseId = 'r-gate',
  ): Promise<void> {
    const probe = probeSent(sent);
    if (!probe) throw new Error('the gate was never asked');
    send({
      type: 'response.created',
      response: { id: responseId, metadata: probe.response.metadata },
    });
    send({
      type: 'response.done',
      response: { id: responseId, status: 'completed', output: [{ content: [{ text: verdict }] }] },
    });
    await settle();
  }

  it('asks about the utterance that just closed, and answers when told to', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    await settle();

    // Judged from the audio, with a bounded slice of the call as context and the
    // utterance in question last. No transcript is involved.
    const probe = probeSent(sent)!;
    expect(probe.response.conversation).toBe('none');
    const referenced = (probe.response.input as Array<{ type: string; id: string }>).map((r) => r.id);
    expect(referenced.at(-1)).toBe('item-1');
    expect(referenced.length).toBeLessThanOrEqual(6);
    expect(spokenRequests(sent)).toHaveLength(0);

    await answerGate(send, sent, 'YES');

    expect(spokenRequests(sent)).toHaveLength(1);
  });

  it('stays quiet when the utterance was not for the agent', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-2' });
    await settle();
    await answerGate(send, sent, 'NO');

    expect(spokenRequests(sent)).toHaveLength(0);
    expect(h.conversation.statistics).toMatchObject({ gateCalls: 1, gateFailed: 0 });
  });

  it('answers an utterance once even if the turn closes twice', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-3' });
    await settle();
    await answerGate(send, sent, 'YES');
    const probesAfterFirst = sent.filter((e) => e.type === 'response.create' && e.response).length;

    // A duplicated commit for the same utterance. A second request is queued by the
    // session rather than dropped, so the room would hear the reply twice.
    send({ type: 'input_audio_buffer.committed', item_id: 'item-3' });
    await settle();

    expect(spokenRequests(sent)).toHaveLength(1);
    // And the duplicate is refused *before* it costs anything: asking again would
    // spend a probe on a question already answered.
    expect(sent.filter((e) => e.type === 'response.create' && e.response)).toHaveLength(
      probesAfterFirst,
    );
  });

  it('counts a verdict that never came, so a deaf agent is visible', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-4' });
    await settle();
    // The socket dies under the probe — the common way a call ends.
    h.dropFromServer();
    await settle();

    expect(spokenRequests(sent)).toHaveLength(0);
    // Silence from a broken gate and silence from a room nobody addressed are
    // indistinguishable without this.
    expect(h.conversation.statistics).toMatchObject({ gateCalls: 1, gateFailed: 1 });
  });

  it('records the reasoning effort beside the latency it bought', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-6' });
    await settle();
    await answerGate(send, sent, 'YES');

    // The first audio is when the room stops waiting, so this is the figure the
    // effort level moves. Without the level on the same line, a call at `high` and
    // a call at `medium` produce indistinguishable logs and the trade cannot be
    // judged after the fact.
    send({
      type: 'response.output_audio.delta',
      item_id: 'item-6',
      delta: Buffer.alloc(960).toString('base64'),
    });
    await settle();

    expect(infoLines()).toMatch(/voice started \d+ms after asking .*effort high/);
  });
});

describe('what a call leaves in the log', () => {
  it('keeps the room out of it by default', async () => {
    const { h, send } = await speakingHarness();
    active = h;

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-7',
      transcript: 'Emma, can you take a look at the staging cluster?',
    });
    await settle();

    // A call is unauthenticated third-party speech and the log outlives it.
    expect(infoLines()).not.toContain('staging cluster');
    expect(infoLines()).not.toContain('Meeting:Heard');
  });

  it('writes what was said when asked, paired to the utterance by id', async () => {
    vi.mocked(config).meetingTranscriptLogging = 'full';
    const { h, send } = await speakingHarness();
    active = h;

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-8',
      transcript: 'Emma, can you take a look at the staging cluster?',
    });
    await settle();

    // Transcription lags the decision, so the words arrive on their own line and
    // `item=` is what pairs them with the verdict.
    expect(infoLines()).toMatch(/\[Meeting:Heard\] item=item-8 transcript=".*staging cluster/);
  });
});
