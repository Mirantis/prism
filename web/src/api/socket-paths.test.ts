/**
 * The sockets the page opens have to be paths the dev server forwards.
 *
 * In development and in the e2e suite the SPA is served by Vite on its own port, and only
 * the paths named in its proxy reach the runtime. A socket on any other path is answered
 * by Vite instead, which looks like a page that connected and then heard nothing: the
 * Computer page went live with a blank screen when its path was renamed here and not
 * there.
 */

import { describe, it, expect } from 'vitest';
import viteConfig from '../../vite.config';
import { COMPUTER_SOCKET_PATH } from './runtime-client';

/** The paths the dev server forwards to the runtime. */
function proxiedPaths(): string[] {
  const config = viteConfig as { server?: { proxy?: Record<string, unknown> } };
  return Object.keys(config.server?.proxy ?? {});
}

describe('the dev server proxy', () => {
  it('forwards the computer screen socket', () => {
    expect(proxiedPaths()).toContain(COMPUTER_SOCKET_PATH);
  });

  it('forwards the chat socket, which carries the call', () => {
    expect(proxiedPaths()).toContain('/api/ws');
  });

  it('forwards the REST surface', () => {
    expect(proxiedPaths()).toContain('/agents');
  });
});
