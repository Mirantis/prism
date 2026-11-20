import { describe, expect, it } from 'vitest';
import { namesVariable, settingParts } from './provider-settings';

describe('settingParts', () => {
  it('returns a bare variable name as one variable part', () => {
    expect(settingParts('OPENAI_API_KEY')).toEqual([{ kind: 'variable', name: 'OPENAI_API_KEY' }]);
  });

  it('splits alternatives into a part per variable name', () => {
    expect(settingParts('AZURE_RESOURCE_NAME (or AZURE_FOUNDRY_BASE_URL)')).toEqual([
      { kind: 'variable', name: 'AZURE_RESOURCE_NAME' },
      { kind: 'text', text: ' (or ' },
      { kind: 'variable', name: 'AZURE_FOUNDRY_BASE_URL' },
      { kind: 'text', text: ')' },
    ]);
  });

  it('keeps a step that is not a variable as text', () => {
    expect(settingParts('ChatGPT sign-in')).toEqual([{ kind: 'text', text: 'ChatGPT sign-in' }]);
    expect(namesVariable('ChatGPT sign-in')).toBe(false);
  });
});
