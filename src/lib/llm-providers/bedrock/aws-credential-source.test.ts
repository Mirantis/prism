/**
 * Runs the real AWS default chain, so a change in how the SDK reports "no
 * source" fails here. Each test reloads the module, which drops the found latch.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

async function check(): Promise<boolean> {
  vi.resetModules();
  const { hasAwsCredentialSource } = await import('./aws-credential-source');
  return hasAwsCredentialSource();
}

/** A machine with no AWS setup: every source the chain reads is empty or absent. */
function stubNoSource(): void {
  for (const name of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', path.join(dir, 'credentials'));
  vi.stubEnv('AWS_CONFIG_FILE', path.join(dir, 'config'));
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
  // The SSO token cache is read under the home directory.
  vi.stubEnv('HOME', dir);
}

describe('hasAwsCredentialSource', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aws-source-'));
    stubNoSource();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers false when no source is set up', async () => {
    expect(await check()).toBe(false);
  });

  it('answers true for keys in the environment', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'example-secret');
    expect(await check()).toBe(true);
  });

  it('answers true for a profile in the shared credentials file', async () => {
    writeFileSync(
      path.join(dir, 'credentials'),
      '[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = example-secret\n',
    );
    expect(await check()).toBe(true);
  });

  it('answers true for an SSO profile that has no valid login', async () => {
    writeFileSync(
      path.join(dir, 'config'),
      [
        '[profile work]',
        'sso_session = work',
        'sso_account_id = 111111111111',
        'sso_role_name = Example',
        '[sso-session work]',
        'sso_start_url = https://example.awsapps.com/start',
        'sso_region = us-east-1',
        '',
      ].join('\n'),
    );
    vi.stubEnv('AWS_PROFILE', 'work');
    expect(await check()).toBe(true);
  });

  it('looks again after a miss, and finds a source added since', async () => {
    vi.resetModules();
    const { hasAwsCredentialSource } = await import('./aws-credential-source');
    expect(await hasAwsCredentialSource()).toBe(false);
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'example-secret');
    expect(await hasAwsCredentialSource()).toBe(true);
  });
});
