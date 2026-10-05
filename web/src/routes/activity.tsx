import { createFileRoute } from '@tanstack/react-router';
import { LlmUsageCards } from '@/components/activity/llm-usage-cards';
import { ToolCallList } from '@/components/activity/tool-call-list';
import { WebhookRunList } from '@/components/activity/webhook-run-list';
import { Page } from '@/components/layout/page';
import { PageHeader } from '@/components/layout/page-header';
import { SectionHeader } from '@/components/layout/section-header';

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
});

function ActivityPage() {
  return (
    <Page>
      <PageHeader title="Activity" description="What the agent has spent, and what it has done." />

      <section className="space-y-3">
        <SectionHeader title="LLM usage" description="Tokens used in the last 24 hours." />
        <LlmUsageCards />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Webhook runs"
          description="Newest first, with the result of each. Expand a run to see what it delivered."
        />
        <WebhookRunList />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Tool calls"
          description="Newest turn first, across every conversation. Expand a call to see its parameters."
        />
        <ToolCallList />
      </section>
    </Page>
  );
}
