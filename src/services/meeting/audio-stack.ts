/**
 * The virtual audio devices that let a browser talk to a program.
 *
 * Chrome will only send audio it captured from a microphone and will only play
 * audio to a speaker, so the bot needs both — as software. PulseAudio null-sinks
 * provide them:
 *
 *   meet_out          a sink Chrome plays the meeting into. Its `.monitor` source
 *                     is what `parec` records, giving us everything the room says.
 *   bot_speak         a sink we play the model's speech into...
 *   bot_mic           ...remapped from `bot_speak.monitor` into a *source*, which
 *                     is what Chrome sees as a microphone. (A monitor source can
 *                     technically be captured directly, but Chrome filters monitor
 *                     devices out of its microphone list, so the remap is required
 *                     rather than cosmetic.)
 *
 * Xvfb is here for a related reason: Meet's WebRTC path is markedly less reliable
 * under `--headless` than in a real rendered browser, so Chrome runs normally on a
 * virtual display instead.
 *
 * Everything is per-meeting and private: its own PulseAudio daemon with its own
 * runtime dir, so nothing is shared with a host daemon (there isn't one in the
 * container) and teardown is unambiguous — kill the daemon, the devices are gone.
 */

import { spawn, type ChildProcess, execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { logger } from '../../logger';
import { MEETING_SAMPLE_RATE } from './resampler';
import { SINK_BUFFER_MS, type PlaybackSink } from './audio-playback';

const execFileAsync = promisify(execFile);

/** Device names inside our private daemon. Fixed — the daemon is not shared. */
const MEET_OUT_SINK = 'meet_out';
const BOT_SPEAK_SINK = 'bot_speak';
const BOT_MIC_SOURCE = 'bot_mic';

/** How long to wait for the daemon's socket before giving up. */
const DAEMON_READY_TIMEOUT_MS = 10_000;

export interface AudioStackHandles {
  /** Env vars Chrome needs to use the virtual devices and display. */
  browserEnv: Record<string, string>;
  /** Meeting audio, 48 kHz pcm16 mono — feed to the conversation. */
  onCapture: (handler: (pcm48k: Buffer) => void) => void;
  /** Sink for the model's speech, 48 kHz pcm16 mono, with backpressure. */
  playbackSink: PlaybackSink;
}

/**
 * Owns the display and audio processes for one meeting.
 *
 * `start()` is all-or-nothing: a partial failure tears down whatever came up, so a
 * failed join can't leak a daemon or an X server.
 */
export class AudioStack {
  private pulse: ChildProcess | null = null;
  private xvfb: ChildProcess | null = null;
  private parec: ChildProcess | null = null;
  private pacat: ChildProcess | null = null;
  private runtimeDir: string | null = null;
  private display: string | null = null;
  private captureHandler: ((pcm: Buffer) => void) | null = null;
  private stopped = false;

  /** Bring up Xvfb, the PulseAudio daemon, its devices, and the audio pipes. */
  async start(): Promise<AudioStackHandles> {
    try {
      this.runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-meet-'));
      this.display = await this.startXvfb();
      await this.startPulse();
      await this.createDevices();
      this.startCapture();
      this.startPlayback();
    } catch (err) {
      await this.stop();
      throw err;
    }

    return {
      browserEnv: {
        DISPLAY: this.display!,
        XDG_RUNTIME_DIR: this.runtimeDir!,
        PULSE_RUNTIME_PATH: path.join(this.runtimeDir!, 'pulse'),
        // Chrome picks its devices from these rather than needing a UI choice:
        // it plays into meet_out and records from bot_mic.
        PULSE_SINK: MEET_OUT_SINK,
        PULSE_SOURCE: BOT_MIC_SOURCE,
      },
      onCapture: (handler) => {
        this.captureHandler = handler;
      },
      // No backpressure handling needed: `AudioPlayback` paces writes to stay a
      // fixed, small distance ahead of real time, so the pipe never fills. (An
      // earlier version did wait on `drain`, which both destroyed interruption
      // latency — a full pipe holds ~680ms of speech — and could hang forever if
      // pacat died while the pipe was full.)
      playbackSink: {
        write: (chunk: Buffer): boolean => {
          // stdin can be gone if pacat died; dropping a frame is the right failure
          // here — audio is realtime, a retry would arrive too late to matter.
          if (!this.pacat?.stdin?.writable) return true;
          return this.pacat.stdin.write(chunk);
        },
      },
    };
  }

  /**
   * Start Xvfb on a free display.
   *
   * `-displayfd` has the server report the display number it actually took,
   * which avoids racing another process for a hard-coded `:99`.
   */
  private async startXvfb(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // 1280x720 is enough for Meet's join UI and keeps the framebuffer small.
      const proc = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.xvfb = proc;

      let output = '';
      const timer = setTimeout(() => reject(new Error('Xvfb did not report a display in time')), DAEMON_READY_TIMEOUT_MS);

      proc.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        // Anchored and newline-terminated: `-displayfd` writes the number followed
        // by a newline, and matching a bare digit run would resolve `:1` from the
        // first fragment of a display number delivered in pieces — pointing
        // Chromium at a display that isn't ours.
        const match = output.match(/^(\d+)\n/);
        if (match) {
          clearTimeout(timer);
          resolve(`:${match[1]}`);
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Xvfb failed to start (is it installed?): ${err.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (!this.stopped) reject(new Error(`Xvfb exited with code ${code}`));
      });
    });
  }

  /**
   * Start a private PulseAudio daemon.
   *
   * `-n` skips the system config (we load exactly the modules we need),
   * `--exit-idle-time=-1` stops it shutting down between clients, and
   * `--disallow-exit` keeps a client from taking it down with us still using it.
   */
  private async startPulse(): Promise<void> {
    const proc = spawn(
      'pulseaudio',
      [
        '-n',
        '--daemonize=no',
        '--exit-idle-time=-1',
        '--disallow-exit',
        '--load=module-native-protocol-unix',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: this.pulseEnv() },
    );
    this.pulse = proc;

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      logger.error({ err }, '[Meeting] PulseAudio failed to spawn');
    });

    // Wait for the daemon to answer, rather than sleeping a fixed interval:
    // `pactl info` is the readiness check the socket's existence only approximates.
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
    for (;;) {
      if (proc.exitCode !== null) {
        throw new Error(`PulseAudio exited immediately: ${stderr.trim() || `code ${proc.exitCode}`}`);
      }
      try {
        await this.pactl(['info']);
        return;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(
            `PulseAudio did not become ready: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  /** Create the two null-sinks and remap one into a capture source for Chrome. */
  private async createDevices(): Promise<void> {
    await this.pactl([
      'load-module',
      'module-null-sink',
      `sink_name=${MEET_OUT_SINK}`,
      'sink_properties=device.description=MeetOutput',
      `rate=${MEETING_SAMPLE_RATE}`,
      'channels=1',
    ]);
    await this.pactl([
      'load-module',
      'module-null-sink',
      `sink_name=${BOT_SPEAK_SINK}`,
      'sink_properties=device.description=BotSpeech',
      `rate=${MEETING_SAMPLE_RATE}`,
      'channels=1',
    ]);
    // Chrome hides monitor sources from its microphone list, so the bot's speech
    // has to be re-presented as a real source.
    await this.pactl([
      'load-module',
      'module-remap-source',
      `source_name=${BOT_MIC_SOURCE}`,
      `master=${BOT_SPEAK_SINK}.monitor`,
      'source_properties=device.description=BotMicrophone',
      'channels=1',
    ]);
    // Chrome reads these as its defaults when PULSE_SINK/PULSE_SOURCE aren't
    // honoured by a given code path (its audio backend has more than one).
    await this.pactl(['set-default-sink', MEET_OUT_SINK]);
    await this.pactl(['set-default-source', BOT_MIC_SOURCE]);
  }

  /** Record the meeting from meet_out's monitor and hand chunks to the loop. */
  private startCapture(): void {
    const proc = spawn(
      'parec',
      [
        '--device', `${MEET_OUT_SINK}.monitor`,
        '--format=s16le',
        `--rate=${MEETING_SAMPLE_RATE}`,
        '--channels=1',
        // A short latency keeps the model's sense of "now" close to the room's.
        '--latency-msec=20',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: this.pulseEnv() },
    );
    this.parec = proc;

    proc.stdout?.on('data', (chunk: Buffer) => this.captureHandler?.(chunk));
    proc.on('error', (err) => logger.error({ err }, '[Meeting] parec failed'));
    proc.on('exit', (code) => {
      if (!this.stopped) logger.warn(`[Meeting] parec exited unexpectedly (code ${code})`);
    });
  }

  /** Play the model's speech into bot_speak, which Chrome hears as its mic. */
  private startPlayback(): void {
    const proc = spawn(
      'pacat',
      [
        '--device', BOT_SPEAK_SINK,
        '--format=s16le',
        `--rate=${MEETING_SAMPLE_RATE}`,
        '--channels=1',
        // Deep enough that a stalled event loop can't starve the device mid-word.
        // Must stay equal to SINK_BUFFER_MS, which is how playback estimates what
        // the room has actually heard.
        `--latency-msec=${SINK_BUFFER_MS}`,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], env: this.pulseEnv() },
    );
    this.pacat = proc;

    // The sink write path already drops frames when stdin closes; this keeps an
    // EPIPE from becoming an unhandled error event and taking the runtime down.
    proc.stdin?.on('error', (err) => logger.warn(`[Meeting] pacat stdin: ${err.message}`));
    proc.on('error', (err) => logger.error({ err }, '[Meeting] pacat failed'));
    proc.on('exit', (code) => {
      if (!this.stopped) logger.warn(`[Meeting] pacat exited unexpectedly (code ${code})`);
    });
  }

  /** Env pointing PulseAudio clients at our private daemon. */
  private pulseEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      XDG_RUNTIME_DIR: this.runtimeDir!,
      PULSE_RUNTIME_PATH: path.join(this.runtimeDir!, 'pulse'),
    };
  }

  private async pactl(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('pactl', args, { env: this.pulseEnv() });
    return stdout;
  }

  /**
   * Stop every process and remove the runtime dir.
   *
   * Ordered from client to daemon so nothing logs an error about a socket that
   * disappeared underneath it. Idempotent, and never throws: teardown runs on the
   * error path too, where a second failure would mask the first.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.captureHandler = null;

    for (const proc of [this.parec, this.pacat, this.pulse, this.xvfb]) {
      if (!proc || proc.exitCode !== null) continue;
      try {
        proc.kill('SIGTERM');
      } catch (err) {
        logger.debug(`[Meeting] Failed to signal a stack process: ${String(err)}`);
      }
    }

    // Give them a moment to exit cleanly, then insist.
    await new Promise((r) => setTimeout(r, 300));
    for (const proc of [this.parec, this.pacat, this.pulse, this.xvfb]) {
      if (proc && proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }

    this.parec = this.pacat = this.pulse = this.xvfb = null;

    if (this.runtimeDir) {
      try {
        await fs.rm(this.runtimeDir, { recursive: true, force: true });
      } catch (err) {
        logger.debug(`[Meeting] Could not remove runtime dir: ${String(err)}`);
      }
      this.runtimeDir = null;
    }
  }
}

/** Executables the audio/display stack needs on PATH. */
export const AUDIO_STACK_BINARIES = ['Xvfb', 'pulseaudio', 'pactl', 'parec', 'pacat'];
