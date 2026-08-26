import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_MD } from './default-workspace';

describe('DEFAULT_AGENT_MD', () => {
  it('requires tool-backed completion claims and share_file sequencing', () => {
    expect(DEFAULT_AGENT_MD).toMatch(/## Completion claims/);
    expect(DEFAULT_AGENT_MD).toMatch(/same turn/);
    expect(DEFAULT_AGENT_MD).toMatch(/share_file/);
    expect(DEFAULT_AGENT_MD).toMatch(/intent/i);
  });
});
