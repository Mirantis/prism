// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CodeBlock, { languageOf } from './code-block';

afterEach(cleanup);

describe('languageOf', () => {
  it('reads the whole language token, including one that ends in #', () => {
    expect(languageOf(<code className="language-c#">x</code>)).toBe('c#');
    expect(languageOf(<code className="language-f#">x</code>)).toBe('f#');
    expect(languageOf(<code className="language-c++">x</code>)).toBe('c++');
    expect(languageOf(<code className="language-bash">x</code>)).toBe('bash');
  });

  it('has no language for a block that declares none', () => {
    expect(languageOf(<code>x</code>)).toBeNull();
    expect(languageOf('plain text')).toBeNull();
  });
});

describe('CodeBlock', () => {
  it('labels the block with its language, or "text" without one', () => {
    render(
      <CodeBlock>
        <code className="language-c#">Console.WriteLine();</code>
      </CodeBlock>,
    );
    expect(screen.getByTestId('code-language')).toHaveTextContent('c#');
    cleanup();
    render(
      <CodeBlock>
        <code>plain</code>
      </CodeBlock>,
    );
    expect(screen.getByTestId('code-language')).toHaveTextContent('text');
  });
});
