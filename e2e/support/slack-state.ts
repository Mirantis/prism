/**
 * Shared mutable state for @slack-tagged step files.
 *
 * Several step files (slack-channel, slack-heartbeat) reuse the same
 * Before/After hook and the Given steps that create a channel, invite the
 * bot, and link it to the agent. Those Givens populate the client/channel
 * variables consumed by subsequent steps. Keeping the state here lets the
 * heartbeat steps read what slack-channel's Givens produced without
 * registering the hook twice.
 *
 * Safe to use as module-level singletons because workers: 1.
 */

import type { WebClient } from '@slack/web-api';

interface SlackState {
  userClient: WebClient | null;
  botUserId: string;
  channelId: string;
  channelName: string;
  messageTs: string;
}

const state: SlackState = {
  userClient: null,
  botUserId: '',
  channelId: '',
  channelName: '',
  messageTs: '',
};

export function getSlackState(): SlackState {
  return state;
}

export function resetSlackState(): void {
  state.userClient = null;
  state.botUserId = '';
  state.channelId = '';
  state.channelName = '';
  state.messageTs = '';
}
