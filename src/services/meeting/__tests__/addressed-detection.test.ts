import { describe, it, expect } from 'vitest';
import { isAddressedToAgent } from '../addressed-detection';

describe('isAddressedToAgent', () => {
  it('recognizes the agent by name', () => {
    expect(isAddressedToAgent('Prism, can you check the cluster?', 'Prism')).toBe(true);
    expect(isAddressedToAgent('what does prism think', 'Prism')).toBe(true);
  });

  it('ignores talk that merely contains the name as a substring', () => {
    // "prismatic" must not summon Prism.
    expect(isAddressedToAgent('the prismatic effect on the chart', 'Prism')).toBe(false);
  });

  it('ignores ordinary cross-talk between people', () => {
    expect(isAddressedToAgent('so I told Dana we would ship on Friday', 'Prism')).toBe(false);
  });

  it('recognizes a direct address without the name', () => {
    expect(isAddressedToAgent('Are you there?', 'Prism')).toBe(true);
    expect(isAddressedToAgent('what do you think about that', 'Prism')).toBe(true);
  });

  it('handles an empty or whitespace transcript', () => {
    expect(isAddressedToAgent('', 'Prism')).toBe(false);
    expect(isAddressedToAgent('   ', 'Prism')).toBe(false);
  });

  it('treats a name with regex characters literally', () => {
    // A name like "C++" must not be compiled as a quantifier.
    expect(() => isAddressedToAgent('anything at all', 'C++')).not.toThrow();
    expect(isAddressedToAgent('hey C++ what is up', 'C++')).toBe(true);
  });

  it('still detects a direct address when the agent has no name', () => {
    expect(isAddressedToAgent('are you there', '')).toBe(true);
    expect(isAddressedToAgent('unrelated chatter', '')).toBe(false);
  });
});
