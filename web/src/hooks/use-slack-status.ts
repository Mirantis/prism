import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

/**
 * The Slack workspace this runtime is connected to, if any, and what the agent is linked to in
 * it. The link and channel queries share their keys with the Channels page, so a change made
 * there reaches every reader. A read that failed is reported as `isError`, apart from "not
 * configured", so a reader can say so rather than give configuration advice.
 */
export function useSlackStatus() {
  const agent = useAgent();
  const workspaces = useQuery({
    queryKey: ['slack-workspaces'],
    queryFn: () => runtimeApi.slackWorkspaces(),
  });
  const workspace = workspaces.data?.workspaces[0];
  const connectionId = workspace?.teamId;

  const linkStatus = useQuery({
    queryKey: ['slack-link-status', agent.agentId, connectionId],
    queryFn: () => runtimeApi.slackLinkStatus(),
    enabled: Boolean(workspace),
  });
  const channels = useQuery({
    queryKey: ['slack-channels', agent.agentId, connectionId],
    queryFn: () => runtimeApi.slackChannelMappings(),
    enabled: Boolean(workspace),
  });

  const channelCount = channels.data?.channels.length ?? 0;
  const hasDm = Boolean(linkStatus.data?.hasDmMapping);
  const isLoading =
    workspaces.isLoading || (Boolean(workspace) && (linkStatus.isPending || channels.isPending));
  const isError = workspaces.isError || linkStatus.isError || channels.isError;
  const refetch = () => {
    void workspaces.refetch();
    if (workspace) {
      void linkStatus.refetch();
      void channels.refetch();
    }
  };
  return { workspace, isLoading, isError, refetch, channelCount, hasDm, isLinked: hasDm || channelCount > 0 };
}
