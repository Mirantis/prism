/**
 * The model catalog: which input-context window each model has, and what its
 * tokens cost.
 *
 * Two layers. The **bundled floor** (`model-limits.generated.json`, vendored from
 * models.dev by `src/scripts/generate-model-limits.ts`) is always present and
 * always sufficient on its own. A **remote overlay** from `MODELS_DEV_URL`
 * (models.dev unless an operator sets `off`) is fetched at boot and once a day
 * (`services/model-catalog-refresh.ts`), so a model released or repriced since
 * the last build gets a real window and price.
 *
 * Why models.dev is the source at all: none of the providers this runtime talks
 * to report a context window. Anthropic's Models API — the only source of
 * `max_input_tokens` — is first-party only, unavailable on both Bedrock and
 * Microsoft Foundry; Bedrock's `GetFoundationModel` returns modalities and
 * lifecycle but no context length; and OpenAI's model listing has no limit
 * fields either.
 *
 * Invariants the rest of the runtime depends on:
 * - **Reads are synchronous and always answerable.** `modelCatalog()` never
 *   returns empty and never awaits, which is what makes "fall back to the bundle
 *   while the fetch is in flight" free rather than something to engineer.
 * - **The overlay merges, never replaces.** A degraded payload can add or update
 *   an entry but can never lose one, per provider.
 * - **The imported JSON is never mutated.** It's a module singleton shared with
 *   anything else that imports it (the e2e steps do), so every copy and merge
 *   allocates fresh objects.
 *
 * One boundary worth stating, because the safety analysis rests on it: a window
 * size from here reaches a percentage on a screen, a column in the database, and
 * exactly one programmatic consumer — the auto-compaction trigger
 * (`compactionService.maybeAutoCompact`, which fires when occupancy ≥
 * COMPACTION_THRESHOLD_PERCENT of the window) — and **never a prompt**. The
 * registry is community-maintained and its model IDs are lookup keys only, never
 * echoed into model input; the compaction prompt is fixed text, so a wrong or
 * hostile window still cannot *steer* the model. What it can now do is cause
 * spurious or suppressed compactions, and that blast radius is deliberately
 * bounded: `CONTEXT_WINDOW_TOKENS` (operator-set) wins over the registry;
 * windows under `MIN_PLAUSIBLE_CONTEXT` are rejected outright (a tiny window
 * would otherwise force compaction on every turn); the newest tail messages are
 * always preserved and nothing is deleted (originals stay in the DB); and the
 * nothing-to-compact + once-per-exchange guards cap the damage at wasted
 * summarize calls. A price from here reaches the spending estimate alone.
 */
import { config } from '../config';
import { logger } from '../logger';
import { getProxyDispatcher } from './proxy-dispatcher';
import { trackEvent } from './telemetry';
import bundled from './model-limits.generated.json';

/** A model's prices, in US dollars per million tokens, as models.dev lists them. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputAudio?: number;
  outputAudio?: number;
  /** Higher prices for a prompt above `above` tokens, lowest threshold first. */
  tiers?: PriceTier[];
}

export interface PriceTier {
  above: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CatalogEntry {
  /** Max input tokens the model accepts. */
  context: number;
  output: number | null;
  /** Absent where models.dev lists no price. */
  cost?: ModelPrice;
}

/** Provider (`bedrock` | `azure` | `openai` | `anthropic`) -> model ID -> limits. */
export type ModelCatalog = Record<string, Record<string, CatalogEntry | undefined> | undefined>;

export type CatalogState =
  /** No refresh configured — the bundled floor is the whole story. */
  | 'disabled'
  /** A refresh is in flight; reads are served from the current catalog. */
  | 'pending'
  /** No refresh has run (or none will) and the floor is current. */
  | 'bundled'
  /** A remote overlay is installed. */
  | 'remote'
  /** A refresh ran and did not produce a usable overlay. */
  | 'failed';

/**
 * models.dev provider id -> the `LLM_PROVIDER` value it serves. Shared with the
 * generator so the two can't drift on which providers are in scope.
 */
export const REGISTRY_PROVIDERS: Record<string, string> = {
  'amazon-bedrock': 'bedrock',
  azure: 'azure',
  openai: 'openai',
  anthropic: 'anthropic',
};

/**
 * The model family each registry provider contributes, scoped per provider:
 * on the Claude-serving vendors only Claude models reach `invokeStream()`,
 * and azure's registry entry lists plenty of GPT models that would be noise
 * in that bucket — while the `openai` bucket exists precisely for GPT (and
 * o-series/codex) ids and would find no Claude there.
 */
const CLAUDE = /claude|fable|mythos/i;
const OPENAI_FAMILY = /^gpt|^o\d|^codex/i;
const REGISTRY_FAMILY: Record<string, RegExp> = {
  'amazon-bedrock': CLAUDE,
  azure: CLAUDE,
  openai: OPENAI_FAMILY,
  anthropic: CLAUDE,
};

/**
 * Smallest window we'll believe. The generator historically accepted anything
 * `> 0`, but a handful-of-tokens window renders "100% context used" forever — the
 * exact "a wrong number is worse than none" failure the indicator exists to
 * avoid. Shared with the generator so both layers reject the same nonsense.
 */
export const MIN_PLAUSIBLE_CONTEXT = 1_000;

/** Beyond this ratio to the bundled value, a remote entry is worth a warning. */
const DIVERGENCE_FACTOR = 2;

interface RegistryTier {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  tier?: { type?: unknown; size?: unknown };
}

export interface RegistryModel {
  limit?: { context?: number; output?: number };
  cost?: {
    input?: unknown;
    output?: unknown;
    cache_read?: unknown;
    cache_write?: unknown;
    input_audio?: unknown;
    output_audio?: unknown;
    tiers?: unknown;
  };
}

/**
 * True when a registry entry is in its provider's model family (see
 * REGISTRY_FAMILY) with a believable window.
 */
export function isUsableRegistryEntry(id: string, model: RegistryModel, registryId: string): boolean {
  const family = REGISTRY_FAMILY[registryId];
  if (!family || !family.test(id)) return false;
  const context = model.limit?.context;
  return typeof context === 'number' && Number.isFinite(context) && context >= MIN_PLAUSIBLE_CONTEXT;
}

/** A registry price field, or undefined when it is not a usable rate. */
function rate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The rate fields that are present, so an absent one stays absent in the JSON. */
function rates(fields: Record<string, number | undefined>): Record<string, number> {
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, number] => entry[1] !== undefined));
}

/** A registry entry's price, or undefined when it lists no input and output rate. */
function priceOf(cost: RegistryModel['cost']): ModelPrice | undefined {
  const input = rate(cost?.input);
  const output = rate(cost?.output);
  if (input === undefined || output === undefined) return undefined;

  const tiers = (Array.isArray(cost?.tiers) ? (cost.tiers as RegistryTier[]) : [])
    .flatMap((tier): PriceTier[] => {
      const above = rate(tier?.tier?.size);
      const tierInput = rate(tier?.input);
      const tierOutput = rate(tier?.output);
      if (tier?.tier?.type !== 'context' || above === undefined || tierInput === undefined || tierOutput === undefined) {
        return [];
      }
      return [{
        above,
        input: tierInput,
        output: tierOutput,
        ...rates({ cacheRead: rate(tier.cache_read), cacheWrite: rate(tier.cache_write) }),
      }];
    })
    .sort((a, b) => a.above - b.above);

  return {
    input,
    output,
    ...rates({
      cacheRead: rate(cost?.cache_read),
      cacheWrite: rate(cost?.cache_write),
      inputAudio: rate(cost?.input_audio),
      outputAudio: rate(cost?.output_audio),
    }),
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

/** The catalog entry for a usable registry entry. Shared with the generator. */
export function catalogEntryOf(model: RegistryModel): CatalogEntry {
  const cost = priceOf(model.cost);
  return { context: model.limit!.context!, output: model.limit?.output ?? null, ...(cost ? { cost } : {}) };
}

/**
 * Copy the imported JSON into our own objects. A plain reference would hand the
 * module singleton to every caller of `bundledModelCatalog()`, and the merge in
 * `installRemoteCatalog` must not be able to reach it.
 */
function copy(raw: Record<string, Record<string, CatalogEntry> | undefined>): ModelCatalog {
  return structuredClone(raw) as ModelCatalog;
}

const bundledCatalog: ModelCatalog = copy(bundled as Record<string, Record<string, CatalogEntry>>);

let effective: ModelCatalog = bundledCatalog;
let state: CatalogState = 'bundled';

/** The catalog to resolve against. Synchronous; never empty. */
export function modelCatalog(): ModelCatalog {
  return effective;
}

/** The bundled floor, for tests and for diffing an overlay against it. */
export function bundledModelCatalog(): ModelCatalog {
  return bundledCatalog;
}

export function modelCatalogState(): CatalogState {
  return state;
}

/**
 * Bedrock cross-region inference profiles prefix the model ID with a geo scope
 * (`us.`, `eu.`, `au.`, `jp.`, `global.`). models.dev lists most of these
 * explicitly, but new geos appear before the registry catches up, so strip a
 * known prefix and retry rather than going dark on `sa.anthropic.claude-opus-5`.
 */
const REGION_PREFIX = /^(?:us|eu|apac|au|jp|ca|sa|in|global)\./;

/** Bedrock version suffixes (`-v1:0`, `-v2:1`, `-v1`) that some ID spellings omit. */
const VERSION_SUFFIX = /-v\d+(?::\d+)?$/;

/**
 * The catalog entry for `modelId`, or null when no spelling of it is listed.
 *
 * The active provider's own entry wins, since the registry tracks providers and
 * regions separately and their limits and prices differ; another provider's entry
 * for the same model is the fallback, so an operator can point `LLM_PROVIDER=azure`
 * at a Bedrock-style ID and a coding agent on another vendor still resolves.
 */
export function findCatalogEntry(modelId: string): CatalogEntry | null {
  if (!modelId) return null;
  const catalog = effective;
  const preferred = catalog[config.llmProvider];
  const others = Object.entries(catalog)
    .filter(([provider]) => provider !== config.llmProvider)
    .map(([, models]) => models);

  for (const candidate of idCandidates(modelId)) {
    for (const models of [preferred, ...others]) {
      const hit = models?.[candidate];
      if (hit) return hit;
    }
  }
  return null;
}

/** `modelId` plus progressively-normalized spellings, most specific first. */
function idCandidates(modelId: string): string[] {
  const seen = new Set<string>();
  // A context-size marker (`claude-opus-5-5[1m]`) and an OpenRouter-style vendor
  // segment (`anthropic/claude-opus-5`) are not part of any registry id.
  const plain = modelId.replace(/\[[^\]]*\]$/, '').replace(/^[a-z0-9-]+\//, '');
  const bare = plain.replace(REGION_PREFIX, '');

  for (const id of [
    modelId,
    plain,
    bare,
    plain.replace(VERSION_SUFFIX, ''),
    bare.replace(VERSION_SUFFIX, ''),
    // Azure deployment names are bare (`claude-opus-5`) while Bedrock IDs carry
    // an `anthropic.` vendor segment; try across that boundary too. Bedrock names
    // OpenAI's models `openai.gpt-…`, which the `openai` provider lists bare.
    bare.replace(/^(?:anthropic|openai)\./, ''),
    bare.replace(/^(?:anthropic|openai)\./, '').replace(VERSION_SUFFIX, ''),
  ]) {
    if (id) seen.add(id);
  }

  return [...seen];
}

/**
 * Turn a raw models.dev payload into a provider-scoped catalog, or `null` when
 * it's unusable as a whole.
 *
 * Pure, and shared with `src/scripts/generate-model-limits.ts` so the filter
 * predicate cannot drift between build time and runtime. The two differ only in
 * error policy: the generator throws on shape drift, the runtime degrades.
 *
 * Tolerant per entry (a bad row is dropped) but strict per payload: if no
 * configured provider yields a single usable entry, the shape has drifted far
 * enough that installing it would do more harm than keeping the floor.
 */
export function reshapeRegistry(raw: unknown): ModelCatalog | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const registry = raw as Record<string, { models?: Record<string, RegistryModel> } | undefined>;

  const out: ModelCatalog = {};
  let total = 0;

  for (const [registryId, provider] of Object.entries(REGISTRY_PROVIDERS)) {
    const models = registry[registryId]?.models;
    if (!models || typeof models !== 'object') continue;

    const entries: Record<string, CatalogEntry> = {};
    for (const [id, model] of Object.entries(models)) {
      if (!model || typeof model !== 'object') continue;
      if (!isUsableRegistryEntry(id, model, registryId)) continue;
      entries[id] = catalogEntryOf(model);
      total++;
    }

    // A provider that yielded nothing is left absent rather than emitted empty,
    // so the merge leaves that provider entirely at its bundled values.
    if (Object.keys(entries).length > 0) out[provider] = entries;
  }

  return total > 0 ? out : null;
}

export interface InstallResult {
  /** Entries the bundle didn't have. */
  added: number;
  /** Entries whose context differs from the bundled value. */
  changed: number;
  /** Of those, ones differing by more than DIVERGENCE_FACTOR — worth a look. */
  diverged: number;
}

/**
 * Merge a remote catalog over the bundled floor and make it the effective one.
 *
 * Builds a fresh object rather than mutating: `contextWindowFor` runs per
 * `onStepFinish`, so the cost belongs here (once per boot) rather than on the
 * lookup path, and the bundled singleton must stay pristine.
 */
export function installRemoteCatalog(remote: ModelCatalog): InstallResult {
  const merged: ModelCatalog = {};
  const result: InstallResult = { added: 0, changed: 0, diverged: 0 };

  const providers = new Set([...Object.keys(bundledCatalog), ...Object.keys(remote)]);
  for (const provider of providers) {
    const floor = bundledCatalog[provider] ?? {};
    const overlay = remote[provider] ?? {};

    for (const [id, entry] of Object.entries(overlay)) {
      if (!entry) continue;
      const previous = floor[id];
      if (!previous) {
        result.added++;
      } else if (previous.context !== entry.context) {
        result.changed++;
        const ratio = entry.context / previous.context;
        if (ratio > DIVERGENCE_FACTOR || ratio < 1 / DIVERGENCE_FACTOR) result.diverged++;
      }
    }

    // Overlay wins per entry; anything only the floor has survives.
    merged[provider] = { ...floor, ...overlay };
  }

  effective = merged;
  return result;
}

/** Test-only: drop any installed overlay and return to the bundled floor. */
export function resetModelCatalog(): void {
  effective = bundledCatalog;
  state = 'bundled';
  controller = undefined;
}

// ============================================================================
// The boot-time refresh
// ============================================================================

/**
 * models.dev answers in ~0.4 s, so 5 s is >10x headroom. Past that it is almost
 * certainly a blocked egress path rather than a slow one, and waiting longer buys
 * nothing — the bundled floor is already serving every lookup. Keeping it short
 * also bounds how long a SIGTERM during boot has to wait on a dangling socket.
 */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Refuse to buffer a pathological body. The real payload is ~3.3 MB uncompressed
 * (~314 KB on the wire); 16 MB is generous headroom that still protects a
 * memory-capped container from an unbounded read.
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type FailureKind = 'timeout' | 'http' | 'network' | 'parse' | 'shape';

/** Why the payload was unusable — reported as an enum, never as raw error text. */
class RejectedPayload extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}

let controller: AbortController | undefined;

/**
 * Fetch models.dev once and install the result as an overlay. Answers the overlay
 * it installed, or null.
 *
 * **Total — never rejects.** Every failure keeps the catalog that was already
 * serving lookups, so there is nothing for a caller to handle.
 */
export async function refreshModelCatalog(): Promise<ModelCatalog | null> {
  const url = config.modelsDevUrl;
  if (!url) {
    state = 'disabled';
    logger.info('[ModelCatalog] MODELS_DEV_URL is off; using the bundled catalog');
    return null;
  }

  state = 'pending';
  const startedAt = Date.now();
  controller = new AbortController();

  try {
    // One composed signal, so there is no timer of our own to clear.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
    const remote = await fetchRegistry(url, signal);
    const counts = installRemoteCatalog(remote);
    state = 'remote';

    const perProvider = Object.entries(remote)
      .map(([provider, models]) => `${provider}=${Object.keys(models ?? {}).length}`)
      .join(' ');
    logger.info(
      `[ModelCatalog] refreshed from models.dev in ${Date.now() - startedAt}ms (${perProvider}, ${counts.added} new, ${counts.changed} changed)`,
    );
    if (counts.diverged > 0) {
      // Not rejected — a legitimate window upgrade (200k -> 1M) is a 5x jump, so a
      // rejection band would block the main thing this feature is for. Surfaced so
      // a bad upstream edit is at least visible rather than silent.
      logger.warn(
        `[ModelCatalog] ${counts.diverged} model(s) diverge from the bundled catalog by more than 2x; regenerate the snapshot to review`,
      );
    }

    emitOutcome('remote', startedAt, { remote, counts });
    return remote;
  } catch (err) {
    // Our own abort means shutdown, which is not an outcome worth reporting.
    if (err instanceof Error && err.name === 'AbortError') {
      state = 'bundled';
      logger.debug('[ModelCatalog] refresh canceled');
      return null;
    }

    state = 'failed';
    if (err instanceof RejectedPayload) {
      logger.warn(`[ModelCatalog] models.dev payload rejected (${err.message}); keeping the current catalog`);
      emitOutcome(err.kind === 'shape' || err.kind === 'parse' ? 'rejected' : 'failed', startedAt, {
        kind: err.kind,
      });
      return null;
    }

    const kind: FailureKind = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network';
    logger.warn({ err }, '[ModelCatalog] refresh failed; keeping the current catalog');
    emitOutcome('failed', startedAt, { kind });
    return null;
  } finally {
    controller = undefined;
  }
}

/** Abort an in-flight refresh. Safe to call when none is running. */
export function cancelModelCatalogRefresh(): void {
  controller?.abort();
  controller = undefined;
}

async function fetchRegistry(url: string, signal: AbortSignal): Promise<ModelCatalog> {
  // Loose shape: `dispatcher` is an undici extension to fetch's init that the two
  // bundled Dispatcher type copies (undici vs undici-types) disagree on.
  const init: Record<string, unknown> = { signal, headers: { accept: 'application/json' } };
  const dispatcher = await getProxyDispatcher();
  if (dispatcher) init.dispatcher = dispatcher;

  const res = await fetch(url, init as RequestInit);
  if (!res.ok) throw new RejectedPayload('http', `HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RejectedPayload('http', `body declares ${declared} bytes`);
  }

  // Not paranoia: a captive portal or proxy interstitial answers HTTP 200 with
  // HTML, which would otherwise reach JSON.parse as a confusing syntax error.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new RejectedPayload('shape', `content-type ${contentType || 'absent'}`);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new RejectedPayload('parse', 'body is not valid JSON');
  }

  const reshaped = reshapeRegistry(raw);
  if (!reshaped) throw new RejectedPayload('shape', 'no usable models for any configured provider');
  return reshaped;
}

function emitOutcome(
  outcome: 'remote' | 'failed' | 'rejected',
  startedAt: number,
  detail: { remote?: ModelCatalog; counts?: InstallResult; kind?: FailureKind },
): void {
  // No isTelemetryEnabled() guard needed — trackEvent no-ops without an OTel
  // logger, and unlike the boot census these props are already in hand.
  //
  // Known drop: a very fast shutdown can settle this after shutdownTelemetry(),
  // losing the event. Acceptable; don't go hunting for it.
  trackEvent('model catalog refreshed', null, {
    'catalog.outcome': outcome,
    'catalog.duration_ms': String(Date.now() - startedAt),
    ...(detail.remote
      ? Object.fromEntries(
          Object.entries(detail.remote).map(([provider, models]) => [
            `catalog.entries_${provider}`,
            String(Object.keys(models ?? {}).length),
          ]),
        )
      : {}),
    ...(detail.counts
      ? {
          'catalog.new_entries': String(detail.counts.added),
          'catalog.changed_entries': String(detail.counts.changed),
          'catalog.diverged_entries': String(detail.counts.diverged),
        }
      : {}),
    // A closed enum, never the raw error message — an undici error can embed the
    // proxy URL, and no URLs belong in telemetry.
    ...(detail.kind ? { 'catalog.failure_kind': detail.kind } : {}),
  });
}
