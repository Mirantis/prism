import { createFileRoute } from '@tanstack/react-router';
import { LlmUsageCards } from '@/components/activity/llm-usage-cards';
import { ToolCallList } from '@/components/activity/tool-call-list';

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
});

function ActivityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Activity</h2>
        <p className="text-sm text-muted-foreground">What the agent has spent, and what it has done.</p>
      </div>

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
