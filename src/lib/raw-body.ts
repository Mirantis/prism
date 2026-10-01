/**
 * Raw Body Capture
 *
 * HMAC verification of inbound webhooks (lib/webhook-signature.ts) has to hash
 * the exact bytes the sender signed — re-serializing the parsed JSON would
 * change whitespace and key order and never match. `express.json()` discards
 * the buffer once it has parsed it, so we stash it via the parser's `verify`
 * hook.
 */

import type { Request } from 'express';
import type { IncomingMessage } from 'http';

/** A request whose raw body was captured by {@link captureRawBody}. */
export interface RawBodyRequest {
  rawBody?: Buffer;
}

/** `express.json({ verify })` hook: keep the raw buffer on the request. */
export function captureRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  (req as IncomingMessage & RawBodyRequest).rawBody = buf;
}

/**
 * The captured raw body, or undefined when nothing was captured (non-JSON
 * content type or empty body). Callers that need it for verification must
 * treat undefined as "cannot verify".
 */
export function getRawBody(req: Request): Buffer | undefined {
  return (req as Request & RawBodyRequest).rawBody;
}
