import { describe, it, expect } from 'vitest';
import { ToolSetTracker, diffToolNames } from './tool-set-tracker.service';

describe('tool set tracking', () => {
  it('sorts additions and removals independently of collection order', () => {
    expect(diffToolNames(['z', 'a', 'kept'], ['c', 'b', 'kept'])).toEqual([
      { type: 'tool_addition', toolName: 'b' },
      { type: 'tool_addition', toolName: 'c' },
      { type: 'tool_removal', toolName: 'a' },
      { type: 'tool_removal', toolName: 'z' },
    ]);
  });
  it('isolates threads and establishes a baseline after a model change or restart', () => {
    const tracker = new ToolSetTracker();
    expect(tracker.record('one', 'model', ['a'])).toEqual([]);
    expect(tracker.record('two', 'model', ['b'])).toEqual([]);
    expect(tracker.record('one', 'other', ['c'])).toEqual([]);
    expect(tracker.record('one', 'other', [])).toEqual([{ type: 'tool_removal', toolName: 'c' }]);
    expect(new ToolSetTracker().record('one', 'other', ['d'])).toEqual([]);
  });
});
