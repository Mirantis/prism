/**
 * A local stand-in for OpenAI's voice API, so a call and a dictation can be tested with
 * no OpenAI account and no metered socket.
 *
 * The runtime discovers its managed Azure endpoint from environment variables, and opens
 * two sockets under it:
 *
 * - `…/live/sessions`, a GPT-Live call with client delegation. The session starts, the
 *   audio the runtime appends is counted, and once enough of it has arrived the voice
 *   "hears" a request, sends its transcript and hands it to the client. When the runtime
 *   answers that delegation the voice answers with a steady tone. An answer with no
 *   delegation is counted apart, which is how the runtime's own work, such as looking at
 *   a screen recording, comes back. Nothing here is a model — the answers are never read.
 * - `…/realtime?intent=transcription`, a dictation. A commit answers with a transcript
 *   that states how much speech the buffer held, so a scenario can tell the runtime's
 *   audio reached it from the text alone.
 *
 * The frames follow ones recorded from the live endpoint.
 *
 * `GET /state` reports what it has seen, so a failing scenario can name the step that did
 * not complete: a `sessions` of zero means the runtime has no call open, an `inboundMs` of
 * zero means the browser's microphone did not reach it, a `results` of zero means the
 * runtime never answered a delegation, and a `deltasSent` of zero means the voice never
 * answered. `sessions` is a count rather than a flag, so a second call opening while one is
 * still up is visible instead of hidden behind the first one's close.
 *
 * Run by Playwright as a `webServer`; `GET /health` is what it waits for.
 */

import http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { MOCK_REALTIME_PORT } from './mock-realtime-port';
import { MANAGED_VOICE_KEY, MANAGED_VOICE_PATH } from './managed-voice';

/** pcm16 mono at the rate both APIs speak, in both directions. */
const SAMPLE_RATE = 24_000;
/** How much non-silent audio makes a request. */
const UTTERANCE_MS = 700;
/** A sample this small is background noise, not speech. */
const SILENCE_FLOOR = 500;
/** The answer: a plain 440 Hz tone, long enough for the browser to measure it. */
const TONE_HZ = 440;
const TONE_MS = 2_000;
/** One delta carries this much of it, as the live endpoint streams it. */
const DELTA_MS = 100;
/**
 * What the voice hears asked each time. A real agent run answers it, so it is a question
 * one or two quick steps answer, and one that changes nothing.
 */
const REQUEST_TEXT = 'Prism, which tasks do I have scheduled?';

const state = {
  /** How many calls are open right now. */
  sessions: 0,
  managedHandshakes: 0,
  inboundMs: 0,
  /** Requests the voice handed to the client. */
  delegations: 0,
  /** Delegations the runtime answered. */
  results: 0,
  /** Answers the runtime sent with no delegation, for work it asked for itself. */
  unpromptedAnswers: 0,
  /** Progress notes the runtime sent while it worked. */
  progressNotes: 0,
  /** Answers the voice spoke. */
  answers: 0,
  deltasSent: 0,
  /** What the last call started with: the voice model and its delegation type. */
  lastStart: null as null | { model: string; delegation: string },
  /** Dictation buffers committed and answered with a transcript. */
  dictationsTranscribed: 0,
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

const live = new WebSocketServer({ noServer: true });
const realtime = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://mock');
  if (req.headers.authorization !== `Bearer ${MANAGED_VOICE_KEY}`) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  const target =
    pathname === `${MANAGED_VOICE_PATH}/live/sessions` ? live
      : pathname === `${MANAGED_VOICE_PATH}/realtime` ? realtime
        : null;
  if (!target) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  state.managedHandshakes += 1;
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws));
});

interface ClientFrame {
  type?: string;
  audio?: string;
  event_id?: string;
  delegation_id?: string | null;
  content?: string;
  session?: {
    model?: string;
    delegation?: { type?: string };
  };
}

live.on('connection', (ws: WebSocket) => {
  state.sessions += 1;
  log(`call opened (${state.sessions} open)`);
  // Counted for this socket only: a second call must not inherit the first one's audio.
  let heardMs = 0;
  let requestedAtMs = 0;
  /** The delegation waiting for the runtime's answer, one at a time. */
  let pending: string | null = null;

  ws.on('message', (data) => {
    const frame = parse(data);
    if (!frame) return;

    switch (frame.type) {
      case 'session.start': {
        state.lastStart = {
          model: frame.session?.model ?? '',
          delegation: frame.session?.delegation?.type ?? '',
        };
        send(ws, { type: 'session.started', session: { id: 'live_mock', ...frame.session, status: 'active' } });
        return;
      }
      case 'session.input_audio.append': {
        if (typeof frame.audio !== 'string') return;
        const arrivedMs = speechMs(Buffer.from(frame.audio, 'base64'));
        heardMs += arrivedMs;
        state.inboundMs += arrivedMs;
        // One request per `UTTERANCE_MS` of speech, and one at a time.
        if (!pending && heardMs - requestedAtMs >= UTTERANCE_MS) {
          requestedAtMs = heardMs;
          pending = delegate(ws, heardMs);
        }
        return;
      }
      case 'session.thinking.append':
        state.progressNotes += 1;
        send(ws, { type: 'session.thinking.appended', client_event_id: frame.event_id });
        return;
      case 'session.commentary.append': {
        send(ws, { type: 'session.commentary.appended', client_event_id: frame.event_id });
        if (!frame.delegation_id) {
          state.unpromptedAnswers += 1;
          log('the runtime answered work of its own');
          return;
        }
        if (frame.delegation_id !== pending) return;
        state.results += 1;
        pending = null;
        log(`the runtime answered ${frame.delegation_id}`);
        answerWithTone(ws);
        return;
      }
      case 'session.close':
        send(ws, { type: 'session.closed', reason: 'close_requested', usage: { seconds: 1 } });
        ws.close(1000);
        return;
      default:
        return;
    }
  });

  ws.on('close', () => {
    state.sessions = Math.max(0, state.sessions - 1);
    log(`call closed (${state.sessions} open)`);
  });
});

realtime.on('connection', (ws: WebSocket) => {
  let heardMs = 0;
  let turns = 0;
  send(ws, { type: 'session.created', session: { id: 'sess_mock' } });

  ws.on('message', (data) => {
    const frame = parse(data);
    if (!frame) return;
    if (frame.type === 'session.update') {
      send(ws, { type: 'session.updated', session: { id: 'sess_mock' } });
      return;
    }
    if (frame.type === 'input_audio_buffer.append' && typeof frame.audio === 'string') {
      const arrivedMs = speechMs(Buffer.from(frame.audio, 'base64'));
      heardMs += arrivedMs;
      state.inboundMs += arrivedMs;
      return;
    }
    if (frame.type === 'input_audio_buffer.commit') {
      transcribe(ws, `item_mock_${++turns}`, heardMs);
      heardMs = 0;
    }
  });
});

/** The voice hears the request, says it into the transcript, and hands it to the client. */
function delegate(ws: WebSocket, heardMs: number): string {
  state.delegations += 1;
  const id = `item_delegation_${state.delegations}`;
  const at = Math.round(heardMs);
  send(ws, { type: 'session.input_transcript.delta', delta: REQUEST_TEXT, start_ms: Math.max(0, at - 1_000), end_ms: at });
  send(ws, { type: 'session.delegation.created', offset_ms: at, delegation: { id, type: 'delegation', target: 'client' } });
  log(`delegation ${state.delegations}: handed "${REQUEST_TEXT}" to the client`);
  return id;
}

/** How much of a pcm16 buffer is loud enough to count as somebody speaking. */
function speechMs(pcm: Buffer): number {
  let loud = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) > SILENCE_FLOOR) loud += 1;
  }
  return (loud / SAMPLE_RATE) * 1000;
}

/** Answer a committed dictation with a transcript of how much speech it held. */
function transcribe(ws: WebSocket, itemId: string, heardMs: number): void {
  const transcript = `Mock dictation of ${Math.round(heardMs / 100) * 100} ms.`;
  send(ws, { type: 'input_audio_buffer.committed', item_id: itemId });
  send(ws, { type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, delta: 'Mock dictation ' });
  send(ws, { type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript });
  state.dictationsTranscribed += 1;
  log(`dictation ${itemId} transcribed after ${Math.round(heardMs)}ms of speech`);
}

/** The voice speaks: a tone, streamed in real-time-sized frames, with its transcript. */
function answerWithTone(ws: WebSocket): void {
  state.answers += 1;
  const chunkSamples = (SAMPLE_RATE * DELTA_MS) / 1000;
  const totalChunks = TONE_MS / DELTA_MS;
  send(ws, { type: 'session.output_transcript.delta', delta: 'Mock answer.', start_ms: 0, end_ms: 200 });
  for (let chunk = 0; chunk < totalChunks; chunk += 1) {
    send(ws, { type: 'session.output_audio.delta', delta: tone(chunk * chunkSamples, chunkSamples).toString('base64') });
    state.deltasSent += 1;
  }
  log(`answered with ${TONE_MS}ms of tone`);
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

function parse(data: WebSocket.RawData): ClientFrame | null {
  try {
    return JSON.parse(data.toString()) as ClientFrame;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, event: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function log(message: string): void {
  console.log(`[MockVoice] ${message}`);
}

server.listen(MOCK_REALTIME_PORT, '127.0.0.1', () =>
  log(`listening on ws://127.0.0.1:${MOCK_REALTIME_PORT}${MANAGED_VOICE_PATH}/{live/sessions,realtime}`),
);
