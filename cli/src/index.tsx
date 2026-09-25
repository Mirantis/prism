#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { loadConfig } from './config.js';
import { tuiAdapterService, ThreadSummary } from './tui-adapter.js';

// The CLI doesn't know — and isn't told — the userId or agentId. The
// runtime owns both and substitutes them when our envelopes omit them.
// Display preferences come from ~/.prism/settings.json.

// `--version` / `--help` short-circuit before any render work, so the packaged
// binary can be smoke-tested without a TTY.
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(process.env.PRISM_VERSION ?? '0.0.0-dev');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'prism — Prism Agent terminal UI (connects to prism-server at $PRISM_HTTP_URL, default http://127.0.0.1:3003).\n' +
      '  update     Check for a newer Prism release and install it.\n' +
      '  --resume   Pick a previous conversation to resume instead of starting fresh.',
  );
  process.exit(0);
}
if (args[0] === 'update') {
  // Non-interactive: triggers the server-side update over the management API
  // and waits for the restarted runtime to report the new version.
  void import('./update-cli.js').then(({ runUpdateCommand }) => runUpdateCommand());
} else {
  void main().catch((error: unknown) => {
    process.stderr.write(`prism: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const resume = args.includes('--resume');
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { runWebTerminal } = await import('./web-terminal/run.js');
    if (await runWebTerminal(cfg.httpUrl, resume)) return;
  }

  function start(resumeData?: { sessions: ThreadSummary[]; cwd: string }): void {
    render(
      <App
        userId="local"
        agent={{ id: 'remote', name: cfg.agentName }}
        modelId={cfg.modelId}
        hideCursor={cfg.hideCursor}
        hideStatusBar={cfg.hideStatusBar}
        resume={resumeData}
      />,
      { exitOnCtrlC: false, interactive: true },
    );
  }

  if (resume) {
    // Fetch the resumable threads before rendering so we can exit cleanly when
    // there's nothing to resume (and avoid flashing an empty picker).
    void (async () => {
      const sessions = await tuiAdapterService.listSessions();
      if (sessions.length === 0) {
        console.log('No sessions to resume.');
        process.exit(0);
      }
      start({ sessions, cwd: process.cwd() });
    })();
  } else {
    start();
  }
}
