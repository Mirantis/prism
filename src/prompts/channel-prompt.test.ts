import { describe, it, expect } from 'vitest';
import { getChannelBehaviorInstructions } from './channel-prompt';

describe('getChannelBehaviorInstructions', () => {
  it('names the channel when a name is provided', () => {
    const out = getChannelBehaviorInstructions('alerts');
    expect(out).toContain('the team Slack channel **#alerts**');
  });

  it('does not double the # when the name already has one', () => {
    const out = getChannelBehaviorInstructions('#general');
    expect(out).toContain('**#general**');
    expect(out).not.toContain('**##general**');
  });
});
