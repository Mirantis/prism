/**
 * Tool Lifecycle Events
 *
 * Wraps each tool's execute() to report when it starts and finishes, for live
 * progress UI, such as a channel's working indicator.
 * Purely observational: listener errors are swallowed, and the wrapper never
 * changes a tool's arguments, result, or thrown error.
 */

import type { Tool } from 'ai';

export interface ToolLifecycleEvent {
  type: 'started' | 'completed';
  toolName: string;
}

export type ToolLifecycleListener = (event: ToolLifecycleEvent) => void;

/**
 * Wrap every executable tool so `onToolEvent` fires around its execution.
 * `completed` fires in a finally — a tool that throws still reports, so a
 * progress UI never sticks on a failed tool. Without a listener the tools
 * are returned untouched.
 */
export function withToolLifecycleEvents(
  tools: Record<string, Tool>,
  onToolEvent?: ToolLifecycleListener,
): Record<string, Tool> {
  if (!onToolEvent) return tools;

  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (!execute) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (args: unknown, options: unknown) => {
        notify(onToolEvent, { type: 'started', toolName: name });
        try {
          return await (execute as (a: unknown, o: unknown) => Promise<unknown>)(args, options);
        } finally {
          notify(onToolEvent, { type: 'completed', toolName: name });
        }
      },
    } as Tool;
  }
  return wrapped;
}

function notify(listener: ToolLifecycleListener, event: ToolLifecycleEvent): void {
  try {
    listener(event);
  } catch {
    // Progress UI only — a listener bug must not fail the tool call.
  }
}
