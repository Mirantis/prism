import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

function helperPath(): string {
  const name = process.platform === 'win32' ? 'prism-audio.exe' : 'prism-audio';
  return fileURLToPath(new URL(isSea() ? `./${name}` : `../../native/bin/${name}`, import.meta.url));
}

export async function probeAudio(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(helperPath(), ['--probe'], { timeout: 2_000, windowsHide: true }, (error) => resolve(!error));
  });
}

export interface AudioSession {
  play(pcm: Buffer): void;
  clear(): void;
  mute(muted: boolean): void;
  stop(): void;
}

/** Pipes contain bounded PCM frames; the helper never reads terminal input. */
export function startAudio(options: {
  signal: AbortSignal;
  onAudio: (pcm: Buffer) => void;
  onFailure: () => void;
}): Promise<AudioSession> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(helperPath(), [], { windowsHide: true, stdio: 'pipe' });
    let ready = false;
    let stopped = false;
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => fail(), 15_000);
    child.stderr.resume();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      child.stdin.end();
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref();
      child.once('exit', () => clearTimeout(killTimer));
    };
    const fail = () => {
      if (stopped) return;
      stop();
      if (ready) options.onFailure();
      else reject(new Error('Could not open audio. Check microphone permission and your input and output devices.'));
    };
    const abort = () => {
      stop();
      reject(new Error('Voice chat cancelled.'));
    };
    const send = (type: number, data: Buffer = Buffer.alloc(0)) => {
      if (stopped) return;
      if (child.stdin.writableLength > 48_000) { fail(); return; }
      const header = Buffer.alloc(5);
      header[0] = type;
      header.writeUInt32LE(data.length, 1);
      child.stdin.write(Buffer.concat([header, data]));
    };
    const session: AudioSession = {
      play: (pcm) => send(1, pcm),
      clear: () => send(2),
      mute: (muted) => send(3, Buffer.from([Number(muted)])),
      stop,
    };
    child.once('error', fail);
    child.once('exit', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return;
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const length = pending.readUInt32LE(1);
        const type = pending[0];
        if (length > 48_000) { fail(); return; }
        if (pending.length < 5 + length) return;
        const data = pending.subarray(5, 5 + length);
        pending = pending.subarray(5 + length);
        if (type === 2 && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(session);
        } else if (type === 1 && ready && length % 2 === 0) options.onAudio(data);
      }
    });
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
  });
}
