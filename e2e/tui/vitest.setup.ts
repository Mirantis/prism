/**
 * Worker-side hardening of Vitest's source-map symbolication.
 *
 * Runs in each worker fork (via `setupFiles`). The companion `globalSetup`
 * (`vitest.global-setup.ts`) applies the same patch to the main Vitest process,
 * where the reporter that formats the final failing stack trace runs. Both are
 * needed — see `harden-source-map.ts` for the full rationale.
 */
import { hardenSourceMapSymbolication } from './harden-source-map';

hardenSourceMapSymbolication();
