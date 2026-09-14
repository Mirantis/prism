/**
 * Is the runtime doing work a restart would interrupt?
 *
 * Two features restart this process on purpose: the self-updater, after it
 * swaps the install, and a Prism plugin change, which reloads the plugin's
 * server module the only way that is safe. Both have to wait for the same
 * moment, and a busy check copied into a second file drifts the first time a
 * seventh thing can be busy — so this is the one owner of the question.
 *
 * "Busy" is deliberately broad. Losing a model turn mid-answer, a scheduled
 * task mid-run, or a meeting mid-sentence is worse than waiting.
 */

import { agentStatusService } from '../services/agent-status.service';
import { compactionService } from '../services/compaction.service';
import { cronSchedulerService } from '../services/cron-scheduler.service';
import { goalService } from '../services/goal.service';
import { meetingBotService } from '../services/meeting/meeting-bot.service';
import { threadTurnService } from '../services/thread-turn.service';

export async function isRuntimeIdle(): Promise<boolean> {
  if (
    agentStatusService.isBusy() ||
    threadTurnService.hasLiveExchange() ||
    meetingBotService.isActive ||
    cronSchedulerService.hasRunningTask() ||
    goalService.hasLiveLoops() ||
    compactionService.hasInFlight()
  ) {
    return false;
  }

  // Imported here rather than at the top: this module is reachable from the
  // WebSocket gateway, and the shell tool modules have no business in that
  // import graph. A runtime that never restarts never loads them.
  const [{ getProcessManager }, { getAgentTaskManager }] = await Promise.all([
    import('../tools/shell/process-manager'),
    import('../tools/shell/agent-task-manager'),
  ]);
  return getProcessManager().runningCount() === 0 && getAgentTaskManager().runningCount() === 0;
}
