#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { loadConfig } from './config.js';

// The CLI doesn't know — and isn't told — the userId or agentId. The
// runtime owns both and substitutes them when our envelopes omit them.
// Display preferences come from ~/.prism/settings.json.
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
