import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Explicit AWS credentials or a configured AWS credential chain. */
export function hasBedrockCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.AWS_BEARER_TOKEN_BEDROCK ||
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
    env.AWS_PROFILE || (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) ||
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI
  );
}

export function bedrockRegion(env: NodeJS.ProcessEnv): string {
  const explicitRegion = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (explicitRegion) return explicitRegion;
  const profile = env.AWS_PROFILE || 'default';
  const home = env.HOME || os.homedir();
  const configFile = env.AWS_CONFIG_FILE || path.join(home, '.aws', 'config');
  const credentialsFile = env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials');
  return profileRegion(configFile, profile === 'default' ? 'default' : `profile ${profile}`) ||
    profileRegion(credentialsFile, profile) || 'us-east-1';
}

/** Read a profile's top-level region without loading its credentials. */
function profileRegion(file: string, section: string): string | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let selected = false;
  let subsection = false;
  let region: string | undefined;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.split(/(^|\s)[;#]/)[0].trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      selected = line.slice(1, -1).replace(/^(profile)\s+["'](.+)["']$/, '$1 $2') === section;
      subsection = false;
      continue;
    }
    if (!selected || !line.includes('=')) continue;
    if (rawLine.trimStart() === rawLine) subsection = false;
    const equals = line.indexOf('=');
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!value) subsection = true;
    if (key === 'region' && value && !subsection) region = value;
  }
  return region;
}
