import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import type { AgentSummary } from '@lensapp/prism-client';

const AgentContext = createContext<AgentSummary | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['agent', 'me'],
    queryFn: () => runtimeApi.me(),
    // 30s cadence so agent-driven renames (via the rename_self tool) surface
    // in the UI without a hard refresh. The query is a single indexed
    // findFirst — cheap to refetch.
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
        Loading agent…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex h-screen items-center justify-center text-destructive text-sm">
        Failed to load agent: {error instanceof Error ? error.message : 'unknown error'}
      </div>
    );
  }

  return <AgentContext.Provider value={data}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentSummary {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used inside <AgentProvider>');
  return ctx;
}
