/**
 * Bind Address Tests
 *
 * What `listenOn` and `listenForWebhooks` hand to `server.listen`, which is
 * what keeps a local install on loopback.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'http';
import net, { type AddressInfo } from 'net';
import { config } from './config';
import { logger } from './logger';
import { listenForWebhooks, listenOn } from './server';

const boundTo = (host: string) => {
  (config as unknown as { host: string }).host = host;
};

const webhooksOn = (port: number) => {
  (config as unknown as { webhookPort: number }).webhookPort = port;
};

describe('listenOn', () => {
  afterEach(() => boundTo('127.0.0.1'));

  it('binds the configured port on loopback by default', () => {
    const listen = vi.fn();
    listenOn({ listen } as never);
    expect(listen).toHaveBeenCalledWith(3003, '127.0.0.1', expect.any(Function));
  });

  it('binds the interface PRISM_HOST names', () => {
    boundTo('0.0.0.0');
    const listen = vi.fn();
    listenOn({ listen } as never);
    expect(listen).toHaveBeenCalledWith(3003, '0.0.0.0', expect.any(Function));
  });
});

describe('listenForWebhooks', () => {
  afterEach(() => {
    boundTo('127.0.0.1');
    webhooksOn(3004);
  });

  it('binds the webhook port on the same interface as the main port', () => {
    boundTo('0.0.0.0');
    const listen = vi.fn();
    listenForWebhooks({ listen, on: vi.fn() } as never);
    expect(listen).toHaveBeenCalledWith(3004, '0.0.0.0', expect.any(Function));
  });

  it('logs a taken port and leaves the runtime running', async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    webhooksOn((taken.address() as AddressInfo).port);
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const server = createServer();

    listenForWebhooks(server);

    await vi.waitFor(() => expect(logError).toHaveBeenCalled());
    expect(server.listening).toBe(false);
    await new Promise((resolve) => taken.close(resolve));
  });
});
