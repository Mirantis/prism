/**
 * Origin patterns: the syntax of a configured list of browser origins.
 *
 * The list is comma-separated, and each entry takes one of two forms:
 *
 * - `scheme://host[:port]` names one origin. The port is compared after URL
 *   normalization, so `https://h` and `https://h:443` are the same entry.
 * - `scheme://host:*` names every port of that host, the scheme's default port
 *   included, because a browser leaves the default port out of `Origin`.
 *
 * The scheme is `http` or `https`, and scheme and host compare
 * case-insensitively. A `*` anywhere other than the port, a path, a query, a
 * fragment and userinfo make the entry invalid, and the parser throws with the
 * entry named, so a typo stops startup.
 */

export interface OriginPattern {
  /** `http:` or `https:`. */
  readonly protocol: string;
  /** Lowercase, as the URL parser gives it; an IPv6 literal keeps its brackets. */
  readonly hostname: string;
  /** The normalized port (`''` for the scheme's default), or `*` for any port. */
  readonly port: string;
}

const ANY_PORT = ':*';

// `http://` or `https://` and an authority, with nothing after it. The raw text
// is checked first: the URL parser accepts `*` in a hostname, drops a trailing
// `/` or an empty `?`, repairs `https:host`, and decodes `%2A` into a hostname.
const BARE_ORIGIN = /^https?:\/\/[^/?#@\\\s*%]+$/i;

// An `Origin` header value: the same shape, with one trailing `/` tolerated.
const ORIGIN_HEADER = /^https?:\/\/[^/?#@\\\s%]+\/?$/i;

// A port on the authority. The brackets of an IPv6 literal hold colons too.
const EXPLICIT_PORT = /:[^:\]]*$/;

function parseEntry(entry: string): OriginPattern {
  const invalid = () =>
    new Error(
      `Invalid origin pattern "${entry}": expected scheme://host[:port] or scheme://host:* with scheme http or https`,
    );

  const anyPort = entry.endsWith(ANY_PORT);
  const bare = anyPort ? entry.slice(0, -ANY_PORT.length) : entry;
  if (!BARE_ORIGIN.test(bare)) throw invalid();
  // A port and the wildcard together, the scheme's default port included.
  if (anyPort && EXPLICIT_PORT.test(bare.slice(bare.indexOf('//') + 2))) throw invalid();
  // An empty port.
  if (bare.endsWith(':')) throw invalid();

  let url: URL;
  try {
    url = new URL(bare);
  } catch {
    throw invalid();
  }
  // A trailing-dot host and port 0 can never match an `Origin` a browser sends,
  // so either is a typo.
  if (url.hostname.endsWith('.') || url.port === '0') throw invalid();
  return { protocol: url.protocol, hostname: url.hostname, port: anyPort ? '*' : url.port };
}

/** Parses a comma-separated list. Blank items are skipped; an empty list matches nothing. */
export function parseOriginPatterns(csv: string): OriginPattern[] {
  return csv
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map(parseEntry);
}

/**
 * Whether the request's `Origin` header names an origin the list admits. A match
 * needs `http://` or `https://` and a host the URL parser reads, with at most a
 * trailing `/` after it, so the literal `null`, a path, a query and userinfo
 * never match.
 */
export function matchesOrigin(patterns: readonly OriginPattern[], origin: string | undefined): boolean {
  if (!origin || patterns.length === 0) return false;

  if (!ORIGIN_HEADER.test(origin)) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  return patterns.some(
    (pattern) =>
      pattern.protocol === parsed.protocol &&
      pattern.hostname === parsed.hostname &&
      (pattern.port === '*' || pattern.port === parsed.port),
  );
}
