/**
 * A browser WebSocket stand-in for tests, installed with
 * `vi.stubGlobal('WebSocket', FakeWebSocket)`. The test plays the runtime: it opens the
 * socket, delivers frames and closes it with a code.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  readonly url: string;
  readonly sent: (string | ArrayBuffer)[] = [];
  /** The code the client closed this socket with. */
  closedWith: number | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('no socket was opened');
    return ws;
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code = 1005): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = code;
  }

  /** The JSON frames the client sent, parsed. Audio frames are left out. */
  get frames(): Array<Record<string, any>> {
    return this.sent.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  deliver(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  deliverAudio(frame: ArrayBuffer): void {
    this.onmessage?.({ data: frame });
  }

  /** The runtime closes the socket. */
  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

export const STREAM_ID = '07267e2b-eb98-445a-b535-76e5a987d1cb';

/** A `welcome` for a fresh connection, with nothing working. */
export function welcomeFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'welcome',
    payload: {
      protocol: 2,
      streamId: STREAM_ID,
      seq: 0,
      resumed: false,
      you: { id: 'ada@example.com', name: 'ada@example.com' },
      snapshot: { turns: [], computer: null },
      ...overrides,
    },
  };
}
