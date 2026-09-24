/**
 * The sign-in site's own rules.
 *
 * The site accepts one password, which only the test knows, so the agent's own attempt at
 * the form cannot stand in for what the person typed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SIGN_IN_PASSWORD, startComputerSite } from './computer-site';

let site: Awaited<ReturnType<typeof startComputerSite>> | undefined;

afterEach(async () => {
  await site?.close();
  site = undefined;
});

/** The site answers on loopback; its own url carries a subdomain a test browser resolves. */
function address(url: string): string {
  return `http://127.0.0.1:${new URL(url).port}`;
}

async function signIn(password: string): Promise<{ cookie: string | null }> {
  const response = await fetch(`${address(site!.url)}/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
    redirect: 'manual',
  });
  return { cookie: response.headers.get('set-cookie') };
}

describe('the sign-in site', () => {
  it('refuses a password it was not given, and says so by serving the form again', async () => {
    site = await startComputerSite();

    const { cookie } = await signIn('whatever-the-agent-guessed');

    expect(cookie).toBeNull();
    expect(site.isSignedIn()).toBe(false);
    const page = await (await fetch(`${address(site.url)}/inbox`)).text();
    expect(page).toContain('Sign in to your inbox');
    expect(page).not.toContain('INBOX-CLEAR');
  });

  it('accepts the password the test types, and then holds a session', async () => {
    site = await startComputerSite();

    const { cookie } = await signIn(SIGN_IN_PASSWORD);

    expect(cookie).toContain('computer-test-login=yes');
    expect(site.isSignedIn()).toBe(true);
    const page = await (
      await fetch(`${address(site.url)}/inbox`, { headers: { cookie: 'computer-test-login=yes' } })
    ).text();
    expect(page).toContain('INBOX-CLEAR');
  });

  it('counts the sign-in page it serves, which is how a test waits for the one it asked for', async () => {
    site = await startComputerSite();
    expect(site.signInPageLoads()).toBe(0);

    await fetch(`${address(site.url)}/inbox`);
    await fetch(`${address(site.url)}/notes`);

    // The notes are readable without signing in, and are not that page.
    expect(site.signInPageLoads()).toBe(1);
  });
});
