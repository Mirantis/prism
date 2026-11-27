import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { SignInPanel } from './SignInPanel.js';
import type { ApiClient } from '../api-client.js';
import { flush, type } from '../testing/ink-keys.js';

/**
 * The panel a sign-in is answered in.
 *
 * What is worth pinning is that the password is never on the screen, that both values
 * reach the runtime, and that the panel closes on the answer either way.
 */

const REQUEST = {
  id: '00000000-0000-4000-8000-000000000004',
  reason: 'Sign in to the inbox',
  site: 'https://mail.example.com',
};

function stubApi(signIn = vi.fn().mockResolvedValue({ success: true })): ApiClient {
  return { signInForComputer: signIn } as unknown as ApiClient;
}

const TAB = '\t';
const ENTER = '\r';
const ESCAPE = '\x1B';

/**
 * Ink holds a lone trailing ESC for ~20ms to tell it from a longer escape sequence, so
 * that key waits past the window; every other one only needs its own render.
 */
async function pressEscape(stdin: { write: (data: string) => void }): Promise<void> {
  stdin.write(ESCAPE);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flush();
}

describe('the terminal sign-in panel', () => {
  it('shows the reason and the site, and never the password', async () => {
    const { lastFrame, stdin, unmount } = render(
      <SignInPanel api={stubApi()} request={REQUEST} onClose={vi.fn()} />,
    );

    await type(stdin, 'demo-user', TAB, 'a-password');

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sign in to the inbox');
    expect(frame).toContain('https://mail.example.com');
    expect(frame).toContain('demo-user');
    expect(frame).not.toContain('a-password');
    expect(frame).toContain('••••••••••');
    unmount();
  });

  it('sends both values and closes', async () => {
    const signIn = vi.fn().mockResolvedValue({ success: true });
    const onClose = vi.fn();
    const { stdin, unmount } = render(
      <SignInPanel api={stubApi(signIn)} request={REQUEST} onClose={onClose} />,
    );

    await type(stdin, 'demo-user', TAB, 'a-password', ENTER);

    expect(signIn).toHaveBeenCalledWith(REQUEST.id, {
      username: 'demo-user',
      password: 'a-password',
    });
    expect(onClose).toHaveBeenCalled();
    unmount();
  });

  it('keeps the panel open and says what stopped a sign-in', async () => {
    const signIn = vi.fn().mockRejectedValue(new Error('That tab is on another site now.'));
    const onClose = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <SignInPanel api={stubApi(signIn)} request={REQUEST} onClose={onClose} />,
    );

    await type(stdin, TAB, 'a-password', ENTER);

    expect(lastFrame()).toContain('That tab is on another site now.');
    expect(onClose).not.toHaveBeenCalled();
    unmount();
  });

  it('sends nothing without a password', async () => {
    const signIn = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <SignInPanel api={stubApi(signIn)} request={REQUEST} onClose={vi.fn()} />,
    );

    await type(stdin, 'demo-user', ENTER);

    expect(signIn).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('A password is required.');
    unmount();
  });

  it('closes on escape without sending anything', async () => {
    const signIn = vi.fn();
    const onClose = vi.fn();
    const { stdin, unmount } = render(
      <SignInPanel api={stubApi(signIn)} request={REQUEST} onClose={onClose} />,
    );

    await pressEscape(stdin);

    expect(onClose).toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    unmount();
  });
});
