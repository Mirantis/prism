/**
 * Keeps the model catalog current: the overlay the last refresh stored is installed
 * at boot, models.dev is fetched then and once a day, and each overlay that lands is
 * stored for the next boot. Calls recorded without a price are priced again after
 * every install, which also prices the calls recorded before prices existed.
 */

import { logger } from '../logger';
import { installRemoteCatalog, refreshModelCatalog, type ModelCatalog } from '../lib/model-catalog';
import { llmCallService } from './llm-call.service';
import { MODEL_CATALOG_OVERLAY, runtimeStateService } from './runtime-state.service';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function installStoredOverlay(): Promise<void> {
  try {
    const stored = await runtimeStateService.get(MODEL_CATALOG_OVERLAY);
    if (stored) installRemoteCatalog(JSON.parse(stored) as ModelCatalog);
  } catch (err) {
    logger.warn({ err }, '[ModelCatalog] could not read the stored catalog; using the bundled one');
  }
}

async function refresh(): Promise<void> {
  const remote = await refreshModelCatalog();
  if (!remote) return;
  try {
    await runtimeStateService.set(MODEL_CATALOG_OVERLAY, JSON.stringify(remote));
  } catch (err) {
    logger.warn({ err }, '[ModelCatalog] could not store the refreshed catalog');
  }
  await llmCallService.priceUnpricedCalls();
}

/**
 * Install the stored overlay, price what it can, then refresh now and every day.
 * Returns the unref'd timer for the caller to clear on shutdown. Never rejects.
 */
export async function startModelCatalogRefresh(): Promise<NodeJS.Timeout> {
  await installStoredOverlay();
  await llmCallService.priceUnpricedCalls();
  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  timer.unref();
  return timer;
}
