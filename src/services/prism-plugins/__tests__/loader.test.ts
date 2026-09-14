/**
 * Prism Plugin Loader Tests
 *
 * Every declaration a plugin returns is checked before it is accepted. A plugin
 * is written from a prompt, so a route with no handler or a tool with no
 * description is a likely first draft — and each has to become a message on the
 * plugin's own page rather than a throw that takes the runtime with it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadPluginServer, __test } from '../loader';
import type { PrismPluginContext } from '../types';

let tmp: string;

const ctx: PrismPluginContext = {
  id: 'costs',
  dataDir: '/tmp/costs-data',
  pluginDir: '/tmp/costs',
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  agent: {} as PrismPluginContext['agent'],
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-loader-test-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Write a module and import it. A unique filename per call, since Node caches a
 * module by URL and a test's module must not be answered from an earlier one.
 */
let counter = 0;
async function load(source: string) {
  const file = path.join(tmp, `server-${counter++}.mjs`);
  fs.writeFileSync(file, source);
  return loadPluginServer(file, ctx);
}

describe('the module contract', () => {
  it('collects routes, tools and jobs', async () => {
    const loaded = await load(`export default function plugin(ctx) {
  return {
    routes: [{ method: 'GET', path: '/summary', handler: () => ({ ok: true }) }],
    tools: [{ name: 'summary', description: 'A summary.', execute: () => ({}) }],
    jobs: [{ name: 'refresh', schedule: '0 * * * *', run: () => undefined }],
  };
}
`);

    expect(loaded.errors).toEqual([]);
    expect(loaded.routes).toHaveLength(1);
    expect(loaded.jobs).toHaveLength(1);
    // Namespaced by plugin id, so two plugins may both declare `summary`.
    expect(Object.keys(loaded.tools)).toEqual(['costs__summary']);
  });

  it('accepts an async factory', async () => {
    const loaded = await load(`export default async function plugin() {
  return { routes: [{ method: 'GET', path: '/x', handler: () => 1 }] };
}
`);
    expect(loaded.errors).toEqual([]);
    expect(loaded.routes).toHaveLength(1);
  });

  it('accepts a factory that declares nothing', async () => {
    const loaded = await load(`export default function plugin() { return {}; }\n`);
    expect(loaded.errors).toEqual([]);
    expect(loaded.routes).toEqual([]);
  });

  it('reports a module with no default export', async () => {
    const loaded = await load(`export const plugin = () => ({});\n`);
    expect(loaded.errors[0]).toContain('default-export a function');
    expect(loaded.routes).toEqual([]);
  });

  it('reports a default export that is not a function', async () => {
    const loaded = await load(`export default { routes: [] };\n`);
    expect(loaded.errors[0]).toContain('default-export a function');
  });

  it('reports a module that throws while importing', async () => {
    const loaded = await load(`throw new Error('boom at import');\n`);
    expect(loaded.errors[0]).toContain('boom at import');
    expect(loaded.routes).toEqual([]);
  });

  it('reports a factory that throws', async () => {
    const loaded = await load(`export default function plugin() { throw new Error('boom in factory'); }\n`);
    expect(loaded.errors[0]).toContain('boom in factory');
  });

  it('reports a factory that returns a non-object', async () => {
    const loaded = await load(`export default function plugin() { return 42; }\n`);
    expect(loaded.errors[0]).toContain('must return an object');
  });

  it('treats a factory returning nothing as declaring nothing', async () => {
    const loaded = await load(`export default function plugin() {}\n`);
    expect(loaded.errors).toEqual([]);
    expect(loaded.routes).toEqual([]);
  });

  it('reports a missing module', async () => {
    const loaded = await loadPluginServer(path.join(tmp, 'absent.mjs'), ctx);
    expect(loaded.errors[0]).toContain('failed to load');
  });
});

describe('route validation', () => {
  const { routeProblem } = __test;

  it('accepts a well-formed route', () => {
    expect(routeProblem({ method: 'GET', path: '/x', handler: () => 1 })).toBeNull();
  });

  it.each([
    ['a method it does not serve', { method: 'OPTIONS', path: '/x', handler: () => 1 }],
    ['a path with no leading slash', { method: 'GET', path: 'x', handler: () => 1 }],
    ['a non-string path', { method: 'GET', path: 1, handler: () => 1 }],
    ['no handler', { method: 'GET', path: '/x' }],
    ['a handler that is not a function', { method: 'GET', path: '/x', handler: 'nope' }],
  ])('rejects %s', (_label, route) => {
    expect(routeProblem(route as never)).not.toBeNull();
  });

  it('keeps the good routes and reports only the bad one', async () => {
    const loaded = await load(`export default function plugin() {
  return {
    routes: [
      { method: 'GET', path: '/good', handler: () => 1 },
      { method: 'GET', path: 'missing-slash', handler: () => 1 },
      { method: 'POST', path: '/also-good', handler: () => 1 },
    ],
  };
}
`);
    expect(loaded.routes.map((r) => r.path)).toEqual(['/good', '/also-good']);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toContain('routes[1]');
  });
});

describe('tool validation', () => {
  const { toolProblem } = __test;

  it('accepts a well-formed tool', () => {
    expect(
      toolProblem({ name: 'summary', description: 'A summary.', execute: () => 1 }),
    ).toBeNull();
  });

  it('requires a description, since that is what the model reads', () => {
    const problem = toolProblem({ name: 'summary', description: '   ', execute: () => 1 });
    expect(problem).toContain('description is required');
  });

  it.each([
    ['a leading digit', '1summary'],
    ['a space', 'cost summary'],
    ['an empty name', ''],
  ])('rejects a name with %s', (_label, name) => {
    expect(toolProblem({ name, description: 'x', execute: () => 1 })).not.toBeNull();
  });

  it('rejects an inputSchema that is not an object', () => {
    expect(
      toolProblem({ name: 'a', description: 'x', execute: () => 1, inputSchema: [] as never }),
    ).not.toBeNull();
  });

  it('accepts a tool with no inputSchema', () => {
    expect(toolProblem({ name: 'a', description: 'x', execute: () => 1 })).toBeNull();
  });

  it('reports the same tool name declared twice', async () => {
    const loaded = await load(`export default function plugin() {
  return {
    tools: [
      { name: 'summary', description: 'One.', execute: () => 1 },
      { name: 'summary', description: 'Two.', execute: () => 2 },
    ],
  };
}
`);
    expect(Object.keys(loaded.tools)).toHaveLength(1);
    expect(loaded.errors[0]).toContain('declared twice');
  });

  it('answers with the error rather than failing the turn when a tool throws', async () => {
    const loaded = await load(`export default function plugin() {
  return {
    tools: [{ name: 'boom', description: 'Throws.', execute: () => { throw new Error('tool failed'); } }],
  };
}
`);
    const tool = loaded.tools['costs__boom'];
    const result = await tool.execute?.({}, { toolCallId: 't', messages: [] });
    expect(result).toEqual({ error: 'tool failed' });
  });

  it('passes the input through to execute', async () => {
    const loaded = await load(`export default function plugin() {
  return {
    tools: [{
      name: 'echo',
      description: 'Echoes.',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
      execute: (input) => ({ got: input }),
    }],
  };
}
`);
    const tool = loaded.tools['costs__echo'];
    const result = await tool.execute?.({ a: 'b' }, { toolCallId: 't', messages: [] });
    expect(result).toEqual({ got: { a: 'b' } });
  });
});

describe('job validation', () => {
  const { jobProblem } = __test;

  it('accepts a well-formed job', () => {
    expect(jobProblem({ name: 'refresh', schedule: '0 * * * *', run: () => undefined })).toBeNull();
  });

  it.each([
    ['no name', { schedule: '0 * * * *', run: () => undefined }],
    ['no schedule', { name: 'refresh', run: () => undefined }],
    ['no run', { name: 'refresh', schedule: '0 * * * *' }],
  ])('rejects a job with %s', (_label, job) => {
    expect(jobProblem(job as never)).not.toBeNull();
  });
});
