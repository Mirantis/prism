/**
 * Regenerate `src/lib/model-limits.generated.json` from the models.dev registry.
 *
 * The runtime needs each model's input-context window to show how much context a
 * conversation has used, and each model's prices to estimate what the agent spends.
 * No provider it talks to exposes the window: Anthropic's Models API
 * (the only source of `max_input_tokens`) is first-party only, and Bedrock's
 * `GetFoundationModel` has no context-length field at all. So models.dev is the
 * source, and this script vendors it so the committed JSON is an always-available
 * floor — no network needed to resolve a window.
 *
 * The snapshot stays **provider-scoped and keyed by exact model ID**, never
 * flattened. The registry tracks each provider/region separately and they do
 * diverge — `au.anthropic.claude-sonnet-4-6` reports a 128000 output cap where
 * every other region reports 64000. Today every `context` value happens to agree,
 * so a merged map would produce the same answers; keeping them separate means a
 * future divergence is picked up by rerunning this script, not by debugging why
 * the indicator is wrong in one region.
 *
 * The registry data is MIT licensed by models.dev and recorded in
 * `THIRD_PARTY_NOTICES`. A regeneration must keep that entry.
 *
 * Run: `npm run generate:model-limits`, then commit the JSON diff.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
// Shared with the runtime so the filter predicate can't drift between build time
// and boot time. Only the error policy differs: this script throws on shape
// drift, the runtime degrades to the committed floor.
import {
  REGISTRY_PROVIDERS,
  catalogEntryOf,
  isUsableRegistryEntry,
  type CatalogEntry,
  type RegistryModel,
} from '../lib/model-catalog';

// `off` stops the runtime's own fetch, not this script's.
const configured = process.env.MODELS_DEV_URL?.trim();
const SOURCE = configured && configured.toLowerCase() !== 'off' ? configured : 'https://models.dev/api.json';
// Anchored on cwd rather than this file: npm scripts run from the repo root, and
// the compiled copy under `dist/scripts/` (which nobody runs) would resolve the
// wrong path from `__dirname`.
const OUT = path.resolve(process.cwd(), 'src', 'lib', 'model-limits.generated.json');

type Registry = Record<string, { models?: Record<string, RegistryModel> } | undefined>;
type Snapshot = Record<string, Record<string, CatalogEntry>>;

async function main(): Promise<void> {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${SOURCE} returned ${res.status} ${res.statusText}`);
  const registry = (await res.json()) as Registry;

  const snapshot: Snapshot = {};
  for (const [registryId, provider] of Object.entries(REGISTRY_PROVIDERS)) {
    const models = registry[registryId]?.models;
    if (!models) {
      throw new Error(`models.dev has no "${registryId}" provider — did the registry shape change?`);
    }

    const entries = Object.entries(models)
      // Shared predicate: the provider's model family, believable context
      // window. A row that fails it would render as a bogus percentage, so
      // it's dropped rather than written out.
      .filter(([id, model]) => isUsableRegistryEntry(id, model, registryId))
      // Sort so the committed file has a stable, reviewable diff.
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, model]) => [id, catalogEntryOf(model)] as const);

    if (entries.length === 0) throw new Error(`no usable models found under "${registryId}"`);
    snapshot[provider] = Object.fromEntries(entries);
  }

  writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);

  const counts = Object.entries(snapshot)
    .map(([provider, models]) => `${provider}=${Object.keys(models).length}`)
    .join(' ');
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${counts})`);
}

// Unlike the runtime — which must degrade to the bundled floor — this script
// should fail loudly and leave the committed JSON untouched.
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
