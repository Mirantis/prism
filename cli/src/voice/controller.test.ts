import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { VoiceController, type VoiceTransport } from './controller.js';
import type { AudioSession, startAudio } from './audio.js';

function setup() {
  const transport: VoiceTransport = {
    events: new EventEmitter(), voiceConnected: true,
    sendVoice: vi.fn(() => true), sendVoiceAudio: vi.fn(() => true),
  };
  const audio: AudioSession = { play: vi.fn(), clear: vi.fn(), mute: vi.fn(), stop: vi.fn() };
  let callbacks: Parameters<typeof startAudio>[0];
  const open = vi.fn(async (options: Parameters<typeof startAudio>[0]) => { callbacks = options; return audio; });
  const controller = new VoiceController(transport, open);
  const event = (type: string, payload?: unknown) => transport.events.emit('voice', { type, payload });
  const live = () => {
    event('voice_state', { state: 'live' });
    event('voice_hello', { format: { encoding: 'pcm16', channels: 1, sampleRate: 24_000 } });
  };
  return { controller, transport, audio, open, event, live, callbacks: () => callbacks };
}

describe('voice call lifecycle', () => {
  it('waits for the format, supports mute, and clears interrupted playback', async () => {
    const s = setup();
    await s.controller.start('thread-1');
    expect(s.transport.sendVoice).toHaveBeenCalledWith({ type: 'voice_start', payload: { threadId: 'thread-1', mode: 'open', client: 'tui' } });
    s.callbacks().onAudio(Buffer.alloc(960));
    expect(s.transport.sendVoiceAudio).not.toHaveBeenCalled();
    s.live();
    s.callbacks().onAudio(Buffer.alloc(960));
    expect(s.transport.sendVoiceAudio).toHaveBeenCalledTimes(1);
    s.controller.mute();
    s.callbacks().onAudio(Buffer.alloc(960));
    expect(s.transport.sendVoiceAudio).toHaveBeenCalledTimes(1);
    s.transport.events.emit('voiceAudio', Buffer.alloc(960));
    expect(s.audio.play).toHaveBeenCalledOnce();
    s.event('voice_clear');
    expect(s.audio.clear).toHaveBeenCalledOnce();
    s.controller.mute();
    s.callbacks().onAudio(Buffer.alloc(960));
    expect(s.transport.sendVoiceAudio).toHaveBeenCalledTimes(2);
    s.controller.dispose();
  });

  it('cancels local startup before sending a server request', async () => {
    const s = setup();
    let resolve!: (audio: AudioSession) => void;
    s.open.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const starting = s.controller.start();
    s.controller.stop();
    resolve(s.audio);
    await starting;
    expect(s.transport.sendVoice).not.toHaveBeenCalled();
    expect(s.audio.stop).toHaveBeenCalled();
    s.controller.dispose();
  });

  it('waits for cancellation to finish before allowing a new call', async () => {
    const s = setup();
    await s.controller.start();
    s.controller.stop();
    s.live();
    await s.controller.start();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.controller.state.status).toBe('ending');
    s.event('voice_state', { state: 'ended' });
    await s.controller.start();
    expect(s.open).toHaveBeenCalledTimes(2);
    s.controller.dispose();
  });

  it('releases audio on disconnect and requires an explicit restart', async () => {
    const s = setup();
    await s.controller.start();
    s.live();
    s.transport.events.emit('voiceDisconnected');
    expect(s.audio.stop).toHaveBeenCalled();
    expect(s.controller.state.status).toBe('ended');
    s.live();
    expect(s.controller.state.status).toBe('ended');
    expect(s.open).toHaveBeenCalledTimes(1);
    s.controller.dispose();
  });

  it('reports local device failures once and ends the server call', async () => {
    const s = setup();
    await s.controller.start();
    s.live();
    s.callbacks().onFailure();
    expect(s.transport.sendVoice).toHaveBeenCalledWith({ type: 'voice_client_error', payload: { code: 'device', phase: 'call' } });
    expect(s.transport.sendVoice).toHaveBeenCalledWith({ type: 'voice_stop' });
    expect(s.audio.stop).toHaveBeenCalled();
    s.event('voice_error', { error: 'The client audio stopped.' });
    s.event('voice_state', { state: 'ended' });
    expect(s.controller.state.error).toContain('Audio stopped');
    s.controller.dispose();
  });

  it('releases the microphone after a refused call and permits retry', async () => {
    const s = setup();
    await s.controller.start();
    s.event('voice_error', { error: 'Another call is running.' });
    expect(s.controller.state.error).toBe('Another call is running.');
    expect(s.audio.stop).toHaveBeenCalled();
    await s.controller.start();
    expect(s.open).toHaveBeenCalledTimes(2);
    s.controller.dispose();
  });

  it('ends a session with an unsupported format before sending microphone audio', async () => {
    const s = setup();
    await s.controller.start();
    s.event('voice_hello', { format: { encoding: 'pcm16', channels: 2, sampleRate: 48_000 } });
    expect(s.controller.state.status).toBe('ending');
    expect(s.transport.sendVoiceAudio).not.toHaveBeenCalled();
    s.controller.dispose();
  });
});
