/**
 * The public internet, as an outbound read may reach it.
 *
 * The runtime process is on the host's network, so an address the agent chooses
 * could reach the host's loopback services, the LAN and the cloud metadata service.
 * The dispatcher from `getPublicDispatcher` checks every DNS answer when it
 * connects, so the address a connection uses is an address that was checked, and
 * `assertPublicLiteral` checks an address written in the URL itself.
 */

import dns from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

/** IPv4 ranges outside the public internet, from the IANA special-purpose registry. */
const NON_PUBLIC_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/**
 * IPv6 ranges outside the public internet. `::/96` holds the unspecified and loopback
 * addresses and the deprecated IPv4-compatible form. `2001::/23` holds the IETF
 * protocol assignments, Teredo, benchmarking and ORCHID among them, and no web server.
 */
const NON_PUBLIC_IPV6: ReadonlyArray<readonly [string, number]> = [
  ['::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['100:0:0:1::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of NON_PUBLIC_IPV4) {
  // An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) matches this IPv4 rule.
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
  // NAT64, 6to4 and IPv4-translated (`::ffff:0:a.b.c.d`) addresses contain an IPv4
  // address that a translator or gateway delivers to.
  const [high, low] = ipv4Groups(network);
  NON_PUBLIC.addSubnet(`64:ff9b::${high}:${low}`, 96 + prefix, 'ipv6');
  NON_PUBLIC.addSubnet(`2002:${high}:${low}::`, 16 + prefix, 'ipv6');
  NON_PUBLIC.addSubnet(`::ffff:0:${high}:${low}`, 96 + prefix, 'ipv6');
}
for (const [network, prefix] of NON_PUBLIC_IPV6) NON_PUBLIC.addSubnet(network, prefix, 'ipv6');

/** An IPv4 address as the two 16-bit IPv6 groups that hold it. */
function ipv4Groups(address: string): [string, string] {
  const [a, b, c, d] = address.split('.').map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

/** Whether an IP address is on the public internet. Anything that is not an IP address is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** A host that is, or resolves to, an address outside the public internet. */
export class PrivateAddressError extends Error {
  readonly code = 'EPRIVATEADDRESS';

  constructor(
    readonly hostname: string,
    readonly address: string,
  ) {
    super(`${address} is not a public address`);
    this.name = 'PrivateAddressError';
  }
}

/**
 * Refuse an address literal that is not public. A connection to a literal makes no
 * DNS lookup, so `publicLookup` never sees it. `hostname` is `URL.hostname`, which
 * keeps the brackets of an IPv6 literal.
 */
export function assertPublicLiteral(hostname: string): void {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isIP(host) && !isPublicAddress(host)) throw new PrivateAddressError(host, host);
}

/**
 * `dns.lookup` for a socket, failing when any answer is not public. Every answer is
 * checked, because the connection may use any of them.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const refused = addresses.find((answer) => !isPublicAddress(answer.address));
    if (refused) return callback(new PrivateAddressError(hostname, refused.address), '');
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

let publicDispatcher: Agent | undefined;

/** The dispatcher for a direct read: each connection resolves its host with `publicLookup`. */
export function getPublicDispatcher(): Agent {
  publicDispatcher ??= new Agent({ connect: { lookup: publicLookup } });
  return publicDispatcher;
}
