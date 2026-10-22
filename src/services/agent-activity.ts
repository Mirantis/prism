/**
 * Whether the agent has work in flight: what a restart would interrupt, and what
 * `GET /agents/state` reports as working.
 *
 * The updater had its own copy of this check, without the working threads. They
 * cover a message between its scheduling and its turn, a gap in which a restart
 * would only delay the turn, and which the updater now waits out too.
 */

import { agentStatusService } from './agent-status.service';
import { compactionService } from './compaction.service';
import { conversationThreadActivityService } from './conversation-thread-activity.service';
import { cronSchedulerService } from './cron-scheduler.service';
import { goalService } from './goal.service';
import { meetingBotService } from './meeting/meeting-bot.service';
import { threadTurnService } from './thread-turn.service';

/**
 * True when nothing runs and nothing waits for a turn.
 *
 * `isBusy()` counts model invocations, which is not the same as "the agent
 * has nothing running". Three kinds of work fall outside it:
 *
 * - a chat exchange, which spans the gap between a turn and the follow-up
 *   coalesced after it, and holds its claim across that gap;
 * - a message that waits for its turn, whose thread is working from the
 *   moment its turn is scheduled;
 * - a `shell_spawn` child or a `coding_agent` task, started by one tool call
 *   and polled from later turns — killing one leaves the agent's next status
 *   poll with nothing to report.
 */
export async function isAgentIdle(): Promise<boolean> {
  if (
    agentStatusService.isBusy() ||
    threadTurnService.hasLiveExchange() ||
    conversationThreadActivityService.workingThreadIds().length > 0 ||
    meetingBotService.isActive ||
    cronSchedulerService.hasRunningTask() ||
    goalService.hasLiveLoops() ||
    compactionService.hasInFlight()
  ) {
    return false;
  }

  // Imported here rather than at the top: this module is reachable from the
  // WebSocket gateway, and the shell tool modules and the voice chat's tool
  // set have no business in that import graph. A caller that never asks never
  // loads them.
  const [{ getProcessManager }, { getAgentTaskManager }, { voiceChatService }] = await Promise.all([
    import('../tools/shell/process-manager'),
    import('../tools/shell/agent-task-manager'),
    import('./voice/voice-chat.service'),
  ]);
  return (
    getProcessManager().runningCount() === 0 &&
    getAgentTaskManager().runningCount() === 0 &&
    !voiceChatService.isLive
  );
}
