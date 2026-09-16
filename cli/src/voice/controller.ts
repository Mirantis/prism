import { EventEmitter } from 'node:events';
import type { WsEnvelope } from '../ws-client.js';
import { startAudio, type AudioSession } from './audio.js';

export interface VoiceTransport {
  events: EventEmitter;
  readonly voiceConnected: boolean;
  sendVoice(env: WsEnvelope): boolean;
  sendVoiceAudio(pcm: Buffer): boolean;
}
export interface VoiceState {
  status: 'ready' | 'connecting' | 'live' | 'ending' | 'ended';
  muted: boolean;
  error?: string;
}

export class VoiceController {
  readonly events = new EventEmitter();
  state: VoiceState = { status: 'ready', muted: false };
  private audio?: AudioSession;
  private abort?: AbortController;
  private requested = false;
  private hello = false;
  private live = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private transport: VoiceTransport, private openAudio = startAudio) {
    transport.events.on('voice', this.onEnvelope);
    transport.events.on('voiceAudio', this.onAudio);
    transport.events.on('voiceDisconnected', this.onDisconnect);
  }

  private update(state: VoiceState): void {
    this.state = state;
    this.events.emit('change', state);
  }

  async start(threadId?: string): Promise<void> {
    if (this.state.status !== 'ready' && this.state.status !== 'ended') return;
    if (!this.transport.voiceConnected) {
      this.update({ status: 'ended', muted: false, error: 'Connect to the agent before starting voice chat.' });
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.hello = this.live = false;
    this.update({ status: 'connecting', muted: false });
    try {
      const audio = await this.openAudio({
        signal: abort.signal,
        onAudio: (pcm) => {
          if (this.state.status !== 'live' || this.state.muted) return;
          if (!this.transport.sendVoiceAudio(pcm)) this.localFailure('connection', 'The audio connection stopped. Start another call when connected.');
        },
        onFailure: () => this.localFailure('device', 'Audio stopped. Check your input and output devices, then retry.'),
      });
      if (abort.signal.aborted) { audio.stop(); return; }
      this.audio = audio;
      this.requested = this.transport.sendVoice({ type: 'voice_start', payload: { threadId, mode: 'open', client: 'tui' } });
      if (!this.requested) { this.finish('The connection closed. Reconnect and retry.'); return; }
      this.timer = setTimeout(() => this.localFailure('timeout', 'Voice chat took too long to start.'), 30_000);
    } catch (error) {
      if (abort.signal.aborted) return;
      this.localFailure('open', error instanceof Error ? error.message : 'Could not open audio.');
    }
  }

  mute(): void {
    if (this.state.status !== 'live') return;
    const muted = !this.state.muted;
    this.audio?.mute(muted);
    this.update({ ...this.state, muted });
  }

  stop(): void {
    this.releaseAudio();
    if (this.requested) {
      if (this.state.status === 'ending') return;
      this.update({ ...this.state, status: 'ending', muted: false });
      if (!this.transport.sendVoice({ type: 'voice_stop' })) this.finish();
      return;
    }
    this.finish();
  }

  dispose(): void {
    this.stop();
    this.transport.events.off('voice', this.onEnvelope);
    this.transport.events.off('voiceAudio', this.onAudio);
    this.transport.events.off('voiceDisconnected', this.onDisconnect);
  }

  private releaseAudio(): void {
    clearTimeout(this.timer);
    this.abort?.abort();
    this.abort = undefined;
    this.audio?.stop();
    this.audio = undefined;
  }

  private finish(error = this.state.error): void {
    this.releaseAudio();
    this.requested = false;
    this.update({ status: 'ended', muted: false, error });
  }

  private localFailure(code: string, error: string): void {
    this.transport.sendVoice({ type: 'voice_client_error', payload: { code, phase: this.state.status === 'live' ? 'call' : 'start' } });
    this.update({ ...this.state, error });
    this.stop();
  }

  private onDisconnect = (): void => {
    if (this.state.status === 'ready' || this.state.status === 'ended') return;
    this.finish('Disconnected. Reconnect and start another call.');
  };

  private onAudio = (pcm: Buffer): void => {
    if (this.state.status === 'live') this.audio?.play(pcm);
  };

  private onEnvelope = (env: WsEnvelope): void => {
    if (!this.requested) return;
    const payload = (env.payload ?? {}) as { error?: string; state?: string; format?: { encoding: string; sampleRate: number; channels: number } };
    if (env.type === 'voice_error') {
      if (!this.live) this.finish(this.state.error ?? payload.error ?? 'The call could not start.');
      else {
        this.update({ ...this.state, error: this.state.error ?? payload.error });
        this.stop();
      }
      return;
    }
    if (env.type === 'voice_state' && payload.state === 'ended') { this.finish(); return; }
    if (this.state.status === 'ending') return;
    if (env.type === 'voice_clear') { this.audio?.clear(); return; }
    if (env.type === 'voice_hello') {
      const format = payload.format;
      if (format?.encoding !== 'pcm16' || format.sampleRate !== 24_000 || format.channels !== 1) {
        this.localFailure('format', 'The agent offered an unsupported audio format.');
        return;
      }
      this.hello = true;
    }
    if (env.type === 'voice_state' && payload.state === 'live') this.live = true;
    if (this.hello && this.live) {
      clearTimeout(this.timer);
      this.update({ ...this.state, status: 'live' });
    }
  };
}
