import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;
let entry: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-logger-'));
  entry = path.join(root, 'src/lib/probe.cjs');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'LOG_LEVEL=debug\n');
  buildSync({
    stdin: { contents: `import './config'; import { logger } from './logger'; console.log(logger.level);`,
      resolveDir: __dirname },
    outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('logger environment initialization', () => {
  it.each([[undefined, 'debug'], ['warn', 'warn']])('honors .env and shell precedence: %s', (level, expected) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', PRISM_DATA_DIR: root,
      CLAUDE_CONFIG_DIR: path.join(root, 'empty-home'), CODING_AGENT: 'claude-code',
      NODE_PATH: path.dirname(path.dirname(require.resolve('pino/package.json'))) };
    delete env.LOG_LEVEL;
    if (level) env.LOG_LEVEL = level;
    expect(execFileSync(process.execPath, [entry], { env, encoding: 'utf8' }).trim()).toBe(expected);
  });
});
