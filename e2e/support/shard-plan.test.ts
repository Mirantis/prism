import { expect, it } from 'vitest';
import { DEFAULT_SECONDS_PER_TEST, planShards, type SpecFile } from './shard-plan';

const spec = (file: string, tests = 1): SpecFile => ({ file, tests });

it('puts every file in exactly one shard', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((f) => spec(f));
  const planned = planShards(files, { a: 90, b: 70, c: 40, d: 30, e: 20, f: 10, g: 5 }, 3)
    .flatMap((s) => s.files.map((f) => f.file))
    .sort();
  expect(planned).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

it('balances by recorded seconds rather than by test count', () => {
  const files = [spec('slow', 2), spec('mid', 2), spec('quick', 10), spec('tiny', 10)];
  const shards = planShards(files, { slow: 160, mid: 90, quick: 40, tiny: 20 }, 2);
  expect(shards.map((s) => s.seconds)).toEqual([160, 150]);
  expect(shards[0].files.map((f) => f.file)).toEqual(['slow']);
});

it('plans a file with no recorded duration from its test count', () => {
  const shards = planShards([spec('new', 3)], {}, 2);
  expect(shards[0]).toEqual({ files: [spec('new', 3)], seconds: 3 * DEFAULT_SECONDS_PER_TEST });
  expect(shards[1]).toEqual({ files: [], seconds: 0 });
});

it('gives every shard the same plan whatever order the files are listed in', () => {
  const files = ['a', 'b', 'c', 'd'].map((f) => spec(f));
  const seconds = { a: 30, b: 30, c: 30, d: 30 };
  expect(planShards([...files].reverse(), seconds, 2)).toEqual(planShards(files, seconds, 2));
});
