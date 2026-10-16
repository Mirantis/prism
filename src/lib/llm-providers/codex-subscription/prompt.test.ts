import { describe, expect, it } from 'vitest';
import { codexPrompt } from './prompt';
import type { CallOptions } from './types';

describe('codexPrompt', () => {
  it('passes an image as an input and names a file the model cannot read', () => {
    const prompt = codexPrompt({ prompt: [{ role: 'user', content: [
      { type: 'text', text: 'Look at these' },
      { type: 'file', data: 'aW1n', mediaType: 'image/png' },
      { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf', filename: 'report.pdf' },
    ] }] } as CallOptions);
    expect(prompt.input).toHaveLength(2);
    expect(prompt.input[1]).toEqual({ type: 'image', url: 'data:image/png;base64,aW1n' });
    const transcript = JSON.parse((prompt.input[0] as { text: string }).text);
    expect(JSON.stringify(transcript)).toContain('[Attached image 1]');
    expect(JSON.stringify(transcript)).toContain('report.pdf (application/pdf): this model cannot read it');
  });
});
