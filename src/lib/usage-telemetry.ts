/**
 * Usage Telemetry
 *
 * Single owner of the `llm usage aggregated` product event: the agent's model
 * calls, one event per closed UTC hour and model, read from `llm_calls`. Each
 * event covers `[period_start, period_end)` and carries counts only.
 *
 * `runtime_state` keeps the end of the last hour reported, written once the
 * collector has accepted the events. A pass reports every closed hour after it,
 * in windows of `WINDOW_HOURS`. With no mark stored, a pass reports the last window.
 * A crash or a failed export leaves the mark, so the same hours go out again
 * with the same period start.
 *
 * Provider and routing are read from config when an hour is reported, since one
 * process uses one vendor and one route. Hours reported after a restart that
 * changed `LLM_PROVIDER` or `NEXUS_API_URL` carry the new values.
 */

import { config } from '../config';
import { logger } from '../logger';
import { prisma } from './prisma';
import { flushTelemetry, isTelemetryEnabled, llmRouting, trackEvent } from './telemetry';
import { LLM_USAGE_REPORTED_THROUGH, runtimeStateService } from '../services/runtime-state.service';
import { OTHER_MODEL_PURPOSES } from '../services/llm-call.service';

const HOUR_MS = 60 * 60 * 1000;
/** How often a pass runs, so an hour goes out a few minutes after it closes. */
const PASS_INTERVAL_MS = 5 * 60 * 1000;
/** How long after its end an hour is read, so a call recorded just before the boundary is in. */
const SETTLE_MS = 60 * 1000;
/** The hours one read covers, which bounds the rows it holds. */
const WINDOW_HOURS = 24;

let passRunning = false;

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
export async function reportClosedHours(agentId: string): Promise<void> {
  // A catch-up on a slow collector can outlast the interval, and a second pass
  // would read the same mark and send the same windows again.
  if (passRunning) return;
  passRunning = true;
  try {
    const end = startOfHour(Date.now() - SETTLE_MS);
    const reportedThrough = await runtimeStateService.get(LLM_USAGE_REPORTED_THROUGH);
    let start = reportedThrough ? Date.parse(reportedThrough) : end - WINDOW_HOURS * HOUR_MS;
    while (start < end) {
      const windowEnd = Math.min(end, start + WINDOW_HOURS * HOUR_MS);
      if (!(await reportWindow(agentId, start, windowEnd))) return;
      start = windowEnd;
    }
  } catch (err) {
    logger.warn({ err }, '[UsageTelemetry] could not report LLM usage');
  } finally {
    passRunning = false;
  }
}

/**
 * Send the events of `[start, end)` and move the mark to `end`. Answers false,
 * with the mark left where it was, when the collector did not accept them.
 */
async function reportWindow(agentId: string, start: number, end: number): Promise<boolean> {
  // The agent's own model alone: the event names one provider, the one config gives.
  const rows = await prisma.llmCall.findMany({
    where: {
      agentId,
      createdAt: { gte: new Date(start), lt: new Date(end) },
      purpose: { notIn: [...OTHER_MODEL_PURPOSES] },
    },
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

  if (!(await flushTelemetry())) return false;
  await runtimeStateService.set(LLM_USAGE_REPORTED_THROUGH, new Date(end).toISOString());
  return true;
}

/**
 * Report now, then every `PASS_INTERVAL_MS`. Returns the timer so the caller can
 * clear it on shutdown; it is unref'd, so it never holds the process open.
 * Returns undefined, and reads nothing, when telemetry is off.
 */
export function startUsageTelemetry(agentId: string): NodeJS.Timeout | undefined {
  if (!isTelemetryEnabled()) return undefined;
  void reportClosedHours(agentId);
  const timer = setInterval(() => void reportClosedHours(agentId), PASS_INTERVAL_MS);
  timer.unref();
  return timer;
}
