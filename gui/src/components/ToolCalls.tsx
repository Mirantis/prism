import type { ToolCallRecord } from '../lib/runtime';

/** Collapsible inspector for an agent message's tool calls. */
export function ToolCalls({ toolCalls }: { toolCalls: ToolCallRecord[] }) {
  if (toolCalls.length === 0) return null;
  return (
    <details className="tool-calls">
      <summary>
        🔧 {toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'}
      </summary>
      {toolCalls.map((tc, i) => (
        <div key={i} className="tool-call">
          <div className="tool-call-name">
            {tc.success ? '✓' : '✗'} {tc.tool}
          </div>
          {tc.input ? <pre className="tool-call-io">{tc.input}</pre> : null}
          {tc.output ? <pre className="tool-call-io">{tc.output}</pre> : null}
        </div>
      ))}
    </details>
  );
}
