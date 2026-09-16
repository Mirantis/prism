import { describe, it, expect, vi } from 'vitest';
const { sockets } = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    send = vi.fn();
    close = vi.fn();
    constructor() { super(); sockets.push(this); }
  }
  return { default: Socket };
});
import { WsClient } from './ws-client.js';

describe('voice WebSocket transport', () => {
  it('never replays disconnected voice sends while retaining text queue behavior', () => {
    const client = new WsClient({ url: 'ws://localhost' });
    const socket = sockets.at(-1);
    expect(client.sendConnected({ type: 'voice_start' })).toBe(false);
    expect(client.sendAudio(Buffer.alloc(960))).toBe(false);
    client.send({ type: 'chat' });
    socket.readyState = 1;
    socket.emit('open');
    expect(socket.send.mock.calls).toEqual([[JSON.stringify({ type: 'chat' })]]);
    socket.bufferedAmount = 48_001;
    expect(client.sendAudio(Buffer.alloc(960))).toBe(false);
    client.close();
  });

  it('separates binary audio from JSON control messages', () => {
    const client = new WsClient({ url: 'ws://localhost' });
    const socket = sockets.at(-1);
    const audio = vi.fn(), envelope = vi.fn();
    client.events.on('audio', audio);
    client.events.on('envelope', envelope);
    socket.emit('message', Buffer.from([0, 1]), true);
    socket.emit('message', Buffer.from('{"type":"voice_clear"}'), false);
    expect(audio).toHaveBeenCalledWith(Buffer.from([0, 1]));
    expect(envelope).toHaveBeenCalledWith({ type: 'voice_clear' });
    client.close();
  });
});
