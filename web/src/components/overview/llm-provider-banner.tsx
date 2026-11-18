import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

/** Shown while the LLM provider lacks a setting, because the agent cannot answer until it has one. */
export function LlmProviderBanner() {
  const agent = useAgent();
  const { data } = useQuery({
    queryKey: ['llm-provider', agent.agentId],
    queryFn: () => runtimeApi.getLlmProvider(),
  });
  if (!data || data.missingSettings.length === 0) return null;

  return (
    <Alert variant="destructive" data-testid="llm-provider-banner" className="px-4 py-3">
      <TriangleAlert />
      <AlertTitle>No LLM provider is configured</AlertTitle>
      <AlertDescription>
        The agent cannot answer messages. Set{' '}
        {data.missingSettings.map((name, i) => (
          <Fragment key={name}>
            {i > 0 && ' and '}
            <code className="font-mono">{name}</code>
          </Fragment>
        ))}{' '}
        for the <code className="font-mono">{data.provider}</code> provider, or choose another
        provider with <code className="font-mono">LLM_PROVIDER</code>, then restart Prism.
      </AlertDescription>
    </Alert>
  );
}
