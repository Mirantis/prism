// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

describe('test setup', () => {
  it('lets a test end with its component still mounted', () => {
    render(<p>left mounted</p>);
    expect(document.body.textContent).toContain('left mounted');
  });

  it('starts the next test with nothing rendered', () => {
    expect(document.body.textContent).toBe('');
  });
});
