import { describe, it, expect } from 'vitest';
import { getChannelBehaviorInstructions } from './channel-prompt';

describe('getChannelBehaviorInstructions', () => {
  it('names the channel with the label its adapter gives', () => {
    const out = getChannelBehaviorInstructions('the team channel **#alerts**');
    expect(out).toContain('You are participating in the team channel **#alerts**.');
  });
});
