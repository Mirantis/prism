import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Unplug } from 'lucide-react';
import { runtimeApi } from '@/api/runtime-client';
import { CopyButton } from '@/components/shared/copy-button';
import { IconTile } from '@/components/shared/icon-tile';
import { useAgent } from '@/lib/agent-context';

export function LlmProviderBanner() {
  const agent = useAgent();
  const { data } = useQuery({
    queryKey: ['llm-provider', agent.agentId],
    queryFn: () => runtimeApi.getLlmProvider(),
  });
  if (!data || data.missingSettings.length === 0) return null;

  return (
    <section
      aria-labelledby="provider-setup-title"
      data-testid="llm-provider-banner"
      className="@container rounded-2xl border border-warning/25 bg-card"
    >
      <div
        role="alert"
        className="grid items-center gap-4 rounded-t-2xl bg-linear-to-r from-warning/6 to-transparent p-4 @2xl:grid-cols-[1fr_minmax(16rem,0.85fr)] @2xl:gap-8 @2xl:px-6 @2xl:py-5"
      >
        <div className="flex items-start gap-3.5">
          <IconTile icon={Unplug} tone="warning" size="md" />
          <div>
            <h2 id="provider-setup-title" className="text-lg leading-tight font-semibold tracking-tight">
              Connect a model provider
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your agent needs a provider connection to reply.
            </p>
          </div>
        </div>
        <div className="min-w-0">
          <p className="mb-1.5 text-xs text-muted-foreground">
            Required for <span className="font-mono text-strong">{data.provider}</span>
          </p>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border bg-background/70">
            {data.missingSettings.map((setting) => (
              <li key={setting} className="flex min-h-9 items-center justify-between gap-2 py-1 pr-1 pl-3">
                <span className="min-w-0 font-mono text-xs wrap-anywhere text-strong">{setting}</span>
                {/^[A-Z][A-Z0-9_]*$/.test(setting) && (
                  <CopyButton text={setting} label={`Copy ${setting}`} className="shrink-0" />
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-warning/15 px-4 py-2.5 @2xl:px-6">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Switch providers with <code>LLM_PROVIDER</code>. Restart Prism after editing environment variables.
        </p>
        <a
          href="https://github.com/Mirantis/prism/blob/main/docs/configuration.md#provider-selection"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary-soft hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Provider setup guide <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </a>
      </div>
    </section>
  );
}
