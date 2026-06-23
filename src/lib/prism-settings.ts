/**
 * Reads agent-creation model defaults from the shared `~/.prism/settings.json`
 * file — the same file the `prism` CLI reads for its display preferences.
 *
 * Used to seed a freshly-bootstrapped agent's `model` / `heartbeatModel` /
 * `cronModel` columns (see `agentWorkspaceService.createAgent`). Every field is
 * optional; a missing file, malformed JSON, a non-string value, or an
 * ill-formatted model id all fall back to "no default" (`undefined`) — the
 * corresponding column then stays `null` and the agent resolves to
 * `BEDROCK_MODEL_ID` at invoke time.
 *
 * Recognised keys (all optional strings):
 *   - `modelId`          → the agent's main model override
 *   - `heartbeatModelId` → the heartbeat model override
 *   - `cronModelId`      → the scheduled-task model override
 *
 * `PRISM_SETTINGS_PATH` overrides the file location (used by tests).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentModelDefaults {
  model?: string;
  heartbeatModel?: string;
  cronModel?: string;
}

// Mirror the format rule enforced by the model-override API/UI
// (agent-workspace.service.ts). Validate here so a typo in the settings file
// degrades to "no default" rather than persisting a bad id on the agent row.
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:\-/]+$/;
const MODEL_ID_MAX_LEN = 200;

export function prismSettingsPath(): string {
  return process.env.PRISM_SETTINGS_PATH ?? path.join(os.homedir(), '.prism', 'settings.json');
}

function pickModelId(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    process.stderr.write(`[prism-settings] '${key}' must be a string; ignoring\n`);
    return undefined;
  }
  const trimmed = v.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MODEL_ID_MAX_LEN || !MODEL_ID_PATTERN.test(trimmed)) {
    process.stderr.write(`[prism-settings] '${key}' is not a valid model id; ignoring\n`);
    return undefined;
  }
  return trimmed;
}

export function readAgentModelDefaults(filePath = prismSettingsPath()): AgentModelDefaults {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // Missing file is the common case — fall back to no defaults silently.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `[prism-settings] failed to read ${filePath}: ${(err as Error).message}\n`,
      );
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[prism-settings] failed to parse ${filePath}: ${(err as Error).message}\n`,
    );
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(`[prism-settings] ${filePath} must contain a JSON object; ignoring\n`);
    return {};
  }

  const obj = parsed as Record<string, unknown>;
  return {
    model: pickModelId(obj, 'modelId'),
    heartbeatModel: pickModelId(obj, 'heartbeatModelId'),
    cronModel: pickModelId(obj, 'cronModelId'),
  };
}
