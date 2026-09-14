import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createApp } from './server';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'agent-runtime',
    });
    expect(res.body.timestamp).toBeDefined();
  });
});

describe('the SPA fallback', () => {
  let tmp: string;
  let saved: string | undefined;

  /**
   * A web dir under a dot segment, which is the shape every install has: an
   * installed binary serves `~/.prism/web`, and a git worktree's copy sits
   * under `.claude/`.
   */
  beforeEach(() => {
    saved = process.env.PRISM_WEB_DIR;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-spa-test-'));
    const webDir = path.join(tmp, '.prism', 'web');
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html>SPA</html>');
    process.env.PRISM_WEB_DIR = webDir;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.PRISM_WEB_DIR;
    else process.env.PRISM_WEB_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(['/', '/activity', '/chat', '/plugins/costs'])(
    'serves the SPA at %s',
    async (route) => {
      // `send` refuses a path holding a dot segment, so without an explicit
      // allowance every one of these but `/` answered 404 on a hard refresh —
      // `/` only worked because the static mount serves its own index.
      const res = await request(createApp()).get(route);
      expect(res.status).toBe(200);
      expect(res.text).toContain('SPA');
    },
  );

  it('leaves the API prefixes to their own routers', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.body).toMatchObject({ status: 'ok' });
  });
});
