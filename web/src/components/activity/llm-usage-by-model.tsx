import { useQuery } from '@tanstack/react-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatTokens } from '@/lib/format';

const WINDOW_HOURS = 24;

/** Token spend over the last 24 hours, one row per model. */
export function LlmUsageByModel() {
  const agent = useAgent();
  // The same query as the usage cards, so the page reads the window once.
  const { data: usage } = useQuery({
    queryKey: ['llm-usage', agent.agentId, WINDOW_HOURS],
    queryFn: () => runtimeApi.llmUsage(WINDOW_HOURS),
    refetchInterval: 30_000,
  });

  const rows = usage?.byModel ?? [];
  if (rows.length === 0) return null;

  return (
    <Table data-testid="activity-usage-by-model">
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          <TableHead className="text-right">Calls</TableHead>
          <TableHead className="text-right">Input</TableHead>
          <TableHead className="text-right">Output</TableHead>
          <TableHead className="text-right">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.model}>
            <TableCell className="font-mono text-xs">{row.model}</TableCell>
            <TableCell className="text-right">{row.calls.toLocaleString()}</TableCell>
            <TableCell className="text-right">{formatTokens(row.inputTokens)}</TableCell>
            <TableCell className="text-right">{formatTokens(row.outputTokens)}</TableCell>
            <TableCell className="text-right">{formatTokens(row.totalTokens)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
