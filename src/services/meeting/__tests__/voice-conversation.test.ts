/**
 * The seam between a dead Realtime session and the service that owns the call.
 *
 * Run against a real local WebSocket server rather than a mocked session, because
 * the distinction being tested — a close the server initiated versus one we asked
 * for — only exists at the socket level.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { VoiceConversation } from '../voice-conversation';
import { classifyAddressed } from '../addressed-classifier';

// The gate is a network call to a classification model; what these tests exercise
// is the ordering around its verdict, not the verdict itself. `CLASSIFY_DEADLINE_MS`
// stays real — the code compares elapsed time against it, and a mocked-away constant
// would quietly disable a staleness check the tests depend on *not* firing.
vi.mock('../addressed-classifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../addressed-classifier')>()),
  classifyAddressed: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(classifyAddressed).mockResolvedValue(true);
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
    // Named, so the gate decides — the path the early verdict lives on.
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

/**
 * A verdict reached from a partial transcript decides *whether* to answer; the
 * turn boundary decides *when*.
 *
 * Acting on the verdict the moment it arrived is what made the agent talk over the
 * end of a request and answer only the part it had heard — reported from a live
 * call as "it didn't hear the full sentence before it started to answer". The
 * classification still runs early, concurrently with the rest of the sentence, so
 * nothing is waiting on it once the speaker stops.
 */
describe('answering a request judged early', () => {
  it('stays quiet until the speaker stops, then answers', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    // Mid-sentence: enough text for the gate, which says the agent was named.
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'Emma, could you check the',
    });
    await settle();
    await settle();

    // The speaker is still talking. Answering here would cut across the rest of
    // the request — the failure this ordering exists to prevent.
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(0);

    send({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    await settle();

    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
  });

  it('answers once, not once per verdict', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    // The same utterance is judged repeatedly as it grows; only one answer may
    // result, or the room hears the reply twice (a second `response.create` is
    // queued by the session, not dropped).
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'Emma, could you check the deployment',
    });
    await settle();
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: ' in staging and tell us what you find?',
    });
    await settle();
    await settle();

    send({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'Emma, could you check the deployment in staging and tell us what you find?',
    });
    await settle();
    await settle();

    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
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
