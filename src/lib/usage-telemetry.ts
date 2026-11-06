/**
 * Usage Telemetry
 *
 * Single owner of the `llm usage aggregated` product event: the agent's model
 * calls, one event per closed UTC hour and model, read from `llm_calls`. Each
 * event covers `[period_start, period_end)` and carries counts only.
 *
 * `runtime_state` keeps the end of the last hour reported, so a restart neither
 * repeats an hour nor skips one. A pass reports every closed hour after that,
 * at most `MAX_CATCH_UP_HOURS`. A crash between the events and the write of
 * that mark sends the same hours again, with the same period start.
 *
 * One process uses one vendor and one route, so provider and routing are read
 * from config when an hour is reported. After a restart that changed
 * `LLM_PROVIDER` or `NEXUS_API_URL`, the hours not yet reported carry the new
 * values; a column per call would need a schema migration for those few hours.
 */

import { config } from '../config';
import { logger } from '../logger';
import { prisma } from './prisma';
import { isTelemetryEnabled, trackEvent } from './telemetry';
import { llmRouting } from './startup-telemetry';
import { LLM_USAGE_REPORTED_THROUGH, runtimeStateService } from '../services/runtime-state.service';

const HOUR_MS = 60 * 60 * 1000;
/** How long after its end an hour is read, so a call recorded just before the boundary is in. */
const SETTLE_MS = 60 * 1000;
/** The most closed hours one pass reports, which bounds the rows it reads. */
const MAX_CATCH_UP_HOURS = 24;

interface Bucket {
  hourStart: number;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

function startOfHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Report the closed hours not yet reported. Never rejects: a failure is logged,
 * and the next pass reports the same hours.
 *
 * The rows are the owner's alone, since a subagent's calls are recorded against
 * the owner.
 */
export async function reportClosedHours(agentId: string, now: number = Date.now()): Promise<void> {
  try {
    const end = startOfHour(now - SETTLE_MS);
    const reportedThrough = await runtimeStateService.get(LLM_USAGE_REPORTED_THROUGH);
    const start = Math.max(
      reportedThrough ? Date.parse(reportedThrough) : -Infinity,
      end - MAX_CATCH_UP_HOURS * HOUR_MS,
    );
    if (start >= end) return;

    const rows = await prisma.llmCall.findMany({
      where: { agentId, createdAt: { gte: new Date(start), lt: new Date(end) } },
      select: {
        model: true,
        createdAt: true,
        inputTokens: true,
        outputTokens: true,
        cacheWriteTokens: true,
        cacheReadTokens: true,
      },
    });

    const buckets = new Map<string, Bucket>();
    for (const row of rows) {
      const hourStart = startOfHour(row.createdAt.getTime());
      const key = `${hourStart} ${row.model}`;
      const bucket = buckets.get(key) ?? {
        hourStart,
        model: row.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      };
      bucket.calls += 1;
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.cacheWriteTokens += row.cacheWriteTokens;
      bucket.cacheReadTokens += row.cacheReadTokens;
      buckets.set(key, bucket);
    }

    const routing = llmRouting();
    for (const bucket of buckets.values()) {
      trackEvent('llm usage aggregated', undefined, {
        'usage.period_start': new Date(bucket.hourStart).toISOString(),
        'usage.period_end': new Date(bucket.hourStart + HOUR_MS).toISOString(),
        'usage.provider': config.llmProvider,
        'usage.model': bucket.model,
        // The whole prompt, cache reads and writes included.
        'usage.input_tokens': String(bucket.inputTokens),
        'usage.output_tokens': String(bucket.outputTokens),
        'usage.cache_creation_tokens': String(bucket.cacheWriteTokens),
        'usage.cache_read_tokens': String(bucket.cacheReadTokens),
        // Model calls, one per step, including those the provider reported no usage for.
        'usage.request_count': String(bucket.calls),
        'usage.metering_point': 'harness',
        'usage.llm_routing': routing,
        'agent.id': agentId,
      });
    }

    await runtimeStateService.set(LLM_USAGE_REPORTED_THROUGH, new Date(end).toISOString());
  } catch (err) {
    logger.warn({ err }, '[UsageTelemetry] could not report LLM usage');
  }
}

/**
 * Report now, then every hour. Returns the timer so the caller can clear it on
 * shutdown; it is unref'd, so it never holds the process open. Returns
 * undefined, and reads nothing, when telemetry is off.
 */
export function startUsageTelemetry(agentId: string): NodeJS.Timeout | undefined {
  if (!isTelemetryEnabled()) return undefined;
  void reportClosedHours(agentId);
  const timer = setInterval(() => void reportClosedHours(agentId), HOUR_MS);
  timer.unref?.();
  return timer;
}
