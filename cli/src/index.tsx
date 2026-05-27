#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { loadConfig } from './config.js';

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
    'Prism terminal UI — connects to prism-server ($PRISM_HTTP_URL, default http://127.0.0.1:3003).',
  );
  process.exit(0);
}

const cfg = loadConfig();

render(
  <App
    userId="local"
    agent={{ id: 'remote', name: cfg.agentName }}
    modelId={cfg.modelId}
    hideCursor={cfg.hideCursor}
    hideStatusBar={cfg.hideStatusBar}
  />,
  { exitOnCtrlC: false, interactive: true },
);
