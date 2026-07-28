/**
 * Raw Body Capture
 *
 * HMAC verification of inbound webhooks (lib/webhook-signature.ts) has to hash
 * the exact bytes the sender signed — re-serializing the parsed JSON would
 * change whitespace and key order and never match. `express.json()` discards
 * the buffer once it has parsed it, so we stash it via the parser's `verify`
 * hook.
 *
 * Capture is scoped to the webhook ingestion path: chat bodies can be 5 MB and
 * nobody verifies those, so there's no reason to keep a second reference to
 * them alive for the duration of the request.
 */

import type { Request } from 'express';
import type { IncomingMessage } from 'http';

/** Prefix of the only route that needs the raw bytes (routes/webhook.ts). */
export const WEBHOOK_PATH_PREFIX = '/agents/webhooks/';

/** A request whose raw body was captured by {@link captureWebhookRawBody}. */
export interface RawBodyRequest {
  rawBody?: Buffer;
}

/**
 * `express.json({ verify })` hook: keep the raw buffer for webhook ingestion
 * requests. Mounted app-level, so `req.url` is the full path.
 */
export function captureWebhookRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  if (req.url?.startsWith(WEBHOOK_PATH_PREFIX)) {
    (req as IncomingMessage & RawBodyRequest).rawBody = buf;
  }
}

/**
 * The captured raw body, or undefined when nothing was captured (non-JSON
 * content type, empty body, or a path outside the webhook prefix). Callers
 * that need it for verification must treat undefined as "cannot verify".
 */
export function getRawBody(req: Request): Buffer | undefined {
  return (req as Request & RawBodyRequest).rawBody;
}
