import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/** The page whose sign-in takes a username and a password together. */
function mailPage(signedIn: boolean): string {
  if (signedIn) return '<h1>Your mail</h1><p>MAIL-CLEAR: The invoice was paid on Tuesday.</p>';
  return (
    '<h1>Sign in to your mail</h1><p>Please ask your user for the username and password.</p>' +
    '<form method="post" action="/sign-in-mail">' +
    '<label>Username <input name="username" autocomplete="username" required></label> ' +
    '<label>Password <input type="password" name="password" autocomplete="current-password" required></label> ' +
    '<button>Sign in</button></form>'
  );
}

/**
 * The same sign-in asked over two screens, the way a large provider asks it: the username
 * first, the password only once the site knows who is signing in.
 */
function filesPage(user: string | null, signedIn: boolean): string {
  if (signedIn) return '<h1>Your files</h1><p>FILES-CLEAR: The contract was signed on Monday.</p>';
  if (!user) {
    return (
      '<h1>Sign in to your files</h1><p>Enter your username to continue.</p>' +
      '<form method="post" action="/files-username">' +
      '<label>Username <input name="username" autocomplete="username" required></label> ' +
      '<button>Next</button></form>'
    );
  }
  return (
    `<h1>Welcome back, ${user}</h1><p>Enter your password.</p>` +
    '<form method="post" action="/files-password">' +
    '<label>Password <input type="password" name="password" autocomplete="current-password" required></label> ' +
    '<button>Sign in</button></form>'
  );
}

/**
 * A sign-in approved on another device. The page reloads itself until the test approves
 * it, the way a real approval page polls, so the next look at the screen shows the result.
 */
function approvalPage(approved: boolean): string {
  if (approved) return '<h1>Your report</h1><p>REPORT-READY: The quarter closed 4% over plan.</p>';
  return (
    '<h1>Approve this sign-in</h1><p>Open the app on your phone and approve the sign-in. ' +
    'This page updates by itself.</p><script>setTimeout(() => location.reload(), 2000);</script>'
  );
}

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
 * The inbox sign-in form reports how much its password field holds, so a test can see
 * what reached the field without reading the agent's browser itself. The mail page is the
 * other kind: a username and a password together, which is what the agent asks its user
 * to fill in rather than to type on the desktop, and it reports what was posted to it.
 */
export async function startComputerSite(): Promise<{
  url: string;
  close: () => Promise<void>;
  isSignedIn: () => boolean;
  passwordLength: () => number;
  signInPageLoads: () => number;
  mailCredentials: () => { username: string; password: string } | null;
  filesCredentials: () => { username: string; password: string } | null;
  approve: () => void;
}> {
  let signedIn = false;
  let approved = false;
  let passwordLength = 0;
  let signInPageLoads = 0;
  let mailCredentials: { username: string; password: string } | null = null;
  let filesUser: string | null = null;
  let filesCredentials: { username: string; password: string } | null = null;
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/typed')) {
      passwordLength = Number(new URL(req.url, 'http://site').searchParams.get('length')) || 0;
      req.resume();
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/files-username') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        filesUser = new URLSearchParams(body).get('username');
        res.writeHead(303, { location: '/files' });
        res.end();
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/files-password') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        filesCredentials = {
          username: filesUser ?? '',
          password: new URLSearchParams(body).get('password') ?? '',
        };
        res.writeHead(303, {
          'set-cookie': 'computer-test-files=yes; Path=/; HttpOnly',
          location: '/files',
        });
        res.end();
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/sign-in-mail') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const posted = new URLSearchParams(body);
        mailCredentials = {
          username: posted.get('username') ?? '',
          password: posted.get('password') ?? '',
        };
        res.writeHead(303, {
          'set-cookie': 'computer-test-mail=yes; Path=/; HttpOnly',
          location: '/mail',
        });
        res.end();
      });
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
    if (
      req.url !== '/notes' &&
      req.url !== '/files' &&
      req.url !== '/mail' &&
      req.url !== '/approval' &&
      !req.headers.cookie?.includes('computer-test-login=yes')
    ) {
      signInPageLoads += 1;
    }
    const content =
      req.url === '/notes'
        ? '<h1>Public notes</h1><p>Reference: NOTES-42. The workshop starts at 10:00.</p>'
        : req.url === '/files'
          ? filesPage(filesUser, req.headers.cookie?.includes('computer-test-files=yes') ?? false)
        : req.url === '/mail'
          ? mailPage(req.headers.cookie?.includes('computer-test-mail=yes') ?? false)
        : req.url === '/approval'
          ? approvalPage(approved)
          : req.headers.cookie?.includes('computer-test-login=yes')
          ? '<h1>Your inbox</h1><p>INBOX-CLEAR: Your parcel arrives on Friday.</p>'
          : '<h1>Sign in to your inbox</h1><p>Please ask your user to sign in.</p>' +
            // The field is on the page only once the user has said they want to type one,
            // which is what a site offering several ways in looks like. Nothing is visible
            // to fill at the moment the agent asks for help, so this sign-in is one for
            // the desktop rather than for the box.
            `<form method="post" action="/sign-in"${req.url === '/inbox?password=1' ? '' : ' hidden'}>` +
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
    mailCredentials: () => mailCredentials,
    filesCredentials: () => filesCredentials,
    approve: () => {
      approved = true;
    },
    url: `http://${randomUUID()}.localhost:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
