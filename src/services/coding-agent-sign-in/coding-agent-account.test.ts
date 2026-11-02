import { describe, expect, it } from 'vitest';
import { planName } from './coding-agent-account';

describe('planName', () => {
  it('names the plan the login reports', () => {
    expect(planName('Claude', 'max')).toBe('Claude Max');
    expect(planName('ChatGPT', 'plus')).toBe('ChatGPT Plus');
  });

  it('assumes no plan when the login names none', () => {
    expect(planName('ChatGPT', undefined)).toBe('ChatGPT plan');
    expect(planName('ChatGPT', ' ')).toBe('ChatGPT plan');
  });
});
