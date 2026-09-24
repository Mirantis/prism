import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Page } from '@/components/layout/page';
import { AgentHero } from '@/components/overview/agent-hero';
import { OverviewStats } from '@/components/overview/overview-stats';
import { RecentConversations } from '@/components/overview/recent-conversations';
import { SetupChecklist } from '@/components/overview/setup-checklist';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

export const Route = createFileRoute('/')({
  component: OverviewPage,
});

function OverviewPage() {
  const agent = useAgent();
  const { data: details } = useQuery({
    queryKey: ['agent-details', agent.agentId],
    queryFn: () => runtimeApi.details(),
  });

  return (
    <Page className="space-y-6">
      <AgentHero details={details} />
      <OverviewStats />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] [&>*]:min-w-0">
        <RecentConversations />
        <SetupChecklist />
      </div>
    </Page>
  );
}
