import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * The password the site accepts, which only the test knows.
 *
 * The agent has the computer tools and a form in front of it, so it does try the sign-in
 * itself. A site that took any password would be signed in by that attempt, and every
 * assertion about what the person typed would be answered by the agent's own click.
 */
export const SIGN_IN_PASSWORD = 'a-password-prism-never-sees';

/**
 * A real website with a sign-in step and an independent public page.
 *
 * The sign-in form reports how much its password field holds, so a test can see what
 * reached the field without reading the agent's browser itself.
 */
export async function startComputerSite(): Promise<{
  url: string;
  close: () => Promise<void>;
  isSignedIn: () => boolean;
  passwordLength: () => number;
  signInPageLoads: () => number;
}> {
  let signedIn = false;
  let passwordLength = 0;
  let signInPageLoads = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/typed')) {
      passwordLength = Number(new URL(req.url, 'http://site').searchParams.get('length')) || 0;
      req.resume();
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/sign-in') {
      const body: Buffer[] = [];
      req.on('data', (chunk: Buffer) => body.push(chunk));
      req.on('end', () => {
        const sent = new URLSearchParams(Buffer.concat(body).toString()).get('password');
        // A wrong password lands back on the sign-in page, with no session.
        if (sent !== SIGN_IN_PASSWORD) {
          res.writeHead(303, { location: '/inbox' });
          res.end();
          return;
        }
        signedIn = true;
        res.writeHead(303, {
          'set-cookie': 'computer-test-login=yes; Path=/; HttpOnly',
          location: '/inbox',
        });
        res.end();
      });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url !== '/notes' && !req.headers.cookie?.includes('computer-test-login=yes')) {
      signInPageLoads += 1;
    }
    const content =
      req.url === '/notes'
        ? '<h1>Public notes</h1><p>Reference: NOTES-42. The workshop starts at 10:00.</p>'
        : req.headers.cookie?.includes('computer-test-login=yes')
          ? '<h1>Your inbox</h1><p>INBOX-CLEAR: Your parcel arrives on Friday.</p>'
          : '<h1>Sign in to your inbox</h1><p>Please ask your user to sign in.</p>' +
            '<form method="post" action="/sign-in">' +
            '<label>Password <input type="password" name="password" autofocus required></label> ' +
            '<button>Sign in</button></form>' +
            '<script>const field = document.querySelector("input[type=password]");' +
            'field.addEventListener("input", () => ' +
            'fetch("/typed?length=" + field.value.length, { method: "POST" }));' +
            // A viewer sends keystrokes, not clicks, so the field takes focus back when
            // it loses it: where the agent left the caret before asking for help is its
            // own business, and it varies from run to run.
            'field.addEventListener("blur", () => setTimeout(() => field.focus(), 0));' +
            'field.focus();</script>';
    res.end(
      `<!doctype html><title>Computer test</title><body style="font:20px system-ui;padding:64px;background:#f4f4f5;color:#18181b">${content}</body>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    isSignedIn: () => signedIn,
    passwordLength: () => passwordLength,
    signInPageLoads: () => signInPageLoads,
    url: `http://${randomUUID()}.localhost:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
