/**
 * A web call for the agent's computer to join, standing in for a meeting app.
 *
 * It behaves as every browser call app does at the audio level: pressing Join opens the
 * microphone and plays the other participants through the speaker; pressing Leave
 * closes the microphone and goes quiet. The "participants" are a steady tone, playing
 * for as long as the page is in the call, since the agent's voice connects a while after
 * its browser presses Join. The page measures what its microphone hears and reports it
 * here, because the test's browser cannot reach into the runtime's browser to look.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/** What the call page has reported. */
export interface CallPageState {
  joined: boolean;
  left: boolean;
  /** The loudest the page's microphone has been, as an RMS level from 0 to 1. */
  micPeak: number;
}

const PAGE = `<!doctype html>
<title>Team call</title>
<body style="font:24px system-ui;padding:64px;background:#f4f4f5;color:#18181b">
<h1 id="status">Team call — ready to join</h1>
<button id="join" style="font:24px system-ui;padding:12px 32px">Join now</button>
<button id="leave" style="font:24px system-ui;padding:12px 32px" hidden>Leave call</button>
<script>
const status = document.getElementById('status');
const join = document.getElementById('join');
const leave = document.getElementById('leave');
const report = (body) => fetch('/report', { method: 'POST', body: JSON.stringify(body) });
let mic = null;
let context = null;
let peak = 0;

join.onclick = async () => {
  mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  context = new AudioContext();
  // The room: a tone the agent's voice model hears as speech.
  const room = context.createOscillator();
  room.frequency.value = 300;
  const gain = context.createGain();
  gain.gain.value = 0.5;
  room.connect(gain).connect(context.destination);
  room.start();
  // What the room hears from the agent.
  const analyser = context.createAnalyser();
  context.createMediaStreamSource(mic).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const rms = Math.sqrt(sum / samples.length);
    if (rms > peak) {
      peak = rms;
      report({ micPeak: peak });
    }
  }, 100);
  status.textContent = 'In the call';
  join.hidden = true;
  leave.hidden = false;
  report({ joined: true });
};

leave.onclick = () => {
  for (const track of mic?.getTracks() ?? []) track.stop();
  void context?.close();
  status.textContent = 'You left the call';
  leave.hidden = true;
  report({ left: true });
};
</script>`;

export async function startCallSite(): Promise<{
  url: string;
  state: () => CallPageState;
  close: () => Promise<void>;
}> {
  const state: CallPageState = { joined: false, left: false, micPeak: 0 };
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const reported = JSON.parse(body) as Partial<CallPageState>;
        if (reported.joined) state.joined = true;
        if (reported.left) state.left = true;
        if (typeof reported.micPeak === 'number') state.micPeak = Math.max(state.micPeak, reported.micPeak);
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    // A `.localhost` name is a secure context, which the microphone needs.
    url: `http://${randomUUID()}.localhost:${address.port}/call`,
    state: () => ({ ...state }),
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
