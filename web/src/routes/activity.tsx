import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/shared/page-header';
import { LlmUsageCards } from '@/components/activity/llm-usage-cards';
import { ToolCallList } from '@/components/activity/tool-call-list';

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
});

function ActivityPage() {
  return (
    <div className="page-content space-y-8">
      <PageHeader
        title="Activity"
        description="Keep track of model usage and the work your agent has done."
      />

      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">LLM usage</h3>
          <p className="text-sm text-muted-foreground">Tokens used in the last 24 hours.</p>
        </div>
        <LlmUsageCards />
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Tool calls</h3>
          <p className="text-sm text-muted-foreground">
            Newest turn first, across every conversation. Expand a call to see its parameters.
          </p>
        </div>
        <ToolCallList />
      </section>
    </div>
  );
}
