/**
 * Test helpers that set the two values the origin rules read from the config:
 * the bind address and `PRISM_ALLOWED_ORIGINS`. Each mutates the config object,
 * so a test resets them in `afterEach`.
 */

import { config } from '../config';
import { isLoopbackHostname } from '../lib/loopback-host';
import { type OriginPattern, parseOriginPatterns } from '../lib/origin-patterns';

const mutable = config as unknown as {
  host: string;
  listensOnLoopback: boolean;
  allowedOrigins: OriginPattern[];
};

/** The address the server listens on, as `PRISM_HOST` would set it. */
export function boundTo(host: string): void {
  mutable.host = host;
  mutable.listensOnLoopback = isLoopbackHostname(host);
}

/** The configured `PRISM_ALLOWED_ORIGINS`; an empty string clears it. */
export function allowing(csv: string): void {
  mutable.allowedOrigins = parseOriginPatterns(csv);
}
