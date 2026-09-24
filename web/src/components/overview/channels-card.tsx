import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

export function ChannelsCard() {
  const agent = useAgent();
  const { data: workspacesResp, isLoading: workspacesLoading } = useQuery({
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

  const count = channelsResp?.channels.length ?? 0;
  const subtitle = !workspace
    ? 'Not configured'
    : `${workspace.teamName}${linkStatus?.hasDmMapping ? ' · DM linked' : ''}`;

  return (
    <Link to="/channels" className="stat-link" aria-label="Channels">
      <Card className="stat-card h-full">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardDescription>Channels</CardDescription>
          <MessagesSquare className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {workspacesLoading ? (
            <Skeleton className="h-7 w-12" />
          ) : (
            <>
              <div className="text-3xl font-semibold tracking-tight tabular-nums">{count}</div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
            </>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
