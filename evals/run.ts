/**
 * The prompt eval set: fixed scenarios run against the configured model through
 * the backend's own prompt builders, tools and gates (`prism-server eval`, see
 * `backend.ts`), each several times, so a prompt change shows up as a change in
 * pass rate.
 *
 *   npm run eval:prompts -- [--runs 3] [--only risk.,chat.sets] [--baseline eval-results/<file>.json]
 *
 * `--only` keeps the scenarios whose id contains one of the given parts. The run
 * prints a table and writes `eval-results/prompts-<time>.json`; `--baseline`
 * prints an earlier result file's rates beside this run's. Every run makes real
 * model calls with the credentials in `.env` or the environment. The npm script
 * builds the backend first; `PRISM_SERVER_BIN` names another build.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Backend } from './backend';
import * as harness from './harness';
import type { Grade, Scenario } from './scenarios';
import type { PromptSize } from './types';

const REPO_ROOT = path.resolve(__dirname, '..');
const PRISM_SERVER_BIN =
  process.env.PRISM_SERVER_BIN || path.join(REPO_ROOT, 'backend', 'target', 'release', 'prism-server');
const RESULTS_DIR = path.join(REPO_ROOT, 'eval-results');
const CONCURRENCY = 4;
const ATTEMPTS = 3;

interface Options {
  runs: number;
  only: string[];
  baseline?: string;
}

interface SampleResult {
  /** Null when every attempt failed to run, so the sample has no grade. */
  pass: boolean | null;
  detail: string;
  inputTokens: number;
  outputTokens: number;
}

interface ScenarioResult {
  id: string;
  expect: string;
  grader: Scenario['grader'];
  passed: number;
  graded: number;
  samples: SampleResult[];
}

interface RunResult {
  startedAt: string;
  commit: string;
  /** Digest of the eval sources, so two result files show whether they ran the same scenarios. */
  evalSet: string;
  provider: string;
  chatModel: string;
  classificationModel: string;
  runs: number;
  promptSize: PromptSize;
  tokens: { input: number; output: number };
  scenarios: ScenarioResult[];
}

type RunIdentity = Pick<RunResult, 'evalSet' | 'provider' | 'chatModel' | 'classificationModel'>;

function parseOptions(argv: string[]): Options {
  const options: Options = { runs: 3, only: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--runs') options.runs = Number.parseInt(value, 10);
    else if (flag === '--only') options.only = value.split(',').map((id) => id.trim()).filter(Boolean);
    else if (flag === '--baseline') options.baseline = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('--runs takes a positive integer');
  return options;
}

/**
 * Start the backend on a scratch database, data directory and settings file. dotenv
 * leaves a variable that is already set alone, so these values win over `.env`; the
 * backend migrates the database itself.
 */
function startBackend(dataDir: string): Backend {
  const env = {
    ...process.env,
    AGENT_ID: harness.EVAL_AGENT_ID,
    DATABASE_URL: `file:${path.join(dataDir, 'eval.db')}`,
    PRISM_DATA_DIR: dataDir,
    // The developer's own settings would set the new agent's model.
    PRISM_SETTINGS_PATH: path.join(dataDir, 'settings.json'),
    // The tools block holds the built-in tools only, and the skill and plugin
    // listings come from the empty scratch directory.
    NEXUS_MCP_URL: '',
    PRISM_SKILLS_DIR: '',
    PRISM_PLUGINS_DIR: '',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
  };
  if (!fs.existsSync(PRISM_SERVER_BIN)) {
    throw new Error(`${PRISM_SERVER_BIN} does not exist; run the eval with npm run eval:prompts, which builds it.`);
  }
  return Backend.start(PRISM_SERVER_BIN, env, REPO_ROOT);
}

async function pool<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

/** The commit the prompts come from, marked when the backend source has uncommitted changes. */
function gitCommit(): string {
  const run = (args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const dirty = run(['status', '--porcelain', '--', 'backend/src']) !== '';
  return `${run(['rev-parse', '--short', 'HEAD'])}${dirty ? '+changes' : ''}`;
}

function evalSetDigest(): string {
  const hash = createHash('sha256');
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.ts')).sort()) {
    hash.update(fs.readFileSync(path.join(__dirname, file)));
  }
  return hash.digest('hex').slice(0, 12);
}

/** What makes a baseline's rates not comparable with this run's, one line each. */
function baselineMismatches(baseline: RunIdentity, current: RunIdentity): string[] {
  const fields = ['evalSet', 'provider', 'chatModel', 'classificationModel'] as const;
  return fields
    .filter((field) => baseline[field] !== current[field])
    .map((field) => `${field}: baseline ${baseline[field]}, this run ${current[field]}`);
}

async function runSample(
  run: () => Promise<Grade>,
  accounted: typeof harness.withSampleAccounting,
): Promise<SampleResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let lastError = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const attemptResult = await accounted(run);
    inputTokens += attemptResult.inputTokens;
    outputTokens += attemptResult.outputTokens;
    if ('value' in attemptResult.outcome) return { ...attemptResult.outcome.value, inputTokens, outputTokens };
    const { error } = attemptResult.outcome;
    lastError = error instanceof Error ? error.message : String(error);
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
  }
  return { pass: null, detail: `failed to run: ${lastError}`, inputTokens, outputTokens };
}

function rate(passed: number, graded: number): string {
  return graded === 0 ? '-' : `${Math.round((passed / graded) * 100)}%`;
}

function printReport(result: RunResult, baseline: RunResult | undefined, file: string): void {
  const before = new Map(baseline?.scenarios.map((s) => [s.id, s]));
  const idWidth = Math.max(...result.scenarios.map((s) => s.id.length), 8);
  const header = ['scenario'.padEnd(idWidth), 'grader'.padEnd(12), 'pass'.padStart(7), 'rate'.padStart(5)];
  if (baseline) header.push('baseline'.padStart(9));

  console.log(
    `\nPrompt eval at ${result.commit} (eval set ${result.evalSet}): ${result.provider}, ` +
      `chat model ${result.chatModel}, classification model ${result.classificationModel}, ` +
      `${result.runs} run(s) per scenario`,
  );
  console.log(`\n${header.join('  ')}`);
  for (const s of result.scenarios) {
    const errors = s.samples.length - s.graded;
    const row = [
      s.id.padEnd(idWidth),
      s.grader.padEnd(12),
      `${s.passed}/${s.graded}`.padStart(7),
      rate(s.passed, s.graded).padStart(5),
    ];
    const old = before.get(s.id);
    if (baseline) row.push((old ? rate(old.passed, old.graded) : 'new').padStart(9));
    console.log(row.join('  ') + (errors > 0 ? `  (${errors} failed to run)` : ''));
  }

  const totalOf = (r: RunResult): [number, number] => [
    r.scenarios.reduce((sum, s) => sum + s.passed, 0),
    r.scenarios.reduce((sum, s) => sum + s.graded, 0),
  ];
  const [passed, graded] = totalOf(result);
  const baselineTotal = baseline ? totalOf(baseline) : undefined;
  console.log(
    `\n${'total'.padEnd(idWidth)}  ${''.padEnd(12)}  ${`${passed}/${graded}`.padStart(7)}  ${rate(passed, graded).padStart(5)}` +
      (baselineTotal ? `  ${rate(baselineTotal[0], baselineTotal[1]).padStart(9)}` : ''),
  );

  const size = (r: RunResult) =>
    `product text ${r.promptSize.productText}, seeded templates ${r.promptSize.seededTemplates}, ` +
    `tool descriptions ${r.promptSize.toolDescriptions}`;
  console.log(`\nPrompt size (chars): ${size(result)}`);
  if (baseline) console.log(`Baseline (${baseline.commit}): ${size(baseline)}`);
  console.log(`Tokens: ${result.tokens.input} in, ${result.tokens.output} out`);
  console.log(`Result file: ${path.relative(process.cwd(), file)}\n`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const baseline = options.baseline
    ? (JSON.parse(fs.readFileSync(options.baseline, 'utf8')) as RunResult)
    : undefined;
  const startedAt = new Date().toISOString();
  const commit = gitCommit();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-prompt-eval-'));
  try {
    const backend = startBackend(dataDir);
    try {
      await harness.connect(backend);
      // Loaded once the backend's texts are in, since the scenarios quote them.
      const { SCENARIOS } = await import('./scenarios');
      const scenarios = options.only.length
        ? SCENARIOS.filter((s) => options.only.some((id) => s.id.includes(id)))
        : SCENARIOS;
      if (scenarios.length === 0) throw new Error(`No scenario matches ${options.only.join(', ')}`);

      const models = harness.modelsInUse();
      const identity: RunIdentity = {
        evalSet: evalSetDigest(),
        provider: models.provider,
        chatModel: models.chat,
        classificationModel: models.classification,
      };
      for (const line of baseline ? baselineMismatches(baseline, identity) : []) {
        console.warn(`The baseline differs from this run, so its rates measure more than the prompt. ${line}`);
      }

      await harness.createEvalAgents();
      const promptSize = await harness.measurePromptSize();

      const tasks = scenarios.flatMap((s) =>
        Array.from({ length: options.runs }, () => () => runSample(s.run, harness.withSampleAccounting)),
      );
      console.log(`Running ${scenarios.length} scenario(s) x ${options.runs} run(s)…`);
      const samples = await pool(tasks, CONCURRENCY);

      const result: RunResult = {
        startedAt,
        commit,
        ...identity,
        runs: options.runs,
        promptSize,
        tokens: {
          input: samples.reduce((sum, s) => sum + s.inputTokens, 0),
          output: samples.reduce((sum, s) => sum + s.outputTokens, 0),
        },
        scenarios: scenarios.map((s, index) => {
          const own = samples.slice(index * options.runs, (index + 1) * options.runs);
          return {
            id: s.id,
            expect: s.expect,
            grader: s.grader,
            passed: own.filter((sample) => sample.pass === true).length,
            graded: own.filter((sample) => sample.pass !== null).length,
            samples: own,
          };
        }),
      };

      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const file = path.join(RESULTS_DIR, `prompts-${startedAt.replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      printReport(result, baseline, file);
    } finally {
      await backend.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
