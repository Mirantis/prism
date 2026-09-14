/**
 * Prism Plugins Route Tests
 *
 * Supertest against the router with the service stubbed, so these cover the
 * transport alone: the pre-load 503, dispatch to a plugin's own routes, the
 * response envelope, and what a request for something absent gets.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PrismPluginRoute } from '../services/prism-plugins/types';

const service = {
  isReady: vi.fn(() => true),
  list: vi.fn(() => [] as unknown[]),
  pagePath: vi.fn((_id: string) => undefined as string | undefined),
  publicDir: vi.fn((_id: string) => undefined as string | undefined),
  routes: vi.fn((_id: string) => undefined as PrismPluginRoute[] | undefined),
};

vi.mock('../services/prism-plugins/prism-plugin.service', () => ({
  prismPluginService: service,
}));

const { prismPluginsRouter, __test } = await import('./prism-plugins');

/**
 * A fresh app per test. The router caches a per-plugin sub-router on first use,
 * and that cache is module-level — so each test uses its own plugin id.
 */
function app() {
  const a = express();
  a.use(express.json());
  a.use('/agents', prismPluginsRouter);
  return a;
}

beforeEach(() => {
  service.isReady.mockReturnValue(true);
  service.list.mockReturnValue([]);
  service.pagePath.mockReturnValue(undefined);
  service.publicDir.mockReturnValue(undefined);
  service.routes.mockReturnValue(undefined);
});

describe('GET /agents/prism-plugins', () => {
  it('answers the catalog', async () => {
    service.list.mockReturnValue([{ id: 'costs', name: 'costs' }]);
    const res = await request(app()).get('/agents/prism-plugins');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'costs', name: 'costs' }]);
  });

  it('answers 503 before the plugins have loaded', async () => {
    service.isReady.mockReturnValue(false);
    const res = await request(app()).get('/agents/prism-plugins');
    // Not a 404: "still loading" and "no such plugin" are different problems
    // with different fixes.
    expect(res.status).toBe(503);
  });
});

describe('GET /agents/prism-plugins/:id/page.js', () => {
  it('sends the built module as JavaScript', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-route-'));
    const file = path.join(tmp, 'page.js');
    fs.writeFileSync(file, 'export default () => null;');
    service.pagePath.mockReturnValue(file);

    const res = await request(app()).get('/agents/prism-plugins/costs/page.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.text).toContain('export default');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sends it from a path holding a dot segment', async () => {
    // The data dir is `~/.prism` on a native install and in local development,
    // so every real page path has a dot segment in it — and `send` refuses
    // those by default. A temp dir without one hid this until a real run.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-route-'));
    const dotted = path.join(tmp, '.prism', 'prism-plugin-build', 'costs');
    fs.mkdirSync(dotted, { recursive: true });
    const file = path.join(dotted, 'page.js');
    fs.writeFileSync(file, 'export default () => null;');
    service.pagePath.mockReturnValue(file);

    const res = await request(app()).get('/agents/prism-plugins/costs/page.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('export default');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('answers 404 for a plugin with no built page', async () => {
    const res = await request(app()).get('/agents/prism-plugins/absent/page.js');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('absent');
  });
});

describe('a plugin’s own routes', () => {
  it('dispatches to the declared handler', async () => {
    service.routes.mockReturnValue([
      { method: 'GET', path: '/summary', handler: () => ({ total: 42 }) },
    ]);
    const res = await request(app()).get('/agents/prism-plugins/dispatch/api/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 42 });
  });

  it('gives the handler the path parameters', async () => {
    service.routes.mockReturnValue([
      { method: 'GET', path: '/item/:key', handler: (req) => ({ key: req.params.key }) },
    ]);
    const res = await request(app()).get('/agents/prism-plugins/params/api/item/compute');
    expect(res.body).toEqual({ key: 'compute' });
  });

  it('gives the handler the query and the body', async () => {
    service.routes.mockReturnValue([
      { method: 'POST', path: '/echo', handler: (req) => ({ q: req.query, b: req.body }) },
    ]);
    const res = await request(app())
      .post('/agents/prism-plugins/qb/api/echo?a=1')
      .send({ hello: 'world' });
    expect(res.body).toEqual({ q: { a: '1' }, b: { hello: 'world' } });
  });

  it('honours a response envelope', async () => {
    service.routes.mockReturnValue([
      {
        method: 'POST',
        path: '/made',
        handler: () => ({ status: 201, headers: { 'x-thing': 'yes' }, body: { id: 7 } }),
      },
    ]);
    const res = await request(app()).post('/agents/prism-plugins/envelope/api/made');
    expect(res.status).toBe(201);
    expect(res.headers['x-thing']).toBe('yes');
    expect(res.body).toEqual({ id: 7 });
  });

  it('answers 204 when the handler returns nothing', async () => {
    service.routes.mockReturnValue([
      { method: 'POST', path: '/act', handler: () => undefined },
    ]);
    const res = await request(app()).post('/agents/prism-plugins/void/api/act');
    expect(res.status).toBe(204);
  });

  it('answers 500 with the message when a handler throws', async () => {
    service.routes.mockReturnValue([
      {
        method: 'GET',
        path: '/boom',
        handler: () => {
          throw new Error('deliberate failure');
        },
      },
    ]);
    const res = await request(app()).get('/agents/prism-plugins/boom/api/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('deliberate failure');
  });

  it('answers 404 for a path the plugin does not declare', async () => {
    service.routes.mockReturnValue([
      { method: 'GET', path: '/summary', handler: () => ({}) },
    ]);
    const res = await request(app()).get('/agents/prism-plugins/undeclared/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('undeclared');
  });

  it('answers 404 for a plugin that is not loaded', async () => {
    const res = await request(app()).get('/agents/prism-plugins/missing/api/anything');
    expect(res.status).toBe(404);
  });

  it('answers 503 before the plugins have loaded', async () => {
    service.isReady.mockReturnValue(false);
    const res = await request(app()).get('/agents/prism-plugins/pending/api/x');
    expect(res.status).toBe(503);
  });
});

describe('a plugin’s static files', () => {
  it('serves a file from public/', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-asset-'));
    fs.writeFileSync(path.join(tmp, 'note.txt'), 'hello');
    service.publicDir.mockReturnValue(tmp);

    const res = await request(app()).get('/agents/prism-plugins/assets/asset/note.txt');
    expect(res.status).toBe(200);
    expect(res.text).toBe('hello');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves an asset from a root holding a dot segment', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-asset-'));
    const dotted = path.join(tmp, '.prism', 'prism-plugins', 'costs', 'public');
    fs.mkdirSync(dotted, { recursive: true });
    fs.writeFileSync(path.join(dotted, 'note.txt'), 'hello');
    service.publicDir.mockReturnValue(dotted);

    const res = await request(app()).get('/agents/prism-plugins/dotted-assets/asset/note.txt');
    expect(res.status).toBe(200);
    expect(res.text).toBe('hello');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses a dotfile a plugin ships, which is not a request worth serving', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-dotfile-'));
    fs.writeFileSync(path.join(tmp, '.env'), 'SECRET=1');
    service.publicDir.mockReturnValue(tmp);

    const res = await request(app()).get('/agents/prism-plugins/dotfile/asset/.env');
    expect(res.status).toBe(404);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('answers 404 for a plugin with no public dir', async () => {
    const res = await request(app()).get('/agents/prism-plugins/bare/asset/note.txt');
    expect(res.status).toBe(404);
  });
});

describe('telling a response envelope from a plain result', () => {
  const { isPluginResponse } = __test;

  it('reads an envelope as one', () => {
    expect(isPluginResponse({ status: 201 })).toBe(true);
    expect(isPluginResponse({ status: 201, body: {}, headers: {} })).toBe(true);
  });

  it('reads data that merely holds a status field as a body', () => {
    // The case this has to get right: a handler answering with a record whose
    // own shape includes `status` must not have it read as an HTTP status.
    expect(isPluginResponse({ status: 'running', name: 'job' })).toBe(false);
  });

  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['null', null],
    ['a string', 'ok'],
    ['a number', 7],
  ])('reads %s as a body', (_label, value) => {
    expect(isPluginResponse(value)).toBe(false);
  });
});
