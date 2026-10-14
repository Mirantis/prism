/**
 * web_fetch: read a public web page as text.
 *
 * One GET from the runtime process, with no JavaScript, no cookies and no sign-in.
 * HTML becomes markdown (`lib/html-to-markdown.ts`); markdown, plain text, JSON and
 * XML are returned as they are. The result is plain text, so the generic tool-output
 * limit cuts a long result and saves all of it for the shell to read. A body over
 * `MAX_BODY_BYTES` is cut first, and the result says so.
 *
 * Every host, the first and each redirect target, goes through `lib/public-url.ts`.
 * A failed read names the next step, which for a page that needs a sign-in or
 * JavaScript is the browser.
 */

import { tool, type Tool } from 'ai';
import { request, type Dispatcher } from 'undici';
import { z } from 'zod';
import { config } from '../../config';
import { htmlToMarkdown } from '../../lib/html-to-markdown';
import { assertPublicLiteral, getPublicDispatcher, type PrivateAddressError } from '../../lib/public-url';
import { trackEvent } from '../../lib/telemetry';

export const WEB_FETCH_TOOL_NAME = 'web_fetch';

export const WEB_FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_MB = 5;
export const MAX_BODY_BYTES = MAX_BODY_MB * 1024 * 1024;
export const MAX_REDIRECTS = 5;

/**
 * Fewer visible characters than this, on a page that loads scripts, may be all the
 * page shows before its scripts run, so the read adds a hint to open the browser.
 */
const MIN_TEXT_CHARS = 100;

const ACCEPT = 'text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.8, */*;q=0.1';
const USER_AGENT = `Mozilla/5.0 (compatible; Prism-Agent${config.appVersion ? `/${config.appVersion}` : ''})`;

const SOURCE_NOTE = 'The text below comes from this page, not from your user.';

export const webFetchInput = z.object({
  url: z.string().describe('The http or https address of the page.'),
});

type Outcome =
  | 'ok'
  | 'invalid_url'
  | 'blocked_address'
  | 'http_error'
  | 'redirect_limit'
  | 'timeout'
  | 'unsupported_type'
  | 'no_text'
  | 'network_error'
  | 'cancelled';

type ContentKind = 'html' | 'markdown' | 'text' | 'json' | 'xml' | 'other';

/** One read: the text for the model, and what telemetry records about it. */
interface Read {
  outcome: Outcome;
  text: string;
  httpStatus?: number;
  contentKind?: ContentKind;
  extractor?: 'readability' | 'whole_page';
  redirects: number;
  bytes: number;
  capped: boolean;
}

export interface WebFetchDeps {
  /** The turn's signal, so a cancelled turn stops the read. */
  abortSignal?: AbortSignal;
  /** Overridable for tests, which serve pages from a loopback address. */
  assertHost?: (hostname: string) => void;
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

/**
 * Read one page and record the outcome, one event per call. Never throws, except
 * for a cancelled turn, which is recorded as `cancelled` first.
 */
export async function runWebFetch(
  input: z.infer<typeof webFetchInput>,
  userId: string,
  agentId: string,
  deps: WebFetchDeps = {},
): Promise<string> {
  const startedAt = Date.now();
  let read: Read;
  try {
    read = await readPage(input.url, deps);
  } catch (err) {
    record(userId, agentId, { outcome: 'cancelled', text: '', redirects: 0, bytes: 0, capped: false }, startedAt);
    throw err;
  }
  record(userId, agentId, read, startedAt);
  return read.text;
}

function record(userId: string, agentId: string, read: Read, startedAt: number): void {
  trackEvent('web page fetched', userId, {
    'agent.id': agentId,
    'fetch.outcome': read.outcome,
    ...(read.httpStatus ? { 'fetch.http_status': String(read.httpStatus) } : {}),
    ...(read.contentKind ? { 'fetch.content_kind': read.contentKind } : {}),
    ...(read.extractor ? { 'fetch.extractor': read.extractor } : {}),
    'fetch.redirects': String(read.redirects),
    'fetch.bytes': String(read.bytes),
    'fetch.capped': String(read.capped),
    'fetch.duration_ms': String(Date.now() - startedAt),
  });
}

async function readPage(address: string, deps: WebFetchDeps): Promise<Read> {
  const read: Read = { outcome: 'ok', text: '', redirects: 0, bytes: 0, capped: false };
  const fail = (outcome: Outcome, text: string): Read => ({ ...read, outcome, text });

  if (!URL.canParse(address)) {
    return fail('invalid_url', `${address} is not a web address. Give an http or https address.`);
  }
  let url = new URL(address);

  const timeout = AbortSignal.timeout(deps.timeoutMs ?? WEB_FETCH_TIMEOUT_MS);
  const signal = deps.abortSignal ? AbortSignal.any([timeout, deps.abortSignal]) : timeout;
  const assertHost = deps.assertHost ?? assertPublicLiteral;
  // Direct even when HTTPS_PROXY is set: a proxy would resolve the name itself, and
  // only a connection that resolves it with `publicLookup` reaches a checked address.
  // That lookup runs under the request's signal. The read sends no credential for a
  // proxy to rewrite.
  const dispatcher = deps.dispatcher ?? getPublicDispatcher();

  try {
    for (;;) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        const scheme = url.protocol.slice(0, -1);
        return fail('invalid_url', `web_fetch reads http and https addresses, and ${url.href} is ${scheme}.`);
      }
      assertHost(url.hostname);
      const response = await request(url, {
        method: 'GET',
        // `request` decompresses nothing, and with no Accept-Encoding a server may
        // choose any coding, so the read asks for the body as it is.
        headers: { accept: ACCEPT, 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
        dispatcher,
        signal,
      });
      read.httpStatus = response.statusCode;

      const location = header(response.headers, 'location');
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        discard(response.body);
        if (read.redirects === MAX_REDIRECTS) {
          return fail('redirect_limit', `${address} redirected more than ${MAX_REDIRECTS} times, so web_fetch stopped.`);
        }
        read.redirects++;
        read.httpStatus = undefined;
        url = new URL(location, url);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        discard(response.body);
        return fail('http_error', httpErrorText(url, response.statusCode, response.headers));
      }

      const contentType = header(response.headers, 'content-type') ?? '';
      read.contentKind = contentKind(contentType);
      if (read.contentKind === 'other') {
        discard(response.body);
        const type = contentType.split(';')[0] || 'a file with no content type';
        return fail(
          'unsupported_type',
          `web_fetch reads text pages, and ${url.href} is ${type}. Download it with the shell instead.`,
        );
      }

      const body = await readBody(response.body);
      read.bytes = body.bytes.length;
      read.capped = body.capped;
      return { ...read, ...render(url.href, contentType, read.contentKind, body) };
    }
  } catch (err) {
    if (deps.abortSignal?.aborted) throw err;
    if (timeout.aborted) {
      const seconds = (deps.timeoutMs ?? WEB_FETCH_TIMEOUT_MS) / 1000;
      return fail('timeout', `${url.href} did not answer within ${seconds} seconds.`);
    }
    return failure(err, url, fail);
  }
}

/**
 * The page as text for the model. The runtime's own lines come first, then the source
 * note, then everything the page controls, its title included.
 */
function render(
  pageUrl: string,
  contentType: string,
  kind: ContentKind,
  body: { bytes: Buffer; capped: boolean },
): Pick<Read, 'outcome' | 'text' | 'extractor'> {
  const text = decode(body.bytes, contentType, kind);
  const capped = body.capped
    ? [`The page is larger than ${MAX_BODY_MB} MB, so this is the text of its first ${MAX_BODY_MB} MB.`]
    : [];
  if (kind !== 'html') {
    return { outcome: 'ok', text: [pageUrl, ...capped, SOURCE_NOTE, '', text].join('\n') };
  }

  const page = htmlToMarkdown(text, pageUrl);
  if (!page.markdown.trim()) {
    return {
      outcome: 'no_text',
      extractor: page.extractor,
      text: `${pageUrl} shows no text without JavaScript. Open it in the browser.`,
    };
  }
  const titleLine = page.title ? [`Title: ${page.title}`] : [];
  const scriptHint =
    page.markdown.replace(/\s/g, '').length < MIN_TEXT_CHARS && /<script\b/i.test(text)
      ? ['The page shows little text without JavaScript. If what you need is missing, open it in the browser.']
      : [];
  return {
    outcome: 'ok',
    extractor: page.extractor,
    text: [pageUrl, ...capped, ...scriptHint, SOURCE_NOTE, ...titleLine, '', page.markdown].join('\n'),
  };
}

function httpErrorText(url: URL, status: number, headers: Record<string, unknown>): string {
  if (status === 401 || status === 403 || status === 429 || header(headers, 'cf-mitigated') === 'challenge') {
    return (
      `${url.host} refused the request (HTTP ${status}). The page may need a sign-in, or the site ` +
      'blocks automated readers. Open it in the browser.'
    );
  }
  if (status === 404 || status === 410) return `${url.href} does not exist (HTTP ${status}).`;
  return `${url.host} answered HTTP ${status} for ${url.href}.`;
}

/** The text for an error thrown by the address check, the resolver or the connection. */
function failure(err: unknown, url: URL, fail: (outcome: Outcome, text: string) => Read): Read {
  const code = (err as { code?: string }).code;
  if (code === 'EPRIVATEADDRESS') {
    const { hostname, address } = err as PrivateAddressError;
    const subject = hostname === address ? address : `${hostname} resolves to ${address}, which`;
    return fail(
      'blocked_address',
      `web_fetch reads public addresses only, and ${subject} is not public. ` +
        'Use the browser or the shell for a page on a private network.',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return fail('network_error', `${url.hostname} does not resolve to an address.`);
  }
  const reason = err instanceof Error ? err.message : String(err);
  return fail('network_error', `web_fetch could not read ${url.href}: ${reason}`);
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? String(value[0]) : typeof value === 'string' ? value : undefined;
}

function contentKind(contentType: string): ContentKind {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml')) return 'xml';
  if (type.startsWith('text/')) return 'text';
  return 'other';
}

/** Up to `MAX_BODY_BYTES` of the body. A larger body is cut there, and `capped` says so. */
async function readBody(body: Dispatcher.ResponseData['body']): Promise<{ bytes: Buffer; capped: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const remaining = MAX_BODY_BYTES - size;
    if (chunk.length > remaining) {
      chunks.push(chunk.subarray(0, remaining));
      discard(body);
      return { bytes: Buffer.concat(chunks), capped: true };
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { bytes: Buffer.concat(chunks), capped: false };
}

/**
 * Close a body the read does not use. Draining it instead would let a server that
 * streams it slowly hold the read until the timeout. The body reports its own
 * destruction as an abort error, which nothing here needs.
 */
function discard(body: Dispatcher.ResponseData['body']): void {
  body.on('error', () => {}).destroy();
}

/** The encoding a byte order mark names. As in a browser, it outranks every declared charset. */
function bomEncoding(bytes: Buffer): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return undefined;
}

/**
 * The charset a document names in its first 1024 bytes: the encoding of an XML
 * declaration, which XHTML and RSS use, else an HTML page's meta charset.
 */
function documentCharset(bytes: Buffer, kind: ContentKind): string | undefined {
  if (kind !== 'html' && kind !== 'xml') return undefined;
  const head = bytes.subarray(0, 1024).toString('latin1');
  const declared = /^<\?xml\b[^>]*\bencoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1];
  if (declared || kind === 'xml') return declared;
  // A comment can hold a meta tag, and `charset` counts only as its own name, not as
  // the end of another one such as `data-charset`.
  const markup = head.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  return /<meta\b[^>]*?[\s;"']charset\s*=\s*["']?([\w.:-]+)/i.exec(markup)?.[1];
}

/**
 * The body as text, in the encoding its byte order mark names, else the charset the
 * `Content-Type` names, else the one the document declares, else UTF-8.
 */
function decode(bytes: Buffer, contentType: string, kind: ContentKind): string {
  const encoding =
    bomEncoding(bytes) ?? /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? documentCharset(bytes, kind);
  try {
    return new TextDecoder(encoding ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function getWebFetchTools(userId: string, agentId: string): Record<string, Tool> {
  return {
    [WEB_FETCH_TOOL_NAME]: tool({
      description:
        'Read a public web page as text: its main text as markdown, with its title and final address. ' +
        'Use it to read a page instead of opening it in the browser. It runs no JavaScript and sends no ' +
        'sign-in, so open a page that needs either in the browser.',
      inputSchema: webFetchInput,
      execute: async (input, { abortSignal }) => runWebFetch(input, userId, agentId, { abortSignal }),
    }),
  };
}
