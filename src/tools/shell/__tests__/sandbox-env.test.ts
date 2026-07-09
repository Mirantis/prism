import { describe, it, expect } from 'vitest';
import { sandboxEnv } from '../sandbox-env';

describe('sandboxEnv', () => {
  it('strips NODE_ENV from the returned environment', () => {
    const base = { NODE_ENV: 'production', PATH: '/usr/bin', HOME: '/root' };
    const result = sandboxEnv(base);

    expect(result.NODE_ENV).toBeUndefined();
    expect('NODE_ENV' in result).toBe(false);
  });

  it('preserves PATH, HOME, and other vars', () => {
    const base = {
      NODE_ENV: 'production',
      PATH: '/usr/bin',
      HOME: '/home/user',
      AWS_REGION: 'us-east-1',
      GH_TOKEN: 'ghp_abc',
    };
    const result = sandboxEnv(base);

    expect(result.PATH).toBe('/usr/bin');
    expect(result.HOME).toBe('/home/user');
    expect(result.AWS_REGION).toBe('us-east-1');
    expect(result.GH_TOKEN).toBe('ghp_abc');
  });

  it('does not mutate the input object', () => {
    const base = { NODE_ENV: 'production', PATH: '/usr/bin' };
    sandboxEnv(base);

    expect(base.NODE_ENV).toBe('production');
  });

  it('uses process.env as default base', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const result = sandboxEnv();
      expect(result.NODE_ENV).toBeUndefined();
      expect(result.PATH).toBe(process.env.PATH);
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it('works with explicit base argument', () => {
    const custom = { NODE_ENV: 'test', CUSTOM_VAR: 'hello' };
    const result = sandboxEnv(custom);

    expect(result.NODE_ENV).toBeUndefined();
    expect(result.CUSTOM_VAR).toBe('hello');
  });
});
