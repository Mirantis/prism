/**
 * Runs the periodic work plugins declare.
 *
 * Separate from `cronSchedulerService`, which owns the agent's own scheduled
 * tasks: those are database rows the agent creates and the user edits, each
 * running a model turn through the DELIVER/SUPPRESS gate. A plugin job is code
 * in a module, has no row, makes no model call and delivers nothing. Putting
 * them in one service would mean one of the two lying about what a task is.
 */

import * as cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { logger } from '../../logger';
import type { PrismPluginJob } from './types';

interface Running {
  task: ScheduledTask;
  /** Set while a tick is executing, so the next tick can skip rather than pile up. */
  inFlight: boolean;
}

class PrismPluginJobRunner {
  private tasks = new Map<string, Running>();

  /**
   * Schedule one plugin's jobs. An invalid expression is refused here rather
   * than at declaration time, because only node-cron knows what it accepts.
   */
  start(pluginId: string, jobs: PrismPluginJob[]): string[] {
    const errors: string[] = [];
    for (const job of jobs) {
      const key = `${pluginId}/${job.name}`;
      if (this.tasks.has(key)) {
        errors.push(`job "${job.name}" is declared twice`);
        continue;
      }
      if (!cron.validate(job.schedule)) {
        errors.push(`job "${job.name}": "${job.schedule}" is not a valid cron expression`);
        continue;
      }
      const running: Running = {
        inFlight: false,
        task: cron.schedule(job.schedule, () => void this.tick(key, running, job)),
      };
      this.tasks.set(key, running);
      logger.info('[PrismPlugins] scheduled job %s (%s)', key, job.schedule);
    }
    return errors;
  }

  /**
   * A tick never rejects: node-cron would have nothing to do with the rejection,
   * and an unhandled one takes the process down.
   */
  private async tick(key: string, running: Running, job: PrismPluginJob): Promise<void> {
    if (running.inFlight) {
      logger.warn('[PrismPlugins] skipping job %s — the previous run is still going', key);
      return;
    }
    running.inFlight = true;
    try {
      await job.run();
    } catch (error: unknown) {
      logger.warn({ err: error }, `[PrismPlugins] job ${key} failed`);
    } finally {
      running.inFlight = false;
    }
  }

  /** Stop every scheduled job. Called from the runtime's shutdown path. */
  stopAll(): void {
    for (const [key, running] of this.tasks) {
      try {
        running.task.stop();
      } catch (error: unknown) {
        logger.warn({ err: error }, `[PrismPlugins] could not stop job ${key}`);
      }
    }
    this.tasks.clear();
  }

  /** How many jobs are scheduled, for the boot log and telemetry. */
  count(): number {
    return this.tasks.size;
  }
}

export const prismPluginJobRunner = new PrismPluginJobRunner();
