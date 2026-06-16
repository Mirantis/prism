import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGitBranch } from './git-branch';

describe('getGitBranch', () => {
  let repoDir: string;
  let plainDir: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-repo-'));
    // checkout -b creates an (unborn) branch with no commit required, and
    // works across git versions that lack `init -b`.
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['checkout', '-b', 'my-feature'], { cwd: repoDir, stdio: 'ignore' });

    plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-plain-'));
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(plainDir, { recursive: true, force: true });
  });

  it('returns the current branch for a git work tree', async () => {
    expect(await getGitBranch(repoDir)).toBe('my-feature');
  });

  it('returns null for a non-git directory', async () => {
    expect(await getGitBranch(plainDir)).toBeNull();
  });

  it('returns null for an empty path', async () => {
    expect(await getGitBranch('')).toBeNull();
  });
});
