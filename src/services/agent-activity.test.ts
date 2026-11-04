import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: { busy: false, exchange: false, workingThreads: [] as string[], shellProcs: 0, monitors: 0 },
}));

vi.mock('./agent-status.service', () => ({ agentStatusService: { isBusy: () => state.busy } }));
vi.mock('./thread-turn.service', () => ({ threadTurnService: { hasLiveExchange: () => state.exchange } }));
vi.mock('./conversation-thread-activity.service', () => ({
  conversationThreadActivityService: { workingThreadIds: () => state.workingThreads },
}));
vi.mock('./meeting/meeting-bot.service', () => ({ meetingBotService: { isActive: false } }));
vi.mock('./cron-scheduler.service', () => ({ cronSchedulerService: { hasRunningTask: () => false } }));
vi.mock('./goal.service', () => ({ goalService: { hasLiveLoops: () => false } }));
vi.mock('./compaction.service', () => ({ compactionService: { hasInFlight: () => false } }));
vi.mock('../tools/shell/process-manager', () => ({ getProcessManager: () => ({ runningCount: () => state.shellProcs }) }));
vi.mock('../tools/shell/agent-task-manager', () => ({ getAgentTaskManager: () => ({ runningCount: () => 0 }) }));
vi.mock('../tools/shell/monitor-manager', () => ({ getMonitorManager: () => ({ runningCount: () => state.monitors }) }));
vi.mock('./voice/voice-chat.service', () => ({ voiceChatService: { isLive: false } }));

import { isAgentIdle } from './agent-activity';

describe('isAgentIdle', () => {
  beforeEach(() => {
    Object.assign(state, { busy: false, exchange: false, workingThreads: [], shellProcs: 0, monitors: 0 });
  });

  it('is idle when nothing runs or waits', async () => {
    expect(await isAgentIdle()).toBe(true);
  });

  it.each([
    ['a model call is in flight', { busy: true }],
    ['an exchange holds its thread between turns', { exchange: true }],
    ['a message waits for its turn on a working thread', { workingThreads: ['thread-1'] }],
    ['a process a tool started still runs', { shellProcs: 1 }],
    ['a monitor still watches', { monitors: 1 }],
  ])('is working while %s', async (_case, overrides) => {
    Object.assign(state, overrides);
    expect(await isAgentIdle()).toBe(false);
  });
});
