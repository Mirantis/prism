/**
 * Tool Output Store Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

import {
  writeToolOutput,
  readToolOutput,
  reapExpiredToolOutputs,
  isToolOutputId,
  MAX_SPILL_BYTES,
} from './tool-output-store';
import { resolveToolOutputDir } from './data-dir';
import { localFiles } from './execution-environments/local/local-files';
import {
  __resetExecutionEnvironmentDetectionForTests,
  __setExecutionEnvironmentForTests,
} from './execution-environments/get-execution-environment';
import { fakeExecutionEnvironment } from '../test-utils/fake-execution-environment';

let dataDir: string;
const originalDataDir = process.env.PRISM_DATA_DIR;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-spill-'));
  process.env.PRISM_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.PRISM_DATA_DIR;
  else process.env.PRISM_DATA_DIR = originalDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('isToolOutputId', () => {
  it('accepts a uuid and nothing else', () => {
    expect(isToolOutputId('0f9a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b')).toBe(true);
    expect(isToolOutputId('../agent.db')).toBe(false);
    expect(isToolOutputId('a/b')).toBe(false);
    expect(isToolOutputId('')).toBe(false);
    expect(isToolOutputId('agent.db')).toBe(false);
  });
});

describe('writeToolOutput / readToolOutput', () => {
  it('round-trips a saved output', async () => {
    const { id, bytes, capped } = await writeToolOutput('the whole payload');
    expect(capped).toBe(false);
    expect(bytes).toBe('the whole payload'.length);
    expect(await readToolOutput(id)).toBe('the whole payload');
  });

  it('creates the directory when it is missing', async () => {
    await fs.rm(resolveToolOutputDir(), { recursive: true, force: true });
    const { id } = await writeToolOutput('still works');
    expect(await readToolOutput(id)).toBe('still works');
  });

  it('reports an unknown id as gone rather than failing', async () => {
    expect(await readToolOutput('0f9a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b')).toBeNull();
  });

  it('refuses to read outside its own directory', async () => {
    const outside = path.join(dataDir, 'agent.db');
    await fs.writeFile(outside, 'secret');
    expect(await readToolOutput('../agent.db')).toBeNull();
    expect(await readToolOutput('a/b')).toBeNull();
    // and left it alone
    expect(await fs.readFile(outside, 'utf8')).toBe('secret');
  });

  it('caps one saved copy and says so', async () => {
    const { bytes, capped, id } = await writeToolOutput('z'.repeat(MAX_SPILL_BYTES + 5000));
    expect(capped).toBe(true);
    expect(bytes).toBe(MAX_SPILL_BYTES);
    expect((await readToolOutput(id))!.length).toBe(MAX_SPILL_BYTES);
  });

  it('leaves no file under the final name if the write never finishes', async () => {
    // The rename is what publishes the copy, so a crash before it leaves a .tmp
    // sibling and no readable id.
    __setExecutionEnvironmentForTests(
      fakeExecutionEnvironment({
        paths: { toolOutputDir: resolveToolOutputDir() },
        files: { ...localFiles, rename: () => Promise.reject(new Error('boom')) },
      }),
    );
    try {
      await expect(writeToolOutput('half')).rejects.toThrow('boom');
    } finally {
      __setExecutionEnvironmentForTests(null);
    }

    const entries = await fs.readdir(resolveToolOutputDir());
    expect(entries.every((e) => e.endsWith('.tmp'))).toBe(true);
  });
});

describe('reapExpiredToolOutputs', () => {
  const HOUR = 60 * 60 * 1000;

  it('deletes past-TTL copies and spares younger ones', async () => {
    const old = await writeToolOutput('old');
    const fresh = await writeToolOutput('fresh');

    const past = new Date(Date.now() - 8 * 24 * HOUR);
    await fs.utimes(path.join(resolveToolOutputDir(), old.id), past, past);

    expect(await reapExpiredToolOutputs(7 * 24 * HOUR)).toBe(1);
    expect(await readToolOutput(old.id)).toBeNull();
    expect(await readToolOutput(fresh.id)).toBe('fresh');
  });

  it('sweeps a .tmp file a crash left behind', async () => {
    const stray = path.join(resolveToolOutputDir(), 'abandoned.tmp');
    await fs.mkdir(resolveToolOutputDir(), { recursive: true });
    await fs.writeFile(stray, 'partial');
    const past = new Date(Date.now() - 8 * 24 * HOUR);
    await fs.utimes(stray, past, past);

    expect(await reapExpiredToolOutputs(7 * 24 * HOUR)).toBe(1);
  });

  it('tolerates a directory that was never created', async () => {
    await fs.rm(resolveToolOutputDir(), { recursive: true, force: true });
    expect(await reapExpiredToolOutputs(HOUR)).toBe(0);
  });
});

describe('a thread rooted outside the deployment environment', () => {
  let containerRoot: string;

  beforeEach(async () => {
    // Stands in for a container: it serves only its own tree, and a path
    // anywhere else belongs to this machine.
    containerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-spill-container-'));
    __setExecutionEnvironmentForTests(
      fakeExecutionEnvironment({
        workspaceRoot: containerRoot,
        servesPath: (p) => p.startsWith(containerRoot),
        files: localFiles,
      }),
    );
  });

  afterEach(async () => {
    __resetExecutionEnvironmentDetectionForTests();
    await fs.rm(containerRoot, { recursive: true, force: true });
  });

  it("saves the copy where that thread's own shell reads it", async () => {
    const inside = await writeToolOutput('from the default thread');
    const outside = await writeToolOutput('from a host repository', '/Users/me/dev/repo');

    expect(inside.path.startsWith(containerRoot)).toBe(true);
    // A thread rooted in a host repository runs its commands on the host, so
    // the notice has to name a host path.
    expect(outside.path.startsWith(resolveToolOutputDir())).toBe(true);
  });

  it('reads and reaps a copy on either side', async () => {
    const inside = await writeToolOutput('inside');
    const outside = await writeToolOutput('outside', '/Users/me/dev/repo');

    expect(await readToolOutput(outside.id)).toBe('outside');
    expect(await readToolOutput(inside.id)).toBe('inside');

    const stale = await writeToolOutput('stale', '/Users/me/dev/repo');
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(stale.path, past, past);
    expect(await reapExpiredToolOutputs(7 * 24 * 60 * 60 * 1000)).toBe(1);
  });
});
