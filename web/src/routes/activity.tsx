import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { LlmUsageCards } from '@/components/activity/llm-usage-cards';
import { LlmUsageByModel } from '@/components/activity/llm-usage-by-model';
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
        <SectionHeader
          title="LLM usage"
          description="Tokens used in the last 24 hours."
          actions={
            <Link to="/spending" className="inline-flex items-center gap-1 text-sm text-primary-soft hover:underline" data-testid="activity-spending-link">
              See spending <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          }
        />
        <LlmUsageCards />
        <LlmUsageByModel />
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
