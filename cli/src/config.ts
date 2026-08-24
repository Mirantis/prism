/**
 * Prism CLI configuration loader.
 *
 * Reads settings from `~/.prism/settings.json`. Every field is optional;
 * missing or malformed config falls back to the bundled defaults.
 *
 * `PRISM_HTTP_URL` env var, if set, overrides the `httpUrl` config value —
 * the e2e harness uses this to point at a per-test ephemeral port without
 * writing settings to disk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PrismConfig {
  agentName: string;
  modelId: string;
  hideCursor: boolean;
  hideStatusBar: boolean;
  /** Base URL of the agent-runtime. wsUrl is derived from this. */
  httpUrl: string;
}

const DEFAULTS: PrismConfig = {
  agentName: 'Prism',
  modelId: 'global.anthropic.claude-opus-5',
  hideCursor: false,
  hideStatusBar: false,
  httpUrl: 'http://localhost:3003',
};

export function configFilePath(): string {
  return path.join(os.homedir(), '.prism', 'settings.json');
}

export function loadConfig(): PrismConfig {
  const fromFile = readFromFile();
  return applyEnvOverrides(fromFile);
}

function readFromFile(): PrismConfig {
  const filePath = configFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // Missing file is normal — fall back to defaults silently.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULTS };
    }
    process.stderr.write(
      `prism-cli: failed to read ${filePath}: ${(err as Error).message}\n`,
    );
    return { ...DEFAULTS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `prism-cli: failed to parse ${filePath}: ${(err as Error).message}\n`,
    );
    return { ...DEFAULTS };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(
      `prism-cli: ${filePath} must contain a JSON object; using defaults\n`,
    );
    return { ...DEFAULTS };
  }

  const obj = parsed as Record<string, unknown>;
  return {
    agentName: pickString(obj, 'agentName', DEFAULTS.agentName),
    modelId: pickString(obj, 'modelId', DEFAULTS.modelId),
    hideCursor: pickBoolean(obj, 'hideCursor', DEFAULTS.hideCursor),
    hideStatusBar: pickBoolean(obj, 'hideStatusBar', DEFAULTS.hideStatusBar),
    httpUrl: pickString(obj, 'httpUrl', DEFAULTS.httpUrl),
  };
}

function applyEnvOverrides(cfg: PrismConfig): PrismConfig {
  // PRISM_HTTP_URL is the only env override; it lets the e2e harness and
  // ad-hoc runs point at a non-default agent-runtime without writing a
  // settings file. Applied uniformly whether the file existed or not.
  return {
    ...cfg,
    httpUrl: process.env.PRISM_HTTP_URL ?? cfg.httpUrl,
  };
}

/** Derive the WebSocket URL from the agent-runtime base URL. */
export function wsUrlFromHttpUrl(httpUrl: string): string {
  const trimmed = httpUrl.replace(/\/$/, '');
  return trimmed.replace(/^http/, 'ws') + '/api/ws';
}

function pickString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'string') return v;
  process.stderr.write(`prism-cli: config key '${key}' must be a string; using default\n`);
  return fallback;
}

function pickBoolean(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  process.stderr.write(`prism-cli: config key '${key}' must be a boolean; using default\n`);
  return fallback;
}
