import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

/**
 * The Slack channels linked to the agent, under the key the Channels page
 * reads and invalidates. Unlike `useSlackStatus`, the read does not wait for a
 * connected workspace, so a channel a webhook posts to keeps its name while
 * Slack is not connected.
 */
export function useSlackChannels() {
  const agent = useAgent();
  const workspaces = useQuery({
    queryKey: ['slack-workspaces'],
    queryFn: () => runtimeApi.slackWorkspaces(),
  });
  const connectionId = workspaces.data?.workspaces[0]?.teamId;
  return useQuery({
    queryKey: ['slack-channels', agent.agentId, connectionId],
    queryFn: () => runtimeApi.slackChannelMappings(),
    enabled: !workspaces.isPending,
  });
}
