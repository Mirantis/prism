import type { ContextUsage } from '@lensapp/prism-client';

/** Above HIGH the reading turns amber; above CRITICAL, red. */
const HIGH_USAGE_PERCENT = 80;
const CRITICAL_USAGE_PERCENT = 90;

function toneFor(usedPercent: number): string {
  if (usedPercent > CRITICAL_USAGE_PERCENT) return 'text-destructive';
  if (usedPercent > HIGH_USAGE_PERCENT) return 'text-amber-600 dark:text-amber-500';
  return 'text-muted-foreground';
}

/**
 * How much of the model's context window this thread has consumed.
 *
 * The runtime owns both inputs (the provider-reported prompt size and the model's
 * window) and reports the consumed share directly, so this renders it verbatim —
 * no arithmetic here, and the figure agrees exactly with the raw token counts in
 * the tooltip. Callers render this only when a measurement exists: there is
 * deliberately no "0% used" placeholder before a thread's first turn, since the
 * system prompt alone occupies thousands of tokens and the runtime hasn't measured
 * anything yet.
 *
 * The CLI status bar shows the same figure in a compact `| context 58%` form.
 */
export default function ContextMeter({ usage }: { usage: ContextUsage }) {
  const { usedPercent, usedTokens, windowTokens, modelId } = usage;

  return (
    <span
      data-testid="context-meter"
      className={`tabular-nums ${toneFor(usedPercent)}`}
      title={`${usedTokens.toLocaleString()} of ${windowTokens.toLocaleString()} tokens used (${modelId})`}
    >
      {usedPercent}% context used
    </span>
  );
}
