/**
 * A Bolt receiver that opens no connection. In routed mode the adapter hands
 * it each event the router delivered. A post-only app has one too, because
 * Bolt needs a receiver, and nothing is ever handed to it.
 */

import type { App, Receiver } from '@slack/bolt';

export class HandedEventReceiver implements Receiver {
  private app?: App;

  init(app: App): void {
    this.app = app;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  /** Run `body` through the app's listeners. Resolves when they have finished. */
  async dispatch(body: Record<string, unknown>, customProperties: Record<string, unknown>): Promise<void> {
    await this.app?.processEvent({ body, customProperties, ack: async () => {} });
  }
}
