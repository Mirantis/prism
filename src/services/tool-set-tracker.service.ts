/**
 * The tool set each thread's previous turn declared, so the next turn can name
 * what changed. In memory only: a restart drops the record, and the first turn
 * after it announces nothing and establishes the baseline again.
 */

export type ToolChange = {
  type: 'tool_addition' | 'tool_removal';
  toolName: string;
};

/**
 * Records kept. A container serves one agent, and only a thread that takes
 * another turn has any use for its record, so the oldest entry is the one that
 * loses least. Eviction reads as a restart: the thread's next turn announces
 * nothing and records its set again.
 */
const MAX_TRACKED_RECORDS = 200;

export function diffToolNames(previous: string[], current: string[]): ToolChange[] {
  return [
    ...current.filter((name) => !previous.includes(name)).sort()
      .map((toolName) => ({ type: 'tool_addition' as const, toolName })),
    ...previous.filter((name) => !current.includes(name)).sort()
      .map((toolName) => ({ type: 'tool_removal' as const, toolName })),
  ];
}

/** The first turn after a restart establishes the thread's tool set. */
export class ToolSetTracker {
  private readonly tracked = new Map<string, { names: string[]; modelId: string }>();

  /**
   * One record per thread *and* invocation mode. A goal turn and a thread-bound
   * cron run share the thread with chat and each declares its mode's own set
   * (`filterToolsByMode`), so a single per-thread record would announce a
   * removal for every tool the mode withholds and an addition for each of them
   * on the next chat turn — true of the request, and a false account of what the
   * agent can do. Per mode, each turn diffs against the previous turn in the
   * same mode, so a plugin that connects is still named.
   */
  record(threadId: string, mode: string, modelId: string, names: string[]): ToolChange[] {
    const key = `${mode}:${threadId}`;
    const previous = this.tracked.get(key);
    // Re-inserted rather than overwritten, so a Map iterates oldest first and
    // the eviction below drops the least recently used record.
    this.tracked.delete(key);
    this.tracked.set(key, { names, modelId });
    if (this.tracked.size > MAX_TRACKED_RECORDS) {
      const oldest = this.tracked.keys().next();
      if (!oldest.done) this.tracked.delete(oldest.value);
    }
    if (!previous || previous.modelId !== modelId) return [];
    return diffToolNames(previous.names, names);
  }
}

export const toolSetTracker = new ToolSetTracker();
