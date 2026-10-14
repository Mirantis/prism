/**
 * The public-address guard: which addresses count as public, every DNS answer
 * checked, and a connection that re-checks the name it resolves.
 */

import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPublicLiteral,
  getPublicDispatcher,
  isPublicAddress,
  PrivateAddressError,
  publicLookup,
} from './public-url';

describe('isPublicAddress', () => {
  it.each([
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local, the cloud metadata service'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.8', 'IETF protocol assignments'],
    ['192.0.2.10', 'documentation'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata address'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['::ffff:0:127.0.0.1', 'IPv4-translated loopback'],
    ['::ffff:0:a9fe:a9fe', 'IPv4-translated metadata address'],
    ['::ffff:0:c0a8:101', 'IPv4-translated 192.168.1.1'],
    ['64:ff9b::a00:1', 'NAT64 of 10.0.0.1'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 of 169.254.169.254'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['100::1', 'discard-only'],
    ['100:0:0:1::1', 'dummy prefix'],
    ['5f00::1', 'segment routing SIDs'],
    ['2002:7f00:1::', '6to4 of 127.0.0.1'],
    ['2002:c0a8:101::1', '6to4 of 192.168.1.1'],
    ['2001:0:4136:e378::1', 'Teredo'],
    ['2001:2::1', 'benchmarking'],
    ['2001:10::1', 'deprecated ORCHID'],
    ['2001:20::1', 'ORCHIDv2'],
    ['2001:1ff:ffff::1', 'the last IETF protocol assignment'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
  ])('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.215.14',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '2001:200::1',
    '2001:4860:4860::8888',
    '64:ff9b::808:808',
    '2002:808:808::1',
    '::ffff:8.8.8.8',
  ])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it('refuses a value that is not an IP address', () => {
    expect(isPublicAddress('localhost')).toBe(false);
  });
});

describe('assertPublicLiteral', () => {
  it.each([
    ['http://127.0.0.1/', '127.0.0.1'],
    ['http://2130706433/', '127.0.0.1'],
    ['http://0x7f.1/', '127.0.0.1'],
    ['http://0177.0.0.1/', '127.0.0.1'],
    ['http://[::ffff:127.0.0.1]/', '::ffff:7f00:1'],
    ['http://[::1]/', '::1'],
  ])('refuses the literal in %s', (url, address) => {
    expect(() => assertPublicLiteral(new URL(url).hostname)).toThrow(
      expect.objectContaining({ name: 'PrivateAddressError', address }),
    );
  });

  it('allows a public literal', () => {
    expect(() => assertPublicLiteral('[2606:4700:4700::1111]')).not.toThrow();
  });

  it('leaves a name to the connection, which resolves it under the request timeout', () => {
    const lookup = vi.spyOn(dns, 'lookup');
    expect(() => assertPublicLiteral('localhost')).not.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('publicLookup', () => {
  function lookupAll(hostname: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      publicLookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
    });
  }

  it('fails when any answer is private', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: unknown, callback: dns.LookupAllCallback) =>
      callback(null, [
        { address: '93.184.215.14', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ])) as never);
    const refusal = lookupAll('metadata.example.test');

    await expect(refusal).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(refusal).rejects.toMatchObject({ hostname: 'metadata.example.test', address: '169.254.169.254' });
  });

  it('answers with every address when they are all public', async () => {
    const answers = [
      { address: '93.184.215.14', family: 4 },
      { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
    ];
    vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: unknown, callback: dns.LookupAllCallback) =>
      callback(null, answers)) as never);
    await expect(lookupAll('docs.example.test')).resolves.toEqual(answers);
  });
});

describe('getPublicDispatcher', () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('refuses a name that resolves to a private address when it connects', async () => {
    // A rebinding name: public when checked before the request, loopback when the
    // connection resolves it. The connection is what has to refuse it.
    server = http.createServer((_req, res) => res.end('loopback service'));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: unknown, callback: dns.LookupAllCallback) =>
      callback(null, [{ address: '127.0.0.1', family: 4 }])) as never);

    await expect(
      request(`http://rebind.example.test:${port}/`, { dispatcher: getPublicDispatcher() }),
    ).rejects.toMatchObject({ code: 'EPRIVATEADDRESS', address: '127.0.0.1' });
  });
});
