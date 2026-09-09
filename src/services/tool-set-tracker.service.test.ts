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
    expect(tracker.record('one', 'chat', 'model', ['a'])).toEqual([]);
    expect(tracker.record('two', 'chat', 'model', ['b'])).toEqual([]);
    expect(tracker.record('one', 'chat', 'other', ['c'])).toEqual([]);
    expect(tracker.record('one', 'chat', 'other', [])).toEqual([{ type: 'tool_removal', toolName: 'c' }]);
    expect(new ToolSetTracker().record('one', 'chat', 'other', ['d'])).toEqual([]);
  });
  it('keeps one record per mode, so a goal turn on a chat thread announces nothing', () => {
    const tracker = new ToolSetTracker();
    expect(tracker.record('one', 'chat', 'model', ['create_goal', 'shell_exec'])).toEqual([]);
    // The goal turn's set omits create_goal, which is the mode's doing and not a
    // change to the thread's tools.
    expect(tracker.record('one', 'goal', 'model', ['shell_exec'])).toEqual([]);
    // The chat turn after it diffs against the previous chat turn, so a tool that
    // really did go is still named.
    expect(tracker.record('one', 'chat', 'model', ['create_goal'])).toEqual([
      { type: 'tool_removal', toolName: 'shell_exec' },
    ]);
  });
  it('evicts the least recently recorded thread and keeps the busy one', () => {
    const tracker = new ToolSetTracker();
    tracker.record('idle', 'chat', 'model', ['a']);
    tracker.record('busy', 'chat', 'model', ['a']);
    for (let i = 0; i < 300; i++) {
      tracker.record(`thread-${i}`, 'chat', 'model', ['a']);
      tracker.record('busy', 'chat', 'model', ['a']);
    }
    // 'idle' took one turn and fell out, so its next turn reports no change and
    // records the baseline again.
    expect(tracker.record('idle', 'chat', 'model', [])).toEqual([]);
    // 'busy' took a turn in every round, which is what keeps its record.
    expect(tracker.record('busy', 'chat', 'model', [])).toEqual([{ type: 'tool_removal', toolName: 'a' }]);
  });
});
