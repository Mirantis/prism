import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../../data-dir';
import { hasBedrockCredentials } from '../bedrock-credentials';

export function resolveCodexHome(env: NodeJS.ProcessEnv, dataDir = resolveDataDir()): string {
  return path.resolve(env.CODEX_HOME || path.join(dataDir, '.codex'));
}

export function codexApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.CODEX_API_KEY || env.OPENAI_API_KEY;
}

export function codexAuthMethod(env: NodeJS.ProcessEnv): 'api' | 'saved' | 'bedrock' | undefined {
  if (codexApiKey(env)) return 'api';
  // Codex validates the saved credentials and refreshes its own login tokens.
  if (fs.existsSync(path.join(resolveCodexHome(env), 'auth.json'))) return 'saved';
  if (hasBedrockCredentials(env)) return 'bedrock';
  return undefined;
}
