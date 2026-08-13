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

/** Gap between reads while waiting for the browser to open the virtual mic. */
const MIC_CAPTURE_POLL_MS = 500;

/**
 * Is anything capturing this source, per `pactl list short sources`?
 *
 * A separate pure function because the value is in the parsing: the interesting
 * answer ("has the browser actually opened the microphone?") is one word at the end
 * of a tab-separated line, and a test can pin that against real `pactl` output
 * without a PulseAudio daemon, which is the only way this gets covered at all.
 *
 * Fields are split on whitespace rather than tabs — `pactl` has emitted both, and the
 * sample spec in the middle ("s16le 1ch 48000Hz") is what makes a naive tab split
 * look like it works. The name is the second field and the state is the last, which
 * holds under either separator.
 */
export function sourceIsRunning(pactlShortSources: string, sourceName: string): boolean {
  for (const line of pactlShortSources.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[1] !== sourceName) continue;
    // RUNNING means a client is reading it; IDLE and SUSPENDED both mean nobody is.
    return fields[fields.length - 1].toUpperCase() === 'RUNNING';
  }
  return false;
}

export interface AudioStackHandles {
  /** Env vars Chrome needs to use the virtual devices and display. */
  browserEnv: Record<string, string>;
  /** Meeting audio, 48 kHz pcm16 mono — feed to the conversation. */
  onCapture: (handler: (pcm48k: Buffer) => void) => void;
  /**
   * Called once if capture or playback dies while the stack is meant to be running.
   *
   * There is no recovery inside the stack: a dead `parec` means nothing the room
   * says will ever reach a model again, and a dead `pacat` means nothing the model
   * says will ever be heard, so the owner ends the call rather than leave a
   * participant that has silently stopped taking part. Fires immediately if the
   * loss happened before a handler was registered.
   */
  onLost: (handler: (reason: string) => void) => void;
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
  private lostHandler: ((reason: string) => void) | null = null;
  /** Kept so a loss that beats the handler's registration still gets reported. */
  private lostReason: string | null = null;
  private stopped = false;

  /** Bring up Xvfb, the PulseAudio daemon, its devices, and the audio pipes. */
  async start(): Promise<AudioStackHandles> {
    try {
      this.runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-meeting-'));
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
      onLost: (handler) => {
        this.lostHandler = handler;
        if (this.lostReason) handler(this.lostReason);
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
    proc.on('error', (err) => this.noteLoss(`the capture process failed to run: ${err.message}`));
    proc.on('exit', (code) => this.noteLoss(`the capture process exited (code ${code})`));
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
    proc.on('error', (err) => this.noteLoss(`the playback process failed to run: ${err.message}`));
    proc.on('exit', (code) => this.noteLoss(`the playback process exited (code ${code})`));
  }

  /**
   * Wait until the browser is actually reading the virtual microphone.
   *
   * The device half of "can the room hear us", which is all this layer can answer. A
   * meeting platform's own UI can report a live microphone over a capture device the
   * browser never opened; those are two different systems, and only this one is ours.
   * `bot_mic` going RUNNING means a client holds the source open, which for this
   * private daemon can only be the browser — our own `parec` records the meeting sink's
   * monitor, a different device, so this reading can't be contaminated by our capture.
   *
   * What it does **not** prove is that the room can hear us: WebRTC mute disables the
   * track rather than closing the device, so a muted-but-open microphone still reads
   * RUNNING. This answers "did a capture device ever open" — the provider answers
   * whether the platform is transmitting it, because the provider owns the page and
   * this owns the devices.
   *
   * Polled rather than awaited on an event because PulseAudio offers no such event to
   * a shell client, and it is genuinely a wait: the browser opens the device a moment
   * after an unmute lands. `false` on timeout rather than a throw — what an unheard
   * agent is worth is the caller's judgement, not this layer's.
   */
  async waitForMicCapture(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // A stack torn down under us has no daemon left to ask — `pulseEnv()` throws on
      // the nulled runtime dir — so polling on would just burn the whole budget for a
      // call that is already over.
      if (this.stopped) return false;
      const read = await this.readMicCapture();
      if (read.capturing) return true;

      if (Date.now() >= deadline) {
        logger.warn(
          `[Meeting] ${BOT_MIC_SOURCE} is still not being captured after ${timeoutMs}ms` +
            (read.failure ? ` (last read failed: ${read.failure})` : ''),
        );
        return false;
      }
      await new Promise((r) => setTimeout(r, MIC_CAPTURE_POLL_MS));
    }
  }

  /**
   * One read of the same question, for a caller that will ask again anyway.
   *
   * The mid-call unmute retry runs every ten seconds for the length of a call, so it
   * wants the reading without the waiting and — more to the point — without the warning
   * line, which `waitForMicCapture` is right to log once on a join and would be wrong to
   * log a hundred times on one meeting.
   */
  async isMicCaptured(): Promise<boolean> {
    if (this.stopped) return false;
    return (await this.readMicCapture()).capturing;
  }

  /** Is anything reading `bot_mic` right now, and if the question failed, why. */
  private async readMicCapture(): Promise<{ capturing: boolean; failure: string | null }> {
    try {
      const sources = await this.pactl(['list', 'short', 'sources']);
      return { capturing: sourceIsRunning(sources, BOT_MIC_SOURCE), failure: null };
    } catch (err) {
      // Anomalous rather than expected: `start()` already ran a dozen `pactl` calls, so
      // one failing now is worth reporting even though every caller retries.
      return { capturing: false, failure: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Record the first unexpected death of capture or playback and tell the owner.
   *
   * Once only: `stop()` kills both, so the second exit is our own doing, and a
   * teardown already under way must not be told twice about a stack it is
   * dismantling.
   */
  private noteLoss(reason: string): void {
    if (this.stopped || this.lostReason) return;
    this.lostReason = reason;
    logger.error(`[Meeting] Audio stack lost: ${reason}`);
    this.lostHandler?.(reason);
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
    // The owner is already ending the call — the deaths below are its own doing.
    this.lostHandler = null;

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
