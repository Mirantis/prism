import { EventEmitter } from 'events';

/**
 * Stands in for the `ws` package's WebSocket in unit tests. It records the
 * frames the client sends, and the test plays the runtime's side with `open`,
 * `receive` and `serverClose`.
 */
export class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  terminated = false;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error('no socket was opened');
    return socket;
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.serverClose(1005);
  }

  terminate(): void {
    this.terminated = true;
    this.serverClose(1006);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  receive(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }

  serverClose(code: number, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }

  /** The frames sent so far of one type. */
  sentOf(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((f) => f.type === type);
  }
}
