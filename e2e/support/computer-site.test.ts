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

describe('the sign-in approved on another device', () => {
  it('waits for the approval, reloading itself, and then shows the report', async () => {
    site = await startComputerSite();

    const waiting = await (await fetch(`${address(site.url)}/approval`)).text();
    expect(waiting).toContain('Approve this sign-in');
    expect(waiting).toContain('location.reload()');
    expect(waiting).not.toContain('REPORT-READY');

    site.approve();

    const approved = await (await fetch(`${address(site.url)}/approval`)).text();
    expect(approved).toContain('REPORT-READY');
    expect(approved).not.toContain('location.reload()');
  });
});

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

/**
 * Which route a sign-in takes is decided by what the page shows. The inbox keeps its
 * field until somebody asks for it, so that request is one for the desktop; the mail and
 * files pages show theirs, so the box can answer them.
 */
describe('what each sign-in page offers', () => {
  async function body(path: string): Promise<string> {
    return (await fetch(`${address(site!.url)}${path}`)).text();
  }

  it('hides the inbox field until the address asks for it', async () => {
    site = await startComputerSite();

    expect(await body('/inbox')).toContain('type="password"');
    expect(await body('/inbox')).toMatch(/<form[^>]*hidden/);
    expect(await body('/inbox?password=1')).not.toMatch(/<form[^>]*hidden/);
  });

  it('shows the mail page a username and a password at once', async () => {
    site = await startComputerSite();

    const page = await body('/mail');
    expect(page).toContain('autocomplete="username"');
    expect(page).toContain('type="password"');
  });

  it('asks the files page for the username first, and the password after it', async () => {
    site = await startComputerSite();

    expect(await body('/files')).toContain('autocomplete="username"');
    expect(await body('/files')).not.toContain('type="password"');

    await fetch(`${address(site!.url)}/files-username`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'demo-user' }).toString(),
      redirect: 'manual',
    });

    expect(await body('/files')).toContain('type="password"');
  });
});
