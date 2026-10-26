import type { DeliverTo, SlackChannelMapping } from '@/types';

export const DELIVER_LABELS: Record<DeliverTo, string> = {
  all: 'All channels',
  chat: 'Chat',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  none: 'None',
};

/** `#name` for each chosen channel; one no longer linked shows its id. */
export function slackChannelNames(ids: string[], linked: SlackChannelMapping[]): string {
  return ids
    .map((id) => {
      const channel = linked.find((c) => c.channelId === id);
      return channel ? `#${channel.channelName ?? id}` : id;
    })
    .join(', ');
}
