import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLlmUsage } from '@/hooks/use-llm-usage';

/** Token spend over the last 24 hours, one row per model, in exact counts. */
export function LlmUsageByModel() {
  const { data: usage } = useLlmUsage();

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
          <TableRow key={row.model} data-testid="activity-model-usage-row">
            <TableCell className="font-mono text-xs">{row.model}</TableCell>
            <TableCell className="text-right tabular-nums">{row.calls.toLocaleString()}</TableCell>
            <TableCell className="text-right tabular-nums">{row.inputTokens.toLocaleString()}</TableCell>
            <TableCell className="text-right tabular-nums">{row.outputTokens.toLocaleString()}</TableCell>
            <TableCell className="text-right tabular-nums">{row.totalTokens.toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
