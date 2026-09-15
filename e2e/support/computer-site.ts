import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/** A real website with a sign-in step and an independent public page. */
export async function startComputerSite(): Promise<{
  url: string;
  close: () => Promise<void>;
  isSignedIn: () => boolean;
}> {
  let signedIn = false;
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/sign-in') {
      signedIn = true;
      req.resume();
      res.writeHead(303, {
        'set-cookie': 'computer-test-login=yes; Path=/; HttpOnly',
        location: '/inbox',
      });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const content =
      req.url === '/notes'
        ? '<h1>Public notes</h1><p>Reference: NOTES-42. The workshop starts at 10:00.</p>'
        : req.headers.cookie?.includes('computer-test-login=yes')
          ? '<h1>Your inbox</h1><p>INBOX-CLEAR: Your parcel arrives on Friday.</p>'
          : '<h1>Sign in to your inbox</h1><p>Please ask your user to sign in.</p><form method="post" action="/sign-in"><label>Username <input name="username" autofocus required></label><button>Sign in</button></form>';
    res.end(
      `<!doctype html><title>Computer test</title><body style="font:20px system-ui;padding:64px;background:#f4f4f5;color:#18181b">${content}</body>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    isSignedIn: () => signedIn,
    url: `http://${randomUUID()}.localhost:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
