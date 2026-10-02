import { createRuntimeClient } from '@lensapp/prism-client';

/** The runtime that serves this page. */
export const runtimeApi = createRuntimeClient();

/** URL to download/preview a stored attachment by id. */
export function attachmentUrl(id: string): string {
  return `/agents/attachments/${id}`;
}

export function webSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/ws`;
}

/**
 * The computer socket: the agent's screen and the sound of its desktop out, the user's
 * pointer, keyboard and shared screen in.
 *
 * The call itself is on the chat socket. This one is opened once that call is live, and
 * carries only the computer, so a burst of video cannot put a chat message behind it.
 */
export const COMPUTER_SOCKET_PATH = '/api/computer';

export function computerWebSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${COMPUTER_SOCKET_PATH}`;
}
