/**
 * Bind Address Tests
 *
 * What `listenOn` hands to `server.listen`, which is what keeps a local
 * install on loopback.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from './config';
import { listenOn } from './server';

const boundTo = (host: string) => {
  (config as unknown as { host: string }).host = host;
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
