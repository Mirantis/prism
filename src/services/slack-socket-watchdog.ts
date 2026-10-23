/**
 * Notices a Slack Socket Mode client that stays disconnected.
 *
 * After a socket drop the client asks Slack for a new socket address with
 * `apps.connections.open`. The client can wait on that request for hours, and
 * it emits nothing while it waits. A new socket can also open and then wait for
 * Slack's `hello` for ever. The adapter rebuilds the app when this watch fires.
 */

/**
 * How long a client may stay without `connected` before the adapter rebuilds it.
 * A normal start or reconnect reports `connected` within seconds.
 */
export const SOCKET_STALL_MS = 3 * 60_000;

/** The lifecycle events of a Socket Mode client that the watch reads. */
interface SocketEvents {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/**
 * Calls `onStall` once when `client` has not reported `connected` for
 * `SOCKET_STALL_MS`. The window starts now, since a new client is not connected,
 * and again at the first `reconnecting` or `disconnected` after a `connected`.
 * Returns the function that stops the watch.
 */
export function watchSocket(client: SocketEvents, onStall: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;

  const disarm = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const stop = (): void => {
    disarm();
    client.off('connected', disarm);
    client.off('reconnecting', arm);
    client.off('disconnected', arm);
  };
  function arm(): void {
    timer ??= setTimeout(() => {
      stop();
      onStall();
    }, SOCKET_STALL_MS).unref();
  }

  client.on('connected', disarm);
  client.on('reconnecting', arm);
  client.on('disconnected', arm);
  arm();
  return stop;
}
