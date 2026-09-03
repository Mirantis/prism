/**
 * A local stand-in for OpenAI's Realtime API, so a voice call can be tested with
 * no OpenAI account and no metered socket.
 *
 * The runtime reaches it because `OPENAI_REALTIME_URL` points its voice socket
 * here. It speaks only the part of the protocol the runtime uses: the session is
 * created, the audio the runtime appends is counted, a turn boundary is announced
 * once enough of it has arrived, and a requested response answers with a steady
 * tone. Nothing here is a model — the words are never read.
 *
 * `GET /state` reports what it has seen, so a failing scenario can name the step
 * that did not complete: a `sessions` of zero means the runtime has no socket open,
 * an `inboundMs` of zero means the browser's microphone did not reach it, and a
 * `deltasSent` of zero means the runtime never asked for an answer. `sessions` is a
 * count rather than a flag, so a second session opening while one is still up is
 * visible instead of hidden behind the first one's close.
 *
 * Run by Playwright as a `webServer`; `GET /health` is what it waits for.
 */

import http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { MOCK_REALTIME_PORT } from './mock-realtime-port';

/** pcm16 mono at the rate the Realtime API speaks, in both directions. */
const SAMPLE_RATE = 24_000;
/** How much non-silent audio closes an utterance. */
const UTTERANCE_MS = 700;
/** A sample this small is background noise, not speech. */
const SILENCE_FLOOR = 500;
/** The answer: a plain 440 Hz tone, long enough for the browser to measure it. */
const TONE_HZ = 440;
const TONE_MS = 2_000;
/** One delta carries this much of it, as the real API streams rather than dumps. */
const DELTA_MS = 200;

const state = {
  /** How many sockets are open right now. */
  sessions: 0,
  inboundMs: 0,
  responsesRequested: 0,
  deltasSent: 0,
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: '/v1/realtime' });

wss.on('connection', (ws: WebSocket) => {
  state.sessions += 1;
  log(`session opened (${state.sessions} open)`);
  let turns = 0;
  // Both counted for this socket only. The turn boundary is a property of one
  // conversation, so a second session must not inherit the first one's audio.
  let heardMs = 0;
  let announcedMs = 0;
  let responses = 0;

  send(ws, { type: 'session.created', session: { id: 'sess_mock' } });

  ws.on('message', (data) => {
    let event: { type?: string; audio?: string; event_id?: string };
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (event.type === 'input_audio_buffer.append' && typeof event.audio === 'string') {
      const arrivedMs = speechMs(Buffer.from(event.audio, 'base64'));
      heardMs += arrivedMs;
      state.inboundMs += arrivedMs;
      // One turn per `UTTERANCE_MS` of speech. The runtime answers a turn
      // boundary, so this is what makes the agent talk back.
      if (heardMs - announcedMs >= UTTERANCE_MS) {
        announcedMs = heardMs;
        announceTurn(ws, `item_mock_${++turns}`, heardMs);
      }
      return;
    }

    if (event.type === 'response.create') {
      state.responsesRequested += 1;
      answerWithTone(ws, `resp_mock_${++responses}`);
      return;
    }
  });

  ws.on('close', () => {
    state.sessions = Math.max(0, state.sessions - 1);
    log(`session closed (${state.sessions} open)`);
  });
});

/** How much of a pcm16 buffer is loud enough to count as somebody speaking. */
function speechMs(pcm: Buffer): number {
  let loud = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) > SILENCE_FLOOR) loud += 1;
  }
  return (loud / SAMPLE_RATE) * 1000;
}

/** The four frames the runtime reads as "somebody finished a sentence". */
function announceTurn(ws: WebSocket, itemId: string, heardMs: number): void {
  send(ws, { type: 'input_audio_buffer.speech_started', item_id: itemId });
  send(ws, { type: 'input_audio_buffer.speech_stopped', item_id: itemId });
  send(ws, { type: 'input_audio_buffer.committed', item_id: itemId });
  send(ws, {
    type: 'conversation.item.added',
    item: {
      id: itemId,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_audio' }],
    },
  });
  log(`turn ${itemId} committed after ${Math.round(heardMs)}ms of speech on this session`);
}

/** Answer a `response.create` with a tone, streamed as the real API streams audio. */
function answerWithTone(ws: WebSocket, responseId: string): void {
  send(ws, { type: 'response.created', response: { id: responseId } });

  const itemId = `${responseId}_item`;
  const chunkSamples = (SAMPLE_RATE * DELTA_MS) / 1000;
  const totalChunks = TONE_MS / DELTA_MS;
  for (let chunk = 0; chunk < totalChunks; chunk += 1) {
    send(ws, {
      type: 'response.output_audio.delta',
      response_id: responseId,
      item_id: itemId,
      delta: tone(chunk * chunkSamples, chunkSamples).toString('base64'),
    });
    state.deltasSent += 1;
  }

  send(ws, { type: 'response.output_audio.done', response_id: responseId, item_id: itemId });
  send(ws, { type: 'response.done', response: { id: responseId, status: 'completed' } });
  log(`answered ${responseId} with ${TONE_MS}ms of tone`);
}

/** `sampleCount` samples of a continuous sine, starting at sample `from`. */
function tone(from: number, sampleCount: number): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const t = (from + sample) / SAMPLE_RATE;
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * TONE_HZ * t) * 20_000), sample * 2);
  }
  return pcm;
}

function send(ws: WebSocket, event: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function log(message: string): void {
  console.log(`[MockRealtime] ${message}`);
}

server.listen(MOCK_REALTIME_PORT, '127.0.0.1', () =>
  log(`listening on ws://127.0.0.1:${MOCK_REALTIME_PORT}/v1/realtime`),
);
