/**
 * Version check against the GHCR container registry.
 *
 * The registry's tag list is the single source of "what is the latest
 * release" for every install shape: release-production.yml pushes the
 * release tag (vYYYY.M.DDHHMMSS) and `latest` in one atomic
 * `imagetools create` call, and version-shaped tags come only from that
 * workflow — so the highest release tag is what `latest` points to. Reading
 * the tag list needs no auth (an anonymous registry token) and no manifest
 * fetches.
 *
 * Every failure here returns null and logs at debug only: an update check
 * that cannot run is a non-event, never a user-visible error.
 */

import { logger } from '../../logger';
import { RELEASE_VERSION_RE, UPDATE_GITHUB_REPO } from '../../constants';

const REGISTRY = 'https://ghcr.io';
const FETCH_TIMEOUT_MS = 10_000;
/** Pagination backstop — far above the real tag count. */
const MAX_TAG_PAGES = 50;

/**
 * Parse a release tag (vYYYY.M.DDHHMMSS) into its numeric segments.
 * The third segment concatenates the unpadded day with a zero-padded HHMMSS,
 * so it is monotonic within a month and numeric compare is correct.
 */
export function parseReleaseVersion(tag: string): [number, number, number] | null {
  if (!RELEASE_VERSION_RE.test(tag)) return null;
  const [year, month, rest] = tag.slice(1).split('.');
  return [Number(year), Number(month), Number(rest)];
}

/** Numeric per-segment compare of two release tags: negative, zero, positive. */
export function compareReleaseVersions(a: string, b: string): number {
  const pa = parseReleaseVersion(a);
  const pb = parseReleaseVersion(b);
  if (!pa || !pb) throw new Error(`not release versions: ${a}, ${b}`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

interface TagsPage {
  tags?: unknown;
}

/**
 * The newest release version published to GHCR, or null when the check
 * cannot complete. Anonymous: fetches a pull-scoped registry token, then
 * pages through /v2/<repo>/tags/list following Link headers.
 */
export async function fetchLatestReleaseVersion(): Promise<string | null> {
  try {
    const tokenRes = await fetch(
      `${REGISTRY}/token?service=ghcr.io&scope=repository:${UPDATE_GITHUB_REPO}:pull`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!tokenRes.ok) {
      logger.debug(`[Update] GHCR token request failed: ${tokenRes.status}`);
      return null;
    }
    const token = ((await tokenRes.json()) as { token?: unknown }).token;
    if (typeof token !== 'string' || token.length === 0) {
      logger.debug('[Update] GHCR token response had no token');
      return null;
    }

    let latest: string | null = null;
    let url: string | null = `${REGISTRY}/v2/${UPDATE_GITHUB_REPO}/tags/list?n=100`;
    for (let page = 0; url && page < MAX_TAG_PAGES; page++) {
      const res: Response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.debug(`[Update] GHCR tags list failed: ${res.status}`);
        return null;
      }
      const body = (await res.json()) as TagsPage;
      const tags = Array.isArray(body.tags) ? body.tags : [];
      for (const tag of tags) {
        if (typeof tag !== 'string' || !RELEASE_VERSION_RE.test(tag)) continue;
        if (latest === null || compareReleaseVersions(tag, latest) > 0) latest = tag;
      }
      url = nextPageUrl(res.headers.get('link'));
    }
    return latest;
  } catch (error: unknown) {
    logger.debug(`[Update] check failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Resolve the RFC 5988 `Link: <...>; rel="next"` header against the registry
 * host. An absolute URL resolves as-is, so the host is pinned: a header naming
 * somewhere else would otherwise send the bearer token there on the next
 * request. It is only an anonymous pull token, and the header arrives from
 * ghcr.io over TLS, but the check is one line.
 */
function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>\s*;\s*rel="next"/);
  if (!match) return null;
  const next = new URL(match[1], REGISTRY);
  if (next.origin !== new URL(REGISTRY).origin) {
    logger.debug(`[Update] ignoring a next-page link off the registry host: ${next.origin}`);
    return null;
  }
  return next.toString();
}
