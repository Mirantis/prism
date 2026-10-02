/**
 * Whether a hostname names this machine: a bind address, or the host part of a
 * `Host` or `Origin` header.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);

// The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase()) || IPV4_LOOPBACK.test(hostname);
}
