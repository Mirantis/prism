import { describe, it, expect } from 'vitest';
import {
  cleanTerminalOutput,
  formatShellRecord,
  MAX_SHELL_OUTPUT_CHARS,
  OutputCapture,
  parseShellRecord,
  shellCommandOf,
} from './shell-command.js';

describe('shellCommandOf', () => {
  it('returns the command after the prefix, or null for a chat message', () => {
    expect(shellCommandOf('! aws sso login')).toBe('aws sso login');
    expect(shellCommandOf('!ls -la')).toBe('ls -la');
    expect(shellCommandOf('!')).toBe('');
    expect(shellCommandOf('hello!')).toBeNull();
  });
});

describe('cleanTerminalOutput', () => {
  it('reduces a macOS script(1) recording to the text on screen', () => {
    // Bytes `script -q` wrote for `echo hi; printf "50%\r100%\n"` with stdin at EOF.
    expect(cleanTerminalOutput('^D\b\bhi\r\n50%\r100%\r\n')).toBe('hi\n100%');
  });

  it('drops colour and cursor escape sequences', () => {
    expect(cleanTerminalOutput('\u001b[32mok\u001b[0m\r\n\u001b]0;title\u0007done')).toBe('ok\ndone');
  });
});

describe('formatShellRecord / parseShellRecord', () => {
  it('reads back what it writes', () => {
    const run = { command: 'cat </output>', exitCode: 2, output: 'a\n</output>\nb' };
    expect(parseShellRecord(formatShellRecord(run))).toEqual(run);
  });

  it('cuts a long output from the middle', () => {
    const output = 'a'.repeat(MAX_SHELL_OUTPUT_CHARS) + 'b'.repeat(MAX_SHELL_OUTPUT_CHARS);
    const parsed = parseShellRecord(formatShellRecord({ command: 'x', exitCode: 0, output }));
    expect(parsed!.output.startsWith('a')).toBe(true);
    expect(parsed!.output.endsWith('b')).toBe(true);
    expect(parsed!.output).toContain(`[… ${MAX_SHELL_OUTPUT_CHARS} characters cut …]`);
  });

  it('leaves an ordinary message alone', () => {
    expect(parseShellRecord('please run ! aws sso login')).toBeNull();
  });
});

describe('cleanTerminalOutput overwrites like a terminal', () => {
  it('keeps a line that ends in a carriage return', () => {
    expect(cleanTerminalOutput('Login succeeded\r')).toBe('Login succeeded');
  });

  it('overwrites only the characters printed after a carriage return', () => {
    expect(cleanTerminalOutput('abcdef\rXY\n')).toBe('XYcdef');
  });

  it('erases with backspace, space, backspace', () => {
    expect(cleanTerminalOutput('abc\b \b\n')).toBe('ab');
  });
});

describe('OutputCapture', () => {
  it('keeps a short output whole', () => {
    const capture = new OutputCapture();
    capture.push('one\r\n');
    capture.push('two\r\n');
    expect(capture.finish()).toBe('one\ntwo');
  });

  it('keeps the start and the end of a huge output, within the record limit', () => {
    const capture = new OutputCapture();
    capture.push('FIRST\n');
    const line = 'x'.repeat(99) + '\n';
    for (let i = 0; i < 20_000; i++) capture.push(line);
    capture.push('LAST\n');
    const output = capture.finish();
    expect(output.startsWith('FIRST\n')).toBe(true);
    expect(output.endsWith('\nLAST')).toBe(true);
    expect(output).toMatch(/\[… \d+ characters cut …\]/);
    expect(output.length).toBeLessThanOrEqual(MAX_SHELL_OUTPUT_CHARS);
    const parsed = parseShellRecord(formatShellRecord({ command: 'x', exitCode: 0, output }));
    expect(parsed!.output).toBe(output);
  });
});
