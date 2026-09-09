export type ToolChange = {
  type: 'tool_addition' | 'tool_removal';
  toolName: string;
};

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

  record(threadId: string, modelId: string, names: string[]): ToolChange[] {
    const previous = this.tracked.get(threadId);
    this.tracked.set(threadId, { names, modelId });
    if (!previous || previous.modelId !== modelId) return [];
    return diffToolNames(previous.names, names);
  }
}

export const toolSetTracker = new ToolSetTracker();
