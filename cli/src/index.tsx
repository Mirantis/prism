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
    'Prism terminal UI — connects to prism-server ($PRISM_HTTP_URL, default http://127.0.0.1:3003).\n' +
      '  --resume   Pick a previous conversation to resume instead of starting fresh.',
  );
  process.exit(0);
}

const cfg = loadConfig();
const resume = args.includes('--resume');

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
