import { describe, expect, it } from 'vitest';
import { BEARER_SUBPROTOCOL_PREFIX, CHAT_SUBPROTOCOL, bearerSubprotocol, ingressProtocols } from './ingress.js';

describe('bearerSubprotocol', () => {
  // The ingress decodes with Node's base64url, so the browser encoding has to match it.
  it.each([
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2lnbmF0dXJl',
    'a token that needs padding?',
    'ünïcödé ✓',
  ])('encodes %j as the ingress decodes it', (token) => {
    expect(bearerSubprotocol(token)).toBe(BEARER_SUBPROTOCOL_PREFIX + Buffer.from(token, 'utf8').toString('base64url'));
  });

  it('is a valid subprotocol token, with no padding or base64 punctuation', () => {
    expect(bearerSubprotocol('a token that needs padding?').slice(BEARER_SUBPROTOCOL_PREFIX.length)).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
  });
});

describe('ingressProtocols', () => {
  it('offers the chat protocol first, so the runtime answers with it', () => {
    expect(ingressProtocols('t')).toEqual([CHAT_SUBPROTOCOL, bearerSubprotocol('t')]);
  });
});
