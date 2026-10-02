/**
 * Origin Pattern Tests
 *
 * The base vector tables (the valid and invalid entries, and the two matching
 * tables) are common to every component that reads an origin list in this
 * syntax; keep them verbatim. Each component adds its own cases after them.
 */

import { describe, it, expect } from 'vitest';
import { matchesOrigin, parseOriginPatterns } from './origin-patterns';

describe('parseOriginPatterns', () => {
  it.each([
    'https://app.example.com',
    'https://app.example.com:8443',
    'https://app.example.com:*',
    'http://localhost:*',
    'HTTPS://App.Example.COM',
  ])('accepts %s', (entry) => {
    expect(parseOriginPatterns(entry)).toHaveLength(1);
  });

  it('normalizes scheme and host to lowercase', () => {
    expect(parseOriginPatterns('HTTPS://App.Example.COM')).toEqual([
      { protocol: 'https:', hostname: 'app.example.com', port: '' },
    ]);
  });

  it('ignores surrounding whitespace and empty items', () => {
    expect(parseOriginPatterns(' https://a.example.com , ,https://b.example.com ')).toHaveLength(2);
  });

  it('reads an empty string as no patterns', () => {
    expect(parseOriginPatterns('')).toEqual([]);
  });

  it.each([
    '*',
    'https://*.example.com',
    'https://app.*.com',
    'https://app.example.com/',
    'https://app.example.com/path',
    'https://app.example.com?q=1',
    'https://app.example.com#frag',
    'https://user@app.example.com',
    'https://user:pw@app.example.com',
    'null',
    'ftp://app.example.com',
    'app.example.com',
    'https://app.example.com:*:*',
    'https://app.example.com:abc',
    'https://',
  ])('rejects %s and names it', (entry) => {
    expect(() => parseOriginPatterns(`https://ok.example.com,${entry}`)).toThrow(`"${entry}"`);
  });

  it.each(['https://app.example.com:443:*', 'https://app.example.com:8443:*'])(
    'rejects a port together with the wildcard: %s',
    (entry) => {
      expect(() => parseOriginPatterns(entry)).toThrow(`"${entry}"`);
    },
  );

  it('reads an explicit default port as none', () => {
    expect(parseOriginPatterns('https://app.example.com:443')).toEqual(
      parseOriginPatterns('https://app.example.com'),
    );
  });

  // Edge cases each component refuses the same way: a percent-encoded host
  // (`%2A` decodes to `*`), a trailing-dot host, port 0 and an empty port.
  it.each([
    'https://%2A.example.com',
    'https://app.example.com.',
    'https://app.example.com.:*',
    'https://app.example.com:0',
    'https://app.example.com:',
    'https://app.example.com::*',
  ])('rejects %s and names it', (entry) => {
    expect(() => parseOriginPatterns(entry)).toThrow(`"${entry}"`);
  });

  it('accepts any port of an IPv6 loopback literal', () => {
    expect(parseOriginPatterns('http://[::1]:*')).toEqual([
      { protocol: 'http:', hostname: '[::1]', port: '*' },
    ]);
  });
});

describe('matchesOrigin', () => {
  const patterns = parseOriginPatterns('https://app.example.com, https://any.example.com:*');

  it.each([
    ['https://app.example.com', true],
    ['https://app.example.com:443', true],
    ['https://app.example.com:8443', false],
    ['http://app.example.com', false],
    ['https://APP.Example.COM', true],
    ['https://evil.app.example.com', false],
    ['https://app.example.com.evil.com', false],
    ['https://any.example.com', true],
    ['https://any.example.com:443', true],
    ['https://any.example.com:53224', true],
    ['http://any.example.com:53224', false],
    ['https://sub.any.example.com:1', false],
    ['null', false],
    ['not a url', false],
    ['', false],
    [undefined, false],
  ] as const)('%s matches: %s', (origin, expected) => {
    expect(matchesOrigin(patterns, origin)).toBe(expected);
  });

  it('matches nothing with an empty list', () => {
    expect(matchesOrigin([], 'https://app.example.com')).toBe(false);
  });

  it.each([
    'https:app.example.com',
    'https://app.example.com/path',
    'https://app.example.com?q=1',
    'https://user@app.example.com',
  ])('never matches %s', (origin) => {
    expect(matchesOrigin(patterns, origin)).toBe(false);
  });

  it('tolerates a single trailing slash', () => {
    expect(matchesOrigin(patterns, 'https://app.example.com/')).toBe(true);
    expect(matchesOrigin(patterns, 'https://app.example.com//')).toBe(false);
  });
});
