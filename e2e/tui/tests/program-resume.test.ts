/**
 * `prism-cli` against a terminal that resumes programs (OSC 7577): the CLI reports
 * `prism --resume <id>` for its conversation, signed with the terminal's token, and
 * the reported command reopens that conversation in the reported directory. A user
 * exit clears the record, also from the wait for a runtime that does not answer, and
 * a termination keeps it. A terminal without a token receives no report. No Bedrock
 * interaction required.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, vi } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, KEYS, startPrism, type TuiSession } from '../harness';
import { setupRuntime, runtimeRequest, type RuntimeTestEnv } from '../setup';

// The token of the specification's examples. A terminal makes a random one per pane.
const TOKEN = 'dummy-token-replace-me';
const RESUMED_MARKER = 'program-resume-history-marker';

interface ResumeReport {
  pid: number;
  argv?: string[];
  cwd?: string;
  clear?: boolean;
}

/** Every OSC 7577 report in the CLI's output, each checked against the token's mac. */
function resumeReports(output: string): ResumeReport[] {
  return [...output.matchAll(/\x1b\]7577;([^\x1b]*)\x1b\\/g)].map(([, body]) => {
    const [signed, mac] = body!.split(':mac=');
    expect(createHash('sha256').update(`${signed}:${TOKEN}`).digest('hex')).toBe(mac);
    const pairs: Record<string, string> = Object.fromEntries(
      signed!.split(':').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
    );
    const decode = (value: string) => Buffer.from(value, 'base64').toString('utf8');
    return {
      pid: Number(pairs.pid),
      ...(pairs.argv ? { argv: pairs.argv.split(',').map(decode) } : {}),
      ...(pairs.cwd ? { cwd: decode(pairs.cwd) } : {}),
      ...(pairs.clear ? { clear: true } : {}),
    };
  });
}

function wipeThreads(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec('DELETE FROM conversation_messages; DELETE FROM conversation_threads;');
  } finally {
    db.close();
  }
}

/** Seed one message into a thread by direct SQLite insert, dated as the thread. */
function seedMessage(dbPath: string, threadId: string, content: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO conversation_messages (id, threadId, role, content, triggeredBy, isCompacted, createdAt)
       SELECT ?, id, 'AGENT', ?, 'USER_INPUT', 0, createdAt
       FROM conversation_threads WHERE id = ?`,
    ).run(`msg-${threadId}`, content, threadId);
  } finally {
    db.close();
  }
}

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A home directory whose settings file names `httpUrl`. */
function homeWithRuntimeAt(httpUrl: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-e2e-program-resume-home-'));
  fs.mkdirSync(path.join(home, '.prism'));
  fs.writeFileSync(path.join(home, '.prism', 'settings.json'), JSON.stringify({ httpUrl }));
  return home;
}

const feature = loadFeatureFromText(
  readFileSync(path.join(import.meta.dirname, '../features/program-resume.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession | undefined;
let projectDir: string;
let homeDir: string;
let offlineHomeDir: string;
let cliEnv: NodeJS.ProcessEnv;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime();
    projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-e2e-program-resume-project-')));
    // The resume command carries no environment, so the CLI reports only when the
    // settings file names the runtime.
    homeDir = homeWithRuntimeAt(`http://127.0.0.1:${env.port}`);
    offlineHomeDir = homeWithRuntimeAt(`http://127.0.0.1:${await closedPort()}`);
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(offlineHomeDir, { recursive: true, force: true });
  });
  BeforeEachScenario(() => {
    wipeThreads(env.dbPath);
    session = undefined;
  });
  AfterEachScenario(async () => {
    if (session) await session.stop();
  });

  const terminalEnv = (token: string | undefined, home = homeDir): NodeJS.ProcessEnv => ({
    ...env.prismEnv,
    PRISM_HTTP_URL: undefined,
    HOME: home,
    OSC7577_TOKEN: token,
  });

  const launchInProject = () => {
    session = startPrism({ env: cliEnv, runtime: env.runtime, cwd: projectDir });
  };

  /** The id of the one conversation the CLI started in the project directory. */
  const projectThreadId = async (): Promise<string> => {
    let id = '';
    await vi.waitFor(
      async () => {
        const threads = await runtimeRequest<{ id: string }[]>(
          env.port,
          'GET',
          `/threads?${new URLSearchParams({ workspaceRoot: projectDir }).toString()}`,
        );
        expect(threads).toHaveLength(1);
        id = threads[0]!.id;
      },
      { timeout: BOOT_FRAME_TIMEOUT_MS, interval: 250 },
    );
    return id;
  };

  /** Wait until the CLI has reported a command, and return the reports so far. */
  const reported = async (): Promise<ResumeReport[]> => {
    await vi.waitFor(() => expect(resumeReports(session!.rawOutput()).some((r) => r.argv)).toBe(true), {
      timeout: BOOT_FRAME_TIMEOUT_MS,
      interval: 100,
    });
    return resumeReports(session!.rawOutput());
  };

  Scenario('The CLI reports a command that reopens the conversation', ({ Given, When, Then, And }) => {
    let report: ResumeReport;
    let threadId: string;

    Given('a terminal that supports program resume', () => {
      cliEnv = terminalEnv(TOKEN);
    });
    When('I launch the CLI in a project directory', () => {
      launchInProject();
    });
    Then('the CLI reports a signed resume command for its conversation and directory', async () => {
      threadId = await projectThreadId();
      [report] = await reported();
      expect(report!.argv!.slice(-2)).toEqual(['--resume', threadId]);
      expect(path.isAbsolute(report!.argv![0]!)).toBe(true);
      expect(report!.cwd).toBe(projectDir);
      expect(session!.rawOutput()).not.toContain(TOKEN);
    });
    And('the reported command reopens that conversation', async () => {
      seedMessage(env.dbPath, threadId, RESUMED_MARKER);
      await session!.stop();
      // Started as a terminal starts a record: the command alone, in its directory.
      session = startPrism({ env: cliEnv, runtime: env.runtime, command: report.argv, cwd: report.cwd });
      await session.waitForFrame(new RegExp(RESUMED_MARKER), BOOT_FRAME_TIMEOUT_MS);
      expect(session.output()).not.toContain('Resume session');
    });
  });

  Scenario('Exiting with /exit clears the record', ({ Given, When, Then, And }) => {
    Given('a terminal that supports program resume', () => {
      cliEnv = terminalEnv(TOKEN);
    });
    When('I launch the CLI in a project directory', () => {
      launchInProject();
    });
    And('I exit the CLI with /exit', async () => {
      await reported();
      // The trailing space closes the slash popup, so one Enter runs the command.
      session!.send('/exit ');
      await session!.waitForFrame(/\/exit/, 10_000);
      session!.send(KEYS.ENTER);
      expect(await session!.waitForExit(30_000)).toBe(0);
    });
    Then('the CLI clears its resume record', () => {
      const reports = resumeReports(session!.rawOutput());
      expect(reports.at(-1)).toEqual({ pid: reports[0]!.pid, clear: true });
    });
  });

  Scenario('A termination keeps the record', ({ Given, When, Then, And }) => {
    Given('a terminal that supports program resume', () => {
      cliEnv = terminalEnv(TOKEN);
    });
    When('I launch the CLI in a project directory', () => {
      launchInProject();
    });
    And('the terminal terminates the CLI', async () => {
      await reported();
      await session!.stop();
    });
    Then('the CLI does not clear its resume record', () => {
      expect(resumeReports(session!.rawOutput()).some((report) => report.clear)).toBe(false);
    });
  });

  Scenario('A terminal without program resume receives no report', ({ Given, When, Then }) => {
    Given('a terminal without program resume', () => {
      cliEnv = terminalEnv(undefined);
    });
    When('I launch the CLI in a project directory', () => {
      launchInProject();
    });
    Then('the CLI writes no resume report', async () => {
      // The conversation exists, so a CLI that reports would have reported by now.
      await projectThreadId();
      await session!.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(session!.rawOutput()).not.toContain('\x1b]7577;');
    });
  });

  Scenario('Ctrl+C while the CLI waits for the runtime clears the record', ({ Given, When, Then, And }) => {
    Given('a terminal that supports program resume, and a runtime that does not answer', () => {
      cliEnv = terminalEnv(TOKEN, offlineHomeDir);
    });
    When('I resume a conversation by id', () => {
      session = startPrism({ env: cliEnv, runtime: env.runtime, args: ['--resume', 'thread-from-before'], cwd: projectDir });
    });
    And('I press Ctrl+C while the CLI waits for the runtime', async () => {
      await session!.waitForFrame(/Waiting for the Prism runtime/, BOOT_FRAME_TIMEOUT_MS);
      session!.send(KEYS.CTRL_C);
      expect(await session!.waitForExit(30_000)).not.toBe(0);
    });
    Then('the CLI clears its resume record', () => {
      expect(resumeReports(session!.rawOutput())).toEqual([{ pid: expect.any(Number), clear: true }]);
    });
  });
});
