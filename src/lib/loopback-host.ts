/**
 * Whether a hostname names this machine: a bind address, or the host part of a
 * `Host` or `Origin` header.
 *
 * The value goes through the URL parser first, which gives every spelling of an
 * address one form: `127.1` and `0x7f.1` become `127.0.0.1`, and
 * `0:0:0:0:0:0:0:1` becomes `[::1]`. A zone index (`::1%lo0`) is dropped first,
 * because the parser refuses it and the socket binds the address without it.
 * Any other value the parser cannot read is compared as written.
 *
 * `localhost` and names under it count, as RFC 6761 reserves them for loopback.
 * A name that only resolves to loopback through `/etc/hosts` or DNS does not:
 * this decides from the text, so it is not exhaustive.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', 'localhost.', '[::1]']);

// The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

// The same block as an IPv4-mapped IPv6 address, which the parser writes in hex.
const IPV4_MAPPED_LOOPBACK = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

function normalizeHostname(raw: string): string {
  const unzoned = raw.replace(/%.*?(?=\]|$)/, '');
  const bracketed = unzoned.includes(':') && !unzoned.startsWith('[') ? `[${unzoned}]` : unzoned;
  try {
    return new URL(`http://${bracketed}`).hostname;
  } catch {
    return unzoned.toLowerCase();
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    LOOPBACK_HOSTNAMES.has(normalized) ||
    /\.localhost\.?$/.test(normalized) ||
    IPV4_LOOPBACK.test(normalized) ||
    IPV4_MAPPED_LOOPBACK.test(normalized)
  );
}
