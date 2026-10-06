import { PROTOCOL_VERSION } from './protocol.js';

/**
 * A page on another origin reaches the agent through the Lens Agents sandbox ingress. The
 * ingress reads the bearer from `Sec-WebSocket-Protocol`, because a browser WebSocket has
 * no `Authorization` header, and removes it before the socket arrives at the runtime. The
 * client also offers the chat protocol, since a browser fails a handshake that offered
 * protocols and received none. The runtime answers with the first protocol offered.
 */

/** The protocol a client offers beside its bearer. */
export const CHAT_SUBPROTOCOL = `prism.chat.v${PROTOCOL_VERSION}`;

/** The prefix the ingress recognizes a bearer by. */
export const BEARER_SUBPROTOCOL_PREFIX = 'base64url.bearer.authorization.agents.lenshq.io.';

/** The bearer as the ingress reads it: its UTF-8 bytes in unpadded base64url. */
export function bearerSubprotocol(token: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(token)) binary += String.fromCharCode(byte);
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return BEARER_SUBPROTOCOL_PREFIX + base64url;
}

/** The subprotocols for a socket through the ingress: the chat protocol, then the bearer. */
export function ingressProtocols(token: string): string[] {
  return [CHAT_SUBPROTOCOL, bearerSubprotocol(token)];
}
