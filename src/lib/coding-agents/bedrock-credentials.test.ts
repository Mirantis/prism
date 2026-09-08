import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bedrockRegion } from './bedrock-credentials';

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-profile-'));
  env = { AWS_PROFILE: 'review-profile', AWS_CONFIG_FILE: path.join(root, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(root, 'credentials') };
  fs.writeFileSync(env.AWS_CONFIG_FILE!, '[default]\nregion=eu-west-1\n[profile review-profile]\nregion = us-west-2\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('coding agent AWS region', () => {
  it('preserves the selected profile region', () => {
    expect(bedrockRegion(env)).toBe('us-west-2');
  });
  it('uses the default profile when no profile is selected', () => {
    delete env.AWS_PROFILE;
    expect(bedrockRegion(env)).toBe('eu-west-1');
  });
  it('prefers environment regions over profile settings', () => {
    expect(bedrockRegion({ ...env, AWS_DEFAULT_REGION: 'eu-north-1' })).toBe('eu-north-1');
    expect(bedrockRegion({ ...env, AWS_REGION: 'eu-central-1', AWS_DEFAULT_REGION: 'eu-north-1' })).toBe('eu-central-1');
  });
  it('uses a credentials-file region when the config has none', () => {
    fs.writeFileSync(env.AWS_CONFIG_FILE!, '[profile review-profile]\noutput=json\n');
    fs.writeFileSync(env.AWS_SHARED_CREDENTIALS_FILE!, '[review-profile]\nregion=ap-south-1\n');
    expect(bedrockRegion(env)).toBe('ap-south-1');
  });
  it('uses the runtime default when neither file supplies a region', () => {
    fs.unlinkSync(env.AWS_CONFIG_FILE!);
    expect(bedrockRegion(env)).toBe('us-east-1');
  });
  it('handles comments and ignores nested service settings', () => {
    fs.writeFileSync(env.AWS_CONFIG_FILE!, '[profile "review-profile"]\r\nregion=us-west-2 # regional endpoint\r\ns3=\r\n  region=eu-west-1\r\n');
    expect(bedrockRegion(env)).toBe('us-west-2');
  });
});
