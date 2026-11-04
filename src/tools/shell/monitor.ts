/**
 * Inputs and handlers for `monitor` / `monitor_stop`. The watch itself is the
 * monitor manager's.
 */
import { z } from 'zod';
import type { TaskNotificationTarget } from '../../services/task-notification.service';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, getMonitorManager } from './monitor-manager';

export const monitorInput = z.object({
  command: z.string().describe('Shell command. Each line it prints on stdout is an event; its exit ends the watch.'),
  description: z.string().describe('What is watched, in a few words. Each notification names it.'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Stop the command after this many ms (default ${DEFAULT_TIMEOUT_MS}).`),
});

export const monitorStopInput = z.object({
  monitorId: z.string().describe('Monitor ID returned by monitor'),
});

/** What the agent does after starting a monitor. */
export const MONITOR_NEXT =
  'End your turn now unless you have other work. Each line the command prints arrives in this conversation as a task notification.';

export async function runMonitor(
  input: z.infer<typeof monitorInput>,
  workspace: string,
  notify: TaskNotificationTarget,
) {
  const monitorId = await getMonitorManager().start({ ...input, workdir: workspace, notify });
  return { monitorId, next: MONITOR_NEXT };
}

export function runMonitorStop(input: z.infer<typeof monitorStopInput>) {
  return { ok: getMonitorManager().stop(input.monitorId) };
}
