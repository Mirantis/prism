import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Unplug } from 'lucide-react';
import { runtimeApi } from '@/api/runtime-client';
import { CopyButton } from '@/components/shared/copy-button';
import { IconTile } from '@/components/shared/icon-tile';
import { useAgent } from '@/lib/agent-context';
import { namesVariable, settingParts } from '@/lib/provider-settings';

/** A release build's version is its tag, so the guide opens the docs of the running release. */
const RELEASE_VERSION = /^v\d{4}\.\d{1,2}\.\d+$/;

function guideUrl(version: string | undefined): string {
  const ref = version && RELEASE_VERSION.test(version) ? version : 'main';
  return `https://github.com/Mirantis/prism/blob/${ref}/docs/configuration.md#provider-selection`;
}

/** Shown while the LLM provider lacks a setting, because the agent cannot answer until it has one. */
export function LlmProviderBanner() {
  const agent = useAgent();
  const { data } = useQuery({
    queryKey: ['llm-provider', agent.agentId],
    queryFn: () => runtimeApi.getLlmProvider(),
  });
  const { data: update } = useQuery({
    queryKey: ['update-status'],
    queryFn: runtimeApi.updateStatus,
    refetchInterval: 30 * 60_000,
  });
  if (!data || data.missingSettings.length === 0) return null;

  const needsVariables = data.missingSettings.some(namesVariable);

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
            <p id="provider-setup-title" className="text-lg leading-tight font-semibold tracking-tight">
              Connect a model provider
            </p>
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
              <li key={setting} className="flex min-h-9 flex-wrap items-center gap-x-1 py-1 pr-1 pl-3 text-xs">
                {namesVariable(setting) ? (
                  settingParts(setting).map((part, index) =>
                    part.kind === 'variable' ? (
                      <span key={index} className="inline-flex min-w-0 items-center gap-0.5">
                        <span className="font-mono wrap-anywhere text-strong">{part.name}</span>
                        <CopyButton text={part.name} label={`Copy ${part.name}`} className="shrink-0" />
                      </span>
                    ) : (
                      <span key={index} className="text-muted-foreground">{part.text.trim()}</span>
                    ),
                  )
                ) : (
                  <>
                    <span className="text-strong">{setting}</span>
                    <Link
                      to="/profile"
                      className="ml-auto rounded-sm px-2 font-medium text-primary-soft hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      Open Profile
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-warning/15 px-4 py-2.5 @2xl:px-6">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Switch providers with <code>LLM_PROVIDER</code>.
          {needsVariables && ' Restart Prism after editing environment variables.'}
        </p>
        <a
          href={guideUrl(update?.currentVersion)}
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
