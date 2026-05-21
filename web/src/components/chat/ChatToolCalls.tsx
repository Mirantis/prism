import { useState, useMemo } from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, Wrench } from 'lucide-react';
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

function getOutputPreview(output: string): { preview: string; isTruncated: boolean; fullLength: number } {
  if (!output) return { preview: '', isTruncated: false, fullLength: 0 };
  let text = output;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (typeof parsed === 'string') text = parsed;
    else text = JSON.stringify(parsed, null, 2);
  } catch {
    /* keep as-is */
  }
  const fullLength = text.length;
  const lines = text.split('\n');
  const truncatedByLines = lines.length > OUTPUT_MAX_LINES;
  const joined = truncatedByLines ? lines.slice(0, OUTPUT_MAX_LINES).join('\n') : text;
  const truncatedByChars = joined.length > OUTPUT_MAX_CHARS;
  const preview = truncatedByChars ? joined.slice(0, OUTPUT_MAX_CHARS) + '...' : joined;
  return { preview, isTruncated: truncatedByLines || truncatedByChars, fullLength };
}

function formatCharCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function ToolCallCard({ tc }: { tc: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const label = formatToolLabel(tc.tool);
  const preview = getInputPreview(tc.input);
  const inputPairs = useMemo(() => formatToolInput(tc.input), [tc.input]);
  const outputInfo = useMemo(() => getOutputPreview(tc.output), [tc.output]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted/50 ${
          !tc.success ? 'bg-destructive/5' : ''
        }`}
      >
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className={`size-2 shrink-0 rounded-full ${tc.success ? 'bg-green-500' : 'bg-destructive'}`} />
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {preview && <span className="min-w-0 truncate text-muted-foreground font-mono">{preview}</span>}
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
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Output</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-xs text-foreground">
                {showFullOutput ? tc.output : outputInfo.preview}
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
                  {showFullOutput ? 'Collapse output' : `Show full output (${formatCharCount(outputInfo.fullLength)} chars)`}
                </button>
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ChatToolCallsProps {
  toolCalls: ToolCallRecord[];
}

export default function ChatToolCalls({ toolCalls }: ChatToolCallsProps) {
  const [open, setOpen] = useState(false);
  if (toolCalls.length === 0) return null;
  const failCount = toolCalls.filter((tc) => !tc.success).length;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Wrench className="size-3.5" />
        <span>
          {toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''} used
        </span>
        {failCount > 0 && (
          <Badge variant="destructive" className="ml-1 h-4 text-[10px] px-1.5">
            {failCount} failed
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 flex flex-col gap-0.5">
          {toolCalls.map((tc, idx) => (
            <ToolCallCard key={idx} tc={tc} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
