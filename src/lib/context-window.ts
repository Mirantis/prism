/**
 * Resolve a model ID to its input-context window, for the context-window
 * indicator.
 *
 * Why models.dev is the source: the window is not discoverable from either
 * provider this runtime talks to. Anthropic's Models API — the only source of
 * `max_input_tokens` — is first-party only (unavailable on both Bedrock and
 * Microsoft Foundry), and Bedrock's `GetFoundationModel` returns modalities and
 * lifecycle but no context length.
 *
 * This module is a pure resolver; `lib/model-catalog.ts` owns the data as two
 * layers — a bundled floor that always answers, plus an overlay fetched once at
 * boot when `MODELS_DEV_URL` opts into it, so a newly-released model isn't
 * unmeasurable until the next release. Reads here are synchronous, which is what
 * lets an unfinished refresh fall back to the floor for free.
 *
 * Unknown IDs return `null` rather than a guess. A wrong window silently
 * misreports how much room is left, which is worse than showing nothing — so
 * callers must render nothing when this returns `null`.
 */
import { config } from '../config';
import { modelCatalog } from './model-catalog';

export interface ContextWindow {
  /** Max input tokens the model accepts. */
  tokens: number;
}

/** One thread's context occupancy, as measured by a single turn. */
export interface ContextUsageSnapshot {
  threadId: string;
  /** The model that actually ran — may differ from the agent's configured model. */
  modelId: string;
  usedTokens: number;
  windowTokens: number;
  /**
   * Share of the window consumed, as an integer 0-100. Clamped, so an overflowing
   * prompt reads 100 rather than something above it.
   *
   * Emitted as *consumed* rather than remaining because that's what both clients
   * render, so neither needs arithmetic and the figure agrees exactly with the raw
   * token counts shown beside it.
   */
  usedPercent: number;
}

/**
 * Derive a snapshot from a raw measurement, or null when it can't be expressed
 * as a percentage (no measurement, or an unrecognized model).
 *
 * Pure, and deliberately lives here rather than on `ContextUsageService`: both
 * the live path and the stored-thread read path need it, and the service already
 * depends on `conversationService` — putting it there would make that a cycle.
 */
export function buildContextSnapshot(
  threadId: string,
  // Nullish rather than strictly `null`: Prisma returns null for the unset
  // columns, but callers reading partially-selected rows hand over undefined,
  // and a `=== null` guard would let that through into the arithmetic.
  modelId: string | null | undefined,
  usedTokens: number | null | undefined
): ContextUsageSnapshot | null {
  if (!modelId || typeof usedTokens !== 'number' || !Number.isFinite(usedTokens)) return null;

  const window = contextWindowFor(modelId);
  if (!window) return null;

  const usedPercent = Math.round((100 * usedTokens) / window.tokens);
  return {
    threadId,
    modelId,
    usedTokens,
    windowTokens: window.tokens,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
  };
}

/**
 * Bedrock cross-region inference profiles prefix the model ID with a geo scope
 * (`us.`, `eu.`, `au.`, `jp.`, `global.`). models.dev lists most of these
 * explicitly, but new geos appear before the registry catches up, so strip a
 * known prefix and retry rather than going dark on `sa.anthropic.claude-opus-5`.
 */
const REGION_PREFIX = /^(?:us|eu|apac|au|jp|ca|sa|global)\./;

/** Bedrock version suffixes (`-v1:0`, `-v2:1`, `-v1`) that some ID spellings omit. */
const VERSION_SUFFIX = /-v\d+(?::\d+)?$/;

/**
 * The input-context window for `modelId`, or `null` when it can't be determined.
 *
 * `modelId` must be the *resolved* model — what `invokeStream()` actually passed
 * to the provider — so per-agent and per-scope (heartbeat/cron) overrides are
 * covered without any scope-specific handling here.
 */
export function contextWindowFor(modelId: string): ContextWindow | null {
  if (!modelId) return null;

  // Validate rather than just null-check: an `undefined` or otherwise unusable
  // value here would divide into a NaN percentage and render as garbage. config.ts
  // already normalizes the env var, so this is belt-and-braces for any other
  // caller shape.
  const override = config.contextWindowTokens;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return { tokens: override };
  }

  // Read the catalog once: it's the bundled floor plus any overlay the boot-time
  // refresh installed, already merged, so this is a plain property read.
  const catalog = modelCatalog();

  // Prefer the active provider's own entry. Every `context` value in the bundled
  // floor happens to agree across providers and regions, so this preference is
  // not yet observable there — but the registry tracks them separately and they
  // do diverge in practice (`au.anthropic.claude-sonnet-4-6` reports a 128k
  // output cap where every other region reports 64k), and a remote overlay can
  // introduce a context divergence at any time.
  const preferred = catalog[config.llmProvider];
  const others = Object.entries(catalog)
    .filter(([provider]) => provider !== config.llmProvider)
    .map(([, models]) => models);

  for (const candidate of idCandidates(modelId)) {
    // Exact provider match first, then the other provider(s) as a fallback —
    // an operator can point LLM_PROVIDER=azure at a Bedrock-style ID.
    for (const models of [preferred, ...others]) {
      const hit = models?.[candidate];
      // Source comes from the entry, not from a global "did the fetch work" flag:
      // after a successful refresh a model present only in the bundle must still
      // honestly report `snapshot`.
      if (hit) return { tokens: hit.context };
    }
  }

  return null;
}

/** `modelId` plus progressively-normalized spellings, most specific first. */
function idCandidates(modelId: string): string[] {
  const seen = new Set<string>();
  const bare = modelId.replace(REGION_PREFIX, '');

  for (const id of [
    modelId,
    bare,
    modelId.replace(VERSION_SUFFIX, ''),
    bare.replace(VERSION_SUFFIX, ''),
    // Azure deployment names are bare (`claude-opus-5`) while Bedrock IDs carry
    // an `anthropic.` vendor segment; try across that boundary too.
    bare.replace(/^anthropic\./, ''),
    bare.replace(/^anthropic\./, '').replace(VERSION_SUFFIX, ''),
  ]) {
    if (id) seen.add(id);
  }

  return [...seen];
}
