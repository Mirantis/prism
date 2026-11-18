/**
 * GHCR version check tests: release-tag parsing/compare and the anonymous
 * token + paginated tags/list flow, including the silence contract — a
 * failed check returns null and never logs above debug.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../logger', () => ({ logger: mockLogger }));

import { compareReleaseVersions, fetchLatestReleaseVersion, parseReleaseVersion } from '../ghcr';

describe('parseReleaseVersion', () => {
  it('parses a release tag into numeric segments', () => {
    expect(parseReleaseVersion('v2026.8.24083158')).toEqual([2026, 8, 24083158]);
  });

  it('rejects anything not release-shaped', () => {
    for (const tag of ['dev', '0.1.0', 'v2026.8', 'canary', 'latest', 'v2026.08.1x', '1aa19077']) {
      expect(parseReleaseVersion(tag)).toBeNull();
    }
  });
});

describe('compareReleaseVersions', () => {
  it('compares day+time numerically within a month (day 5 vs day 24)', () => {
    expect(compareReleaseVersions('v2026.8.5090000', 'v2026.8.24083158')).toBeLessThan(0);
  });

  it('orders across month and year rollovers', () => {
    expect(compareReleaseVersions('v2026.9.1000000', 'v2026.8.31235959')).toBeGreaterThan(0);
    expect(compareReleaseVersions('v2027.1.1000000', 'v2026.12.31235959')).toBeGreaterThan(0);
  });

  it('returns 0 for equal tags', () => {
    expect(compareReleaseVersions('v2026.8.24083158', 'v2026.8.24083158')).toBe(0);
  });

  it('throws on non-release input', () => {
    expect(() => compareReleaseVersions('dev', 'v2026.8.24083158')).toThrow();
  });
});

describe('fetchLatestReleaseVersion', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, init: { status?: number; link?: string } = {}): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: init.link ? { link: init.link } : {},
    });
  }

  it('picks the highest release tag across pages, ignoring SHA/latest/canary tags', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'tok' }))
      .mockResolvedValueOnce(
        jsonResponse(
          { tags: ['latest', 'canary', '1aa190771c3698cf', 'v2026.5.26071530', 'v2026.8.5090000'] },
          { link: '</v2/mirantis/prism/tags/list?n=100&last=x>; rel="next"' },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ tags: ['v2026.8.24083158', 'pr-12-foo'] }));

    await expect(fetchLatestReleaseVersion()).resolves.toBe('v2026.8.24083158');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const tokenUrl = String(fetchMock.mock.calls[0]![0]);
    expect(tokenUrl).toContain('ghcr.io/token');
    expect(tokenUrl).toContain('repository:mirantis/prism:pull');
    const page2 = String(fetchMock.mock.calls[2]![0]);
    expect(page2).toBe('https://ghcr.io/v2/mirantis/prism/tags/list?n=100&last=x');
  });

  it.each([
    ['token request fails', [jsonResponse({}, { status: 500 })]],
    ['token response has no token', [jsonResponse({})]],
    ['tags list fails', [jsonResponse({ token: 'tok' }), jsonResponse({}, { status: 401 })]],
  ])('returns null when the %s', async (_name, responses) => {
    for (const res of responses) fetchMock.mockResolvedValueOnce(res);
    await expect(fetchLatestReleaseVersion()).resolves.toBeNull();
  });

  it('returns null when no release-shaped tag exists', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse({ tags: ['latest', 'canary'] }));
    await expect(fetchLatestReleaseVersion()).resolves.toBeNull();
  });

  it('logs a network failure at debug only', async () => {
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND ghcr.io'));
    await expect(fetchLatestReleaseVersion()).resolves.toBeNull();
    expect(mockLogger.debug).toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
