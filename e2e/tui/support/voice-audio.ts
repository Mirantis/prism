import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A private PulseAudio server keeps tests away from the user's microphone. */
export async function createVoiceAudio() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prism-voice-'));
  const env = { ...process.env, PULSE_SERVER: `unix:${dir}/pulse.sock` };
  const server = spawn('pulseaudio', [
    '--daemonize=no', '--use-pid-file=no', '--exit-idle-time=-1', '-n',
    `--load=module-native-protocol-unix socket=${dir}/pulse.sock auth-anonymous=1`,
  ], { env, stdio: 'ignore' });
  const pactl = (...args: string[]) => execFileSync('pactl', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { pactl('info'); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  if (!ready) { server.kill(); rmSync(dir, { recursive: true, force: true }); throw new Error('Private PulseAudio server failed to start.'); }
  const modules: string[] = [];
  modules.push(pactl('load-module', 'module-null-sink', 'sink_name=voice_output'));
  modules.push(pactl('load-module', 'module-null-sink', 'sink_name=voice_input_sink'));
  modules.push(pactl('load-module', 'module-remap-source', 'master=voice_input_sink.monitor', 'source_name=voice_input', 'source_properties=device.description=VoiceInput'));
  pactl('set-default-source', 'voice_input');
  pactl('set-default-sink', 'voice_output');
  const tone = Buffer.alloc(960);
  for (let i = 0; i < 480; i++) tone.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 600 * i / 24_000) * 8_000), i * 2);
  const input = spawn('pacat', ['--playback', '--raw', '--rate=24000', '--channels=1', '--format=s16le', '--device=voice_input_sink'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  input.stdin.on('error', () => {});
  const clock = setInterval(() => { if (input.stdin.writableLength < 48_000) input.stdin.write(tone); }, 20);
  const output = spawn('parec', ['--raw', '--rate=24000', '--channels=1', '--format=s16le', '--device=voice_output.monitor'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let audibleSamples = 0;
  output.stdout.on('data', (pcm: Buffer) => {
    for (let i = 0; i + 1 < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) > 500) audibleSamples++;
  });
  const removeDevices = () => {
    clearInterval(clock);
    input.kill(); output.kill();
    while (modules.length) pactl('unload-module', modules.pop()!);
  };
  return {
    env, audibleSamples: () => audibleSamples, removeDevices,
    cleanup: () => {
      clearInterval(clock);
      input.kill(); output.kill(); server.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
