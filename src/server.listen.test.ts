/**
 * Bind Address Tests
 *
 * What `listenOn` hands to `server.listen`, which is
 * what keeps a local install on loopback.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { listenOn } from './server';
import { boundTo } from './test-utils/origin-config';

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
