/**
 * A remote computer for the web suite. It adds itself through the REST API, links in on
 * `/api/computer-link` as a computer client does, answers every request, and records
 * them. Its screen is the picture the scenario gives it.
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const RUNTIME = 'http://localhost:3003';

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

export class FakeComputer {
  /** Every request and notification the runtime sent, in order. */
  readonly received: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** The close code the runtime ended the link with, once it has. */
  closeCode: number | null = null;
  private stream: NodeJS.Timeout | null = null;

  private constructor(
    readonly id: string,
    readonly name: string,
    private readonly ws: WebSocket,
    private readonly screen: { jpeg: Buffer; width: number; height: number },
  ) {
    ws.on('message', (data, binary) => {
      if (!binary) this.receive(JSON.parse(data.toString()) as Rpc);
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      this.stopStream();
    });
  }

  /** Add the computer, open its link and wait for the runtime's answer to `initialize`. */
  static async connect(
    name: string,
    screen: { jpeg: Buffer; width: number; height: number },
  ): Promise<FakeComputer> {
    const res = await fetch(`${RUNTIME}/agents/computers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, platform: 'macos', installationId: randomUUID() }),
    });
    if (!res.ok) throw new Error(`adding ${name} failed: ${res.status} ${await res.text()}`);
    const { computer } = (await res.json()) as { computer: { id: string } };
    const ws = new WebSocket(`${RUNTIME.replace(/^http/, 'ws')}/api/computer-link?computer=${computer.id}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const client = new FakeComputer(computer.id, name, ws, screen);
    const initialized = new Promise<void>((resolve) => {
      ws.on('message', (data, binary) => {
        if (!binary && (JSON.parse(data.toString()) as Rpc).id === 'init') resolve();
      });
    });
    client.send({
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: 1,
        client: { name: 'e2e-fake-computer', version: '1.0.0' },
        platform: 'macos',
        displays: [{ id: 'main', width: screen.width, height: screen.height, scale: 1, primary: true }],
        capabilities: ['screen', 'input', 'stream'],
      },
    });
    await initialized;
    return client;
  }

  /** The requests of one method the runtime sent. */
  requests(method: string): Array<Record<string, unknown>> {
    return this.received.filter((item) => item.method === method).map((item) => item.params);
  }

  close(): void {
    this.stopStream();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }

  private receive(message: Rpc): void {
    if (!message.method) return;
    this.received.push({ method: message.method, params: message.params ?? {} });
    if (message.id === undefined) return;
    this.send({ id: message.id, result: this.answer(message.method) });
  }

  private answer(method: string): unknown {
    if (method === 'screen.capture') {
      return {
        mediaType: 'image/jpeg',
        width: this.screen.width,
        height: this.screen.height,
        data: this.screen.jpeg.toString('base64'),
      };
    }
    if (method === 'stream.start') {
      this.stopStream();
      // The answer goes out before the first picture, as the protocol requires.
      setTimeout(() => {
        this.stream = setInterval(() => {
          if (this.ws.readyState !== WebSocket.OPEN) return;
          this.ws.send(Buffer.concat([Buffer.from([0x01, 0]), this.screen.jpeg]), { binary: true });
        }, 500);
      }, 0);
      return { encoding: 'jpeg', width: this.screen.width, height: this.screen.height };
    }
    if (method === 'stream.stop') this.stopStream();
    return {};
  }

  private stopStream(): void {
    if (this.stream) clearInterval(this.stream);
    this.stream = null;
  }

  private send(message: Omit<Rpc, 'jsonrpc'>): void {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
  }
}

/** Remove every remote computer, so the runtime's own list matches the wiped database. */
export async function removeRemoteComputers(): Promise<void> {
  try {
    const res = await fetch(`${RUNTIME}/agents/computers`);
    const { computers } = (await res.json()) as { computers: Array<{ id: string; kind: string }> };
    for (const computer of computers.filter((item) => item.kind === 'remote')) {
      await fetch(`${RUNTIME}/agents/computers/${computer.id}`, { method: 'DELETE' });
    }
  } catch (error) {
    console.warn(
      `[e2e] Failed to remove remote computers: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
