import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'cli/native/bin');
mkdirSync(output, { recursive: true });
const windows = process.platform === 'win32';
const binary = path.join(output, windows ? 'prism-audio.exe' : 'prism-audio');
execFileSync(windows ? 'clang' : 'cc', [
  '-O2', '-std=c11', path.join(root, 'cli/native/audio.c'), '-o', binary,
  ...(process.platform === 'linux' ? ['-pthread', '-lm', '-ldl'] : []),
], { stdio: 'inherit' });
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', binary], { stdio: 'inherit' });
}
