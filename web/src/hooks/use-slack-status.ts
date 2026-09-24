import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

/** The Slack workspace this runtime is connected to, if any, and what the agent is linked to in it. */
export function useSlackStatus() {
  const agent = useAgent();
  const { data: workspacesResp, isLoading } = useQuery({
    queryKey: ['slack-workspaces'],
    queryFn: () => runtimeApi.slackWorkspaces(),
  });
  const workspace = workspacesResp?.workspaces[0];

  const { data: linkStatus } = useQuery({
    queryKey: ['slack-link-status', agent.agentId],
    queryFn: () => runtimeApi.slackLinkStatus(),
    enabled: Boolean(workspace),
  });
  const { data: channelsResp } = useQuery({
    queryKey: ['slack-channel-mappings', agent.agentId],
    queryFn: () => runtimeApi.slackChannelMappings(),
    enabled: Boolean(workspace),
  });

  const channelCount = channelsResp?.channels.length ?? 0;
  const hasDm = Boolean(linkStatus?.hasDmMapping);
  return { workspace, isLoading, channelCount, hasDm, isLinked: hasDm || channelCount > 0 };
}
