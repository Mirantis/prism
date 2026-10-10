import { describe, it, expect } from 'vitest';
import { formatTeamsMessage, teamsChannelLabel, TEAMS_TEXT_LIMIT } from './teams-formatter';

describe('formatTeamsMessage', () => {
  it('returns the content as a single chunk', () => {
    expect(formatTeamsMessage('hello')).toEqual(['hello']);
  });

  it('renders a heartbeat banner', () => {
    const [chunk] = formatTeamsMessage('all clear', { triggeredBy: 'HEARTBEAT' });
    expect(chunk).toBe('💓 **Heartbeat Alert**\n\nall clear');
  });

  it('renders a scheduled-task banner', () => {
    const [chunk] = formatTeamsMessage('done', { triggeredBy: 'CRON_TASK' });
    expect(chunk.startsWith('⏰ **Scheduled Task Result**')).toBe(true);
  });

  it('renders a generic banner for other triggers', () => {
    const [chunk] = formatTeamsMessage('hi', { triggeredBy: 'GOAL' });
    expect(chunk.startsWith('📬 **GOAL**')).toBe(true);
  });

  it('adds no banner for USER_INPUT', () => {
    expect(formatTeamsMessage('hi', { triggeredBy: 'USER_INPUT' })).toEqual(['hi']);
  });

  it('appends a de-duplicated tool footer', () => {
    const [chunk] = formatTeamsMessage('done', {
      toolCalls: [{ tool: 'shell_exec' }, { tool: 'shell_exec' }, { tool: 'memory_search' }],
    });
    expect(chunk).toBe('done\n\n🔧 _shell_exec, memory_search_');
  });

  it('passes markdown tables through unchanged (Teams renders them)', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(formatTeamsMessage(table)).toEqual([table]);
  });

  it('renders a placeholder for empty content', () => {
    expect(formatTeamsMessage('   ')).toEqual(['(empty message)']);
  });

  it('chunks over-limit content, banner on the first chunk and footer on the last', () => {
    const body = `${'a'.repeat(TEAMS_TEXT_LIMIT - 100)}\n\n${'b'.repeat(TEAMS_TEXT_LIMIT - 100)}`;
    const chunks = formatTeamsMessage(body, {
      triggeredBy: 'HEARTBEAT',
      toolCalls: [{ tool: 'kubectl' }],
    });
    expect(chunks.length).toBe(2);
    expect(chunks[0].startsWith('💓 **Heartbeat Alert**')).toBe(true);
    expect(chunks[0].includes('🔧')).toBe(false);
    expect(chunks[1].endsWith('🔧 _kubectl_')).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TEAMS_TEXT_LIMIT + 100);
    }
  });
});

describe('teamsChannelLabel', () => {
  it('names the channel as Teams shows it', () => {
    expect(teamsChannelLabel('General')).toContain('the Microsoft Teams channel **General**,');
  });

  // Teams shows a token in a reply as text, so the agent writes the name.
  it('tells the agent to address people by name, not by token', () => {
    expect(teamsChannelLabel('General')).toContain('address people by name');
    expect(teamsChannelLabel('General')).not.toContain('writing their token');
  });
});
