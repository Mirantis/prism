import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

const MIN_INTERVAL_MS = 60_000; // 1 minute
const MAX_INTERVAL_MS = 604_800_000; // 7 days

/**
 * Parse a heartbeat interval token like '5m' or '2h' into milliseconds.
 *
 * Accepts a positive integer followed by 'm' (minutes) or 'h' (hours),
 * case-insensitive. Returns null when the token is malformed or the resulting
 * interval falls outside [1 minute, 7 days].
 */
export function parseInterval(token: string): number | null {
  const match = /^(\d+)(m|h)$/i.exec(token);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === 'm' ? value * 60_000 : value * 3_600_000;
  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return null;
  return ms;
}

/** Render a nullable ISO timestamp for status output. */
function formatTimestamp(iso: string | null): string {
  return iso ?? 'never';
}

export const heartbeatCommand: SlashCommand = {
  name: '/heartbeat',
  description: 'Control the heartbeat (status|start|stop|trigger|every Nm|Nh)',
  run: async (ctx) => {
    const sub = ctx.args[0];
    const usage =
      'Usage: /heartbeat <status|start|stop|trigger|every Nm|Nh>.';
    try {
      switch (sub) {
        case 'status': {
          const s = await ctx.api.getHeartbeatStatus();
          const interval =
            s.intervalMs === undefined ? 'unknown' : `${s.intervalMs}ms`;
          return [
            `active: ${s.isActive}`,
            `running: ${s.isRunning}`,
            `last run: ${formatTimestamp(s.lastRun)}`,
            `consecutive errors: ${s.consecutiveErrors}`,
            `interval: ${interval}`,
          ].join('\n');
        }
        case 'start': {
          const details = await ctx.api.getDetails();
          const result = await ctx.api.startHeartbeat(details);
          return result.message;
        }
        case 'stop': {
          const result = await ctx.api.stopHeartbeat();
          return result.message;
        }
        case 'trigger': {
          const result = await ctx.api.triggerHeartbeat();
          return result.success
            ? 'Heartbeat triggered.'
            : 'Heartbeat trigger reported failure.';
        }
        case 'every': {
          const ms = parseInterval(ctx.args[1] ?? '');
          if (ms === null) {
            return 'Use Nm or Nh, e.g. /heartbeat every 5m';
          }
          const s = await ctx.api.setHeartbeatInterval(ms);
          const interval =
            s.intervalMs === undefined ? `${ms}ms` : `${s.intervalMs}ms`;
          return `Heartbeat interval set to ${interval}.`;
        }
        default:
          return usage;
      }
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
