#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { loadConfig } from './config.js';
import { tuiAdapterService, ThreadSummary } from './tui-adapter.js';
import { detectTerminalGraphics } from './images/terminal-graphics.js';
import { Launch, OpenThread, parseLaunchArgs, resolveContinueLaunch, resolveThreadLaunch } from './launch.js';
import { ownCommand, programResumeSequence, ResumeReporting, takeResumeToken } from './program-resume.js';

// The CLI doesn't know — and isn't told — the userId or agentId. The
// runtime owns both and substitutes them when our envelopes omit them.
// Display preferences come from ~/.prism/settings.json.

// `--version` / `--help` short-circuit before any render work, so the packaged
// binary can be smoke-tested without a TTY.
const args = process.argv.slice(2);
// Taken before any command runs, so that no process the CLI starts inherits the token.
const resumeToken = takeResumeToken();
if (args.includes('--version') || args.includes('-v')) {
  console.log(process.env.PRISM_VERSION ?? '0.0.0-dev');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'prism — Prism Agent terminal UI (connects to prism-server at $PRISM_HTTP_URL, default http://127.0.0.1:3003).\n' +
      '  update         Check for a newer Prism release and install it.\n' +
      '  acp            Serve the Agent Client Protocol on stdio, for an editor to start.\n' +
      '  --resume       Pick a previous conversation to resume instead of starting fresh.\n' +
      '                 An agent in single-thread mode always opens its one conversation.\n' +
      '  --resume <id>  Open the conversation with this id.\n' +
      '  --continue     Open the most recently active conversation started in this directory.\n' +
      'A terminal with program resume (OSC 7577) reopens the conversation after it restarts.',
  );
  process.exit(0);
}
if (args[0] === 'update') {
  // Non-interactive: triggers the server-side update over the management API
  // and waits for the restarted runtime to report the new version.
  void import('./update-cli.js').then(({ runUpdateCommand }) => runUpdateCommand());
} else if (args[0] === 'acp') {
  void import('./acp/acp-command.js').then(({ runAcpCommand }) => runAcpCommand());
} else {
  main();
}

function main(): void {
  const cfg = loadConfig();
  const launch = parseLaunchArgs(args);
  if (launch.kind === 'invalid') fail(launch.message);
  // Ink enters raw mode only when its input hooks mount, after the first frame. Raw mode
  // from the start keeps a Ctrl+C typed during boot a key press rather than a SIGINT.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  // The terminal answers the graphics probe as input, so it runs before Ink reads stdin.
  const graphics = detectTerminalGraphics(process.stdin, process.stdout);

  // The resume command carries no environment, so the CLI reports one only when
  // PRISM_HTTP_URL is unset or names the address of the settings file.
  const resumeReporting: ResumeReporting | undefined =
    resumeToken && !cfg.httpUrlFromEnv ? { token: resumeToken, command: ownCommand(), cwd: process.cwd() } : undefined;

  async function start(
    opened: { resume?: { sessions: ThreadSummary[]; cwd: string }; thread?: OpenThread } = {},
  ): Promise<void> {
    const terminalGraphics = await graphics;
    render(
      <App
        userId="local"
        agent={{ id: 'remote', name: cfg.agentName }}
        modelId={cfg.modelId}
        hideCursor={cfg.hideCursor}
        hideStatusBar={cfg.hideStatusBar}
        graphics={terminalGraphics}
        resume={opened.resume}
        thread={opened.thread}
        resumeReporting={resumeReporting}
      />,
      { exitOnCtrlC: false, interactive: true },
    );
  }

  /**
   * Print why the launch cannot open a conversation, and exit with an error. A
   * terminal that resumed this command would run it again, so the record is cleared.
   */
  function fail(message: string): never {
    if (resumeToken && process.stdout.isTTY) process.stdout.write(programResumeSequence({ clear: true }, resumeToken));
    console.error(message);
    process.exit(1);
  }

  const onWait = () => process.stderr.write(`Waiting for the Prism runtime at ${cfg.httpUrl}…\n`);

  if (launch.kind === 'pick') {
    // Fetch the resumable threads before rendering so we can exit cleanly when
    // there's nothing to resume (and avoid flashing an empty picker). An agent in
    // single-thread mode has nothing to pick: the CLI opens its one conversation.
    void (async () => {
      if ((await tuiAdapterService.threadMode()) === 'single') {
        await start();
        return;
      }
      // A runtime that does not answer has nothing to resume either.
      const sessions = (await tuiAdapterService.listSessions()) ?? [];
      if (sessions.length === 0) {
        console.log('No sessions to resume.');
        process.exit(0);
      }
      await start({ resume: { sessions, cwd: process.cwd() } });
    })();
  } else if (launch.kind === 'thread' || launch.kind === 'continue') {
    void (async () => {
      // The launch can wait for the runtime, so it asks in cooked mode, where Ctrl+C
      // stops it. The terminal's answers to the graphics probe arrive in raw mode first.
      await graphics;
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      const opened: Launch =
        launch.kind === 'thread'
          ? await resolveThreadLaunch(launch.id, tuiAdapterService, onWait)
          : await resolveContinueLaunch(process.cwd(), tuiAdapterService, onWait);
      if (opened.kind === 'exit') fail(opened.message);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      await start(opened.kind === 'thread' ? { thread: opened } : {});
    })();
  } else {
    void start();
  }
}
