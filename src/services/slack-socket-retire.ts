/**
 * Retires a Slack Socket Mode app for good, so its client opens no socket again.
 *
 * `disconnect()` closes the client's socket. A reconnect that already started
 * keeps retrying `apps.connections.open`, and it opens a socket when Slack
 * answers. The client's requests go through `retirableFetch`, so a retired
 * client gets no answer and its reconnect waits for ever.
 */

import type { FetchFunction } from '@slack/web-api';

/** A fetch for one Socket Mode client, and the switch that retires it. */
export interface RetirableFetch {
  fetch: FetchFunction;
  retire(): void;
}

export function retirableFetch(fetch: FetchFunction): RetirableFetch {
  let retired = false;
  const never = new Promise<never>(() => {});
  return {
    fetch: async (url, init) => {
      if (retired) return never;
      try {
        const response = await fetch(url, init);
        return retired ? never : response;
      } catch (error) {
        if (retired) return never;
        throw error;
      }
    },
    retire: () => {
      retired = true;
    },
  };
}

/** The part of a Socket Mode client that retiring it touches. */
interface RetiringClient {
  removeAllListeners(event: string): unknown;
}

/**
 * Retires the client's requests, then stops `app`. A reconnect of the SDK runs
 * `start()`, which waits for Slack's hello and rejects, with no handler, when
 * the client reports `disconnected`. That rejection ends the process, and a
 * stopped client reports `disconnected`, so the listener goes before the stop.
 */
export async function retireSocketApp(
  app: { stop(): Promise<unknown> },
  client: RetiringClient,
  retire: () => void,
): Promise<void> {
  retire();
  client.removeAllListeners('disconnected');
  await app.stop();
}
