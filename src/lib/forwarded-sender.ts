/** Who a request names as its sender, from the headers the Lens Agents ingress writes. */

import type { IncomingMessage } from 'node:http';

/** The most code points kept from each ingress header value. */
const MAX_SENDER_CHARS = 128;

/**
 * The headers the Lens Agents ingress names the signed-in caller in. It strips any
 * copy a client sent, and omits the id and the display name when it has none.
 */
const FORWARDED_USER_HEADER = 'x-forwarded-user';
const FORWARDED_USER_ID_HEADER = 'x-forwarded-user-id';
const FORWARDED_USER_DISPLAY_NAME_HEADER = 'x-forwarded-user-display-name';

/** One header value, or undefined when the header is absent. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** A header value made safe to show: no angle brackets, colons or control characters, and capped. */
function cleanSender(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[<>:\x00-\x1f\x7f]/g, '').trim();
  return Array.from(cleaned).slice(0, MAX_SENDER_CHARS).join('') || undefined;
}

/** The display name header, which the ingress always percent-encodes. */
function decodedDisplayName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return cleanSender(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

/**
 * Who is on this connection, from the ingress's headers. The id is the signed-in
 * person's user id. The name is their display name. Each falls back to
 * `x-forwarded-user`, the person's email or user id, when the ingress omits it.
 *
 * **Attribution and display only.** The ingress writes the headers for a private
 * port after it signed the caller in, and strips any copy a client sent. A
 * runtime reached some other way — local development, or bound wider on purpose
 * — would read whatever a client wrote, so nothing is ever decided on them.
 */
export function senderOf(req: IncomingMessage): { id: string; name: string } | null {
  const legacy = cleanSender(headerOf(req, FORWARDED_USER_HEADER));
  const id = cleanSender(headerOf(req, FORWARDED_USER_ID_HEADER)) ?? legacy;
  if (!id) return null;
  const name = decodedDisplayName(headerOf(req, FORWARDED_USER_DISPLAY_NAME_HEADER)) ?? legacy ?? id;
  return { id, name };
}
