/**
 * Prism Plugins Routes
 *
 * GET  /agents/prism-plugins                    — every loaded plugin, with its
 *      revision and diagnostics. The web UI reads this to build its navigation.
 * GET  /agents/prism-plugins/:id/page.js        — the built page module, imported
 *      by the SPA. The `rev` query parameter is the plugin's revision, so a
 *      changed page cannot be served from a browser cache.
 * GET  /agents/prism-plugins/:id/asset/*       — files from the plugin's `public/`.
 * ALL  /agents/prism-plugins/:id/api/*         — the plugin's own routes.
 *
 * Everything sits under `/agents` because the SPA's catch-all in `server.ts`
 * excludes that prefix and the Vite dev proxy forwards it. A new top-level path
 * would need an edit in both.
 *
 * `createApp()` runs before the plugins load, so each handler resolves its
 * plugin per request. A request that arrives before loading finishes gets a 503
 * rather than a 404, which is a different problem with a different fix.
 *
 * Auth is terminated by the platform in front of the container, as for every
 * other route. A plugin's routes inherit that: they are reachable by anything
 * that can reach the runtime.
 */

import express, { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../logger';
import { prismPluginService } from '../services/prism-plugins/prism-plugin.service';
import type { PrismPluginResponse, PrismPluginRoute } from '../services/prism-plugins/types';

const router = Router();

/**
 * The `:id` path parameter. Express types a parameter as `string | string[]`
 * because a pattern may name one twice; every path here names `:id` once.
 */
function pluginId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}

/**
 * One express router per plugin, built on first use from what the plugin
 * declared. A router rather than hand-matching, so a plugin's `/item/:id` gets
 * the same path handling every other route in this runtime has.
 */
const apiRouters = new Map<string, RequestHandler>();
const assetHandlers = new Map<string, RequestHandler>();

router.get('/prism-plugins', (_req: Request, res: Response) => {
  if (!prismPluginService.isReady()) {
    res.status(503).json({ error: 'Plugins are still loading.' });
    return;
  }
  res.json(prismPluginService.list());
});

/**
 * The built page module. Served as JavaScript with a long cache lifetime: the
 * URL carries the revision, so a new build is a new URL and a stale one is
 * never asked for again.
 */
router.get('/prism-plugins/:id/page.js', (req: Request, res: Response) => {
  if (!prismPluginService.isReady()) {
    res.status(503).json({ error: 'Plugins are still loading.' });
    return;
  }
  const id = pluginId(req);
  const pagePath = prismPluginService.pagePath(id);
  if (!pagePath) {
    res.status(404).json({ error: `No page is built for plugin "${id}".` });
    return;
  }
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // `dotfiles: 'allow'` because the data dir is `~/.prism` on a native install
  // and in local development, and `send` refuses any path holding a dot
  // segment. The path is one the runtime built, not one a request supplied.
  res.sendFile(pagePath, { dotfiles: 'allow' }, (error) => {
    if (!error || res.headersSent) return;
    logger.warn({ err: error }, `[PrismPlugins] could not send the page for "${id}"`);
    res.status(500).json({ error: 'Could not read the built page.' });
  });
});

/** Files the plugin ships in `public/`. */
router.use('/prism-plugins/:id/asset', (req: Request, res: Response, next: NextFunction) => {
  const id = pluginId(req);
  let handler = assetHandlers.get(id);
  if (!handler) {
    const dir = prismPluginService.publicDir(id);
    if (!dir) {
      res.status(404).json({ error: `Plugin "${id}" ships no public files.` });
      return;
    }
    // `index: false` — a plugin's asset directory is a file store, and serving
    // an index.html from it would give plugin-authored markup its own page
    // outside the SPA. Dotfiles keep the default refusal: the root is resolved
    // before that check, so a `~/.prism` root is fine, and the check then covers
    // the request path, where a dotfile is a request not worth serving.
    handler = express.static(dir, { index: false, fallthrough: false });
    assetHandlers.set(id, handler);
  }
  handler(req, res, next);
});

/** The plugin's own routes. */
router.use('/prism-plugins/:id/api', (req: Request, res: Response, next: NextFunction) => {
  const id = pluginId(req);
  if (!prismPluginService.isReady()) {
    res.status(503).json({ error: 'Plugins are still loading.' });
    return;
  }
  let handler = apiRouters.get(id);
  if (!handler) {
    const routes = prismPluginService.routes(id);
    if (!routes) {
      res.status(404).json({ error: `Plugin "${id}" is not loaded.` });
      return;
    }
    handler = buildApiRouter(id, routes);
    apiRouters.set(id, handler);
  }
  handler(req, res, next);
});

/**
 * Turn a plugin's declarations into a router. A handler that throws answers 500
 * with its message: the page that called it is the plugin's own, so its author
 * is the one who needs to read the error.
 */
function buildApiRouter(id: string, routes: PrismPluginRoute[]): RequestHandler {
  const sub = Router();

  for (const route of routes) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    sub[method](route.path, async (req: Request, res: Response) => {
      try {
        const result = await route.handler({
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string | string[] | undefined>,
          body: req.body,
        });
        send(res, result);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ err: error }, `[PrismPlugin:${id}] ${route.method} ${route.path} failed`);
        if (!res.headersSent) res.status(500).json({ error: msg });
      }
    });
  }

  sub.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Plugin "${id}" declares no route for ${req.method} ${req.path}.` });
  });

  return sub;
}

/**
 * Send whatever a handler returned. A `{ status, headers, body }` object sets
 * those; anything else is the body. `undefined` is 204, so a handler that only
 * acts needs no return value.
 */
function send(res: Response, result: unknown): void {
  if (result === undefined) {
    res.status(204).end();
    return;
  }
  if (isPluginResponse(result)) {
    const { status, headers, body } = result;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    }
    res.status(status ?? 200);
    if (body === undefined) {
      res.end();
      return;
    }
    res.json(body);
    return;
  }
  res.json(result);
}

/**
 * A response envelope, told from a plain result by its keys. A handler returning
 * data that happens to hold a `status` field is the case this has to get right,
 * so every key must be one of the three and at least one must be present.
 */
function isPluginResponse(value: unknown): value is PrismPluginResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((k) => k === 'status' || k === 'headers' || k === 'body');
}

export { router as prismPluginsRouter };
export const __test = { isPluginResponse };
