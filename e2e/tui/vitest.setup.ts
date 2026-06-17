/**
 * Harden Vitest's stack-trace symbolication against malformed inline
 * source-maps.
 *
 * When Vitest reports an error it symbolicates each stack frame by reading the
 * referenced file and extracting its inline `//# sourceMappingURL=data:…base64…`
 * map via `convert-source-map` (see `@vitest/utils/dist/source-map/node.js`:
 * `convertSourceMap.fromSource(code) || convertSourceMap.fromMapFileSource(…)`).
 * Intermittently — with the tsx-transpiled files this suite drives under PTY /
 * runtime teardown races — that base64 payload decodes to non-UTF8 bytes and
 * `JSON.parse` throws `SyntaxError: Unexpected token '…' is not valid JSON`.
 * The throw happens inside Vitest's reporter, surfaces as an *unhandled* error,
 * and fails an otherwise-green run (the harness already documents this crash —
 * see `harness.ts`).
 *
 * Fix: wrap the parse entrypoints on the shared `convert-source-map` singleton
 * so a malformed map degrades to `null` — which `extractSourcemapFromFile`
 * already treats as "no source map" via its `|| … ?.toObject()` — instead of
 * throwing. Only `SyntaxError` is swallowed; every other error re-throws, and
 * nothing here touches process-level handlers, so genuine unhandled product
 * errors during e2e still fail the run.
 *
 * We resolve the module via `createRequire` (not an `import`) so we patch the
 * exact hoisted instance `@vitest/utils` uses — adding our own copy could let
 * npm install a second one in the workspace that Vitest never touches. The
 * whole thing is best-effort: if the module can't be resolved or lacks the
 * expected shape, it's a no-op and the suite is unaffected.
 */
import { createRequire } from 'node:module';

type Parser = (...args: unknown[]) => unknown;

try {
  const require = createRequire(import.meta.url);
  const convertSourceMap = require('convert-source-map') as Record<string, Parser>;

  for (const name of ['fromSource', 'fromComment', 'fromMapFileSource'] as const) {
    const original = convertSourceMap[name];
    if (typeof original !== 'function') continue;
    convertSourceMap[name] = (...args: unknown[]) => {
      try {
        return original.apply(convertSourceMap, args);
      } catch (err) {
        if (err instanceof SyntaxError) return null;
        throw err;
      }
    };
  }
} catch {
  // convert-source-map not resolvable / unexpected shape — nothing to harden.
}
