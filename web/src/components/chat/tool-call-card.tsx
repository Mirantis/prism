import { useState, useMemo, type ReactNode } from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { ChevronRight } from 'lucide-react';
import type { ToolCallRecord } from '@/types';

function formatToolLabel(toolName: string): string {
  return toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const PREVIEW_KEY_PRIORITY = ['command', 'query', 'prompt', 'task', 'name', 'path', 'key', 'url'];

function formatToolInput(rawInput: string): { key: string; value: string }[] {
  if (!rawInput) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return [{ key: 'input', value: rawInput }];
  }
  const entries = Object.entries(parsed);
  entries.sort(([a], [b]) => {
    const ai = PREVIEW_KEY_PRIORITY.indexOf(a);
    const bi = PREVIEW_KEY_PRIORITY.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });
  return entries.map(([k, v]) => ({
    key: k,
    value: typeof v === 'string' ? v : JSON.stringify(v),
  }));
}

function getInputPreview(rawInput: string): string {
  if (!rawInput) return '';
  try {
    const parsed = JSON.parse(rawInput) as Record<string, unknown>;
    for (const key of PREVIEW_KEY_PRIORITY) {
      if (parsed[key] !== undefined) {
        const val = String(parsed[key]);
        return val.length > 60 ? val.slice(0, 57) + '...' : val;
      }
    }
    for (const v of Object.values(parsed)) {
      if (typeof v === 'string' && v.length > 0) {
        return v.length > 60 ? v.slice(0, 57) + '...' : v;
      }
    }
  } catch {
    return rawInput.length > 60 ? rawInput.slice(0, 57) + '...' : rawInput;
  }
  return '';
}

const OUTPUT_MAX_LINES = 5;
const OUTPUT_MAX_CHARS = 200;

/**
 * A tool's output as it should read, plus the short form shown when collapsed.
 *
 * `full` is what expanding renders and what the character count counts, so the
 * two agree with the preview they came from: a JSON output is pretty-printed
 * once, here, rather than formatted for the preview and shown raw when opened.
 * What is stored is the text the model saw, so an MCP result arrives as its
 * joined text and this panel shows what the agent actually read.
 */
function getOutputPreview(output: string): { full: string; preview: string; isTruncated: boolean } {
  if (!output) return { full: '', preview: '', isTruncated: false };

  let full = output;
  try {
    const parsed = JSON.parse(output) as unknown;
    full = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    /* not JSON — show it as it arrived */
  }

  const lines = full.split('\n');
  const truncatedByLines = lines.length > OUTPUT_MAX_LINES;
  const joined = truncatedByLines ? lines.slice(0, OUTPUT_MAX_LINES).join('\n') : full;
  const truncatedByChars = joined.length > OUTPUT_MAX_CHARS;
  const preview = truncatedByChars ? joined.slice(0, OUTPUT_MAX_CHARS) + '...' : joined;

  return { full, preview, isTruncated: truncatedByLines || truncatedByChars };
}

function formatCharCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

interface ToolCallCardProps {
  tc: ToolCallRecord;
  /**
   * Rendered on the right of the trigger row. The Activity page puts the call's
   * time and where it came from there; chat needs neither, because the message
   * it sits under already says both.
   */
  meta?: ReactNode;
  /** Set on the trigger row, for tests that count or open calls. */
  testId?: string;
}

/**
 * One expandable tool call: the trigger row names the tool and previews its
 * most telling argument, and opening it shows every argument and the output.
 *
 * Shared by the chat transcript and the Activity feed, so the same call reads
 * the same way in both.
 */
export default function ToolCallCard({ tc, meta, testId }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const label = formatToolLabel(tc.tool);
  const preview = getInputPreview(tc.input);
  const inputPairs = useMemo(() => formatToolInput(tc.input), [tc.input]);
  const outputInfo = useMemo(() => getOutputPreview(tc.output), [tc.output]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        data-testid={testId}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted/50 ${
          !tc.success ? 'bg-destructive/5' : ''
        }`}
      >
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${tc.success ? 'bg-green-500' : 'bg-destructive'}`}
        />
        {/* The dot is the only visual cue, so the status also goes out as text. */}
        <span className="sr-only">{tc.success ? 'Succeeded' : 'Failed'}:</span>
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {preview && <span className="min-w-0 truncate text-muted-foreground font-mono">{preview}</span>}
        {meta && <span className="ml-auto shrink-0 pl-2">{meta}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-[18px] border-l border-border pl-4 py-1">
          {inputPairs.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Input</div>
              <div className="space-y-0.5">
                {inputPairs.map(({ key, value }) => (
                  <div key={key} className="flex gap-2 font-mono text-xs">
                    <span className="shrink-0 text-muted-foreground">{key}:</span>
                    <span className="min-w-0 break-all text-foreground">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!tc.success && !tc.output && <div className="text-xs text-destructive">Tool execution failed</div>}
          {tc.output && (
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Output</span>
                {tc.truncated && (
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
                    cut — {formatCharCount(tc.truncated.keptChars)} of{' '}
                    {formatCharCount(tc.truncated.totalChars)} chars
                  </Badge>
                )}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-xs text-foreground">
                {showFullOutput ? outputInfo.full : outputInfo.preview}
              </pre>
              {outputInfo.isTruncated && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFullOutput(!showFullOutput);
                  }}
                  className="mt-1 text-xs text-primary hover:underline"
                >
                  {showFullOutput ? 'Collapse output' : `Show full output (${formatCharCount(outputInfo.full.length)} chars)`}
                </button>
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
