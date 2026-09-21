import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  fillSignInForm,
  findSignIn,
  inPageSignIn,
  PASSWORD_FIELDS,
  signInInPage,
  type PageArgument,
} from '../sign-in-form';

/**
 * Which field takes which value, and what submits the form.
 *
 * The page stands in for a browser here: a selector answers with the fields a test hands
 * it, so what is pinned is the order the rules are asked in rather than a CSS engine.
 */

const TIERS = ['tier-one', 'tier-two', 'tier-three'];
const SUBMIT = 'submit-control';

/** A field whose value is set through its prototype, as a real input's is. */
class Field {
  private held = '';
  disabled = false;
  form: Form | null = null;
  shadowRoot: null = null;
  focused = false;
  readonly events: string[] = [];
  constructor(private readonly hidden = false) {}
  get value(): string {
    return this.held;
  }
  set value(next: string) {
    this.held = next;
  }
  focus(): void {
    this.focused = true;
  }
  dispatchEvent(event: unknown): boolean {
    this.events.push((event as { type: string }).type);
    return true;
  }
  getClientRects(): { length: number } {
    return { length: this.hidden ? 0 : 1 };
  }
}

class Form {
  submitters: unknown[] = [];
  constructor(
    private readonly fields: Record<string, Field[]>,
    private readonly submitControl: Field | null = null,
  ) {}
  querySelectorAll(selector: string): Field[] {
    return this.fields[selector] ?? [];
  }
  querySelector(selector: string): Field | null {
    return selector === SUBMIT ? this.submitControl : null;
  }
  requestSubmit(submitter?: unknown): void {
    this.submitters.push(submitter);
  }
}

class Root {
  constructor(private readonly fields: Record<string, Field[]>) {}
  querySelectorAll(selector: string): Field[] {
    return this.fields[selector] ?? [];
  }
}

/** Run the in-page half against a document of the test's own. */
function inPage(
  document: Root,
  credentials: { username?: string | null; password?: string | null } | null,
) {
  const arg: PageArgument = {
    password: credentials?.password ?? null,
    username: credentials?.username ?? null,
    passwordFields: PASSWORD_FIELDS,
    usernameFields: TIERS,
    namedUsernameTiers: 2,
    submitControls: SUBMIT,
  };
  const globals = globalThis as unknown as { document?: Root };
  const previous = globals.document;
  globals.document = document;
  try {
    return signInInPage(arg);
  } finally {
    globals.document = previous;
  }
}

/** The site every fake frame is on, unless a test gives it another. */
const SITE = 'https://mail.example.com';

/** A tab whose frames answer with what the in-page half reports. */
function tab(
  frames: (ReturnType<typeof signInInPage> | Error)[],
  { closed = false, origins }: { closed?: boolean; origins?: string[] } = {},
) {
  const pressed: string[] = [];
  // Built once, so a test can see which frame was asked and which was passed over.
  const built = frames.map((answer, index) => ({
    url: () => `${origins?.[index] ?? SITE}/sign-in`,
    evaluate: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  }));
  const page = {
    isClosed: () => closed,
    keyboard: { press: vi.fn(async (key: string) => void pressed.push(key)) },
    waitForTimeout: vi.fn(async () => {}),
    frames: () => built,
  } as unknown as Page;
  return { page, pressed, frames: built };
}

/**
 * A tab whose one frame answers each ask in turn, and records what it was given. A
 * sign-in in two steps asks four times: the shape, the username, the shape again, the
 * password.
 */
function scripted(answers: ReturnType<typeof signInInPage>[]) {
  const asked: PageArgument[] = [];
  const pressed: string[] = [];
  // The wait between looks passes on a clock of the test's own, so a screen that never
  // comes runs out in milliseconds rather than in the seconds a person would wait.
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const frame = {
    url: () => `${SITE}/sign-in`,
    evaluate: vi.fn(async (_fn: unknown, arg: PageArgument) => {
      asked.push(arg);
      return answers[Math.min(asked.length - 1, answers.length - 1)];
    }),
  };
  const page = {
    isClosed: () => false,
    keyboard: { press: vi.fn(async (key: string) => void pressed.push(key)) },
    waitForTimeout: vi.fn(async (ms: number) => {
      now += ms;
    }),
    frames: () => [frame],
  } as unknown as Page;
  return { page, asked, pressed };
}

/**
 * The page runs this function on its own, with nothing of the runtime around it. The
 * transpiler that serves a development runtime wraps the functions inside it in a helper
 * of its own, and a page has none, so every sign-in read as missing until the page was
 * handed one.
 */
describe('the function handed to the page', () => {
  it('runs where the helpers around the runtime do not exist', () => {
    const password = new Field();
    const username = new Field();
    password.form = new Form({ [TIERS[0]]: [username] });
    const globals = globalThis as unknown as { document?: Root };
    const previous = globals.document;
    globals.document = new Root({ [PASSWORD_FIELDS]: [password] });

    try {
      // Called as the page calls it: a function built from source, with only its argument.
      expect(
        inPageSignIn({
          password: null,
          username: null,
          passwordFields: PASSWORD_FIELDS,
          usernameFields: TIERS,
          namedUsernameTiers: 2,
          submitControls: SUBMIT,
        }),
      ).toEqual({ found: true, username: true, submitted: false });
    } finally {
      globals.document = previous;
    }
  });

  it('carries the helper it may have been built with', () => {
    expect(inPageSignIn.toString()).toContain('__name');
  });
});

describe('filling a sign-in form', () => {
  it('fills both fields, tells the page about each, and submits with its own control', () => {
    const password = new Field();
    const username = new Field();
    const button = new Field();
    const form = new Form({ [TIERS[0]]: [username] }, button);
    password.form = form;

    const result = inPage(new Root({ [PASSWORD_FIELDS]: [password] }), {
      username: 'demo-user',
      password: 'a-password',
    });

    expect(result).toEqual({ found: true, username: true, submitted: true });
    expect(username.value).toBe('demo-user');
    expect(password.value).toBe('a-password');
    expect(password.events).toEqual(['input', 'change']);
    expect(form.submitters).toEqual([button]);
  });

  it('takes the plainest field only when no named one is there', () => {
    const password = new Field();
    const named = new Field();
    const plain = new Field();
    password.form = new Form({ [TIERS[1]]: [named], [TIERS[2]]: [plain] });
    inPage(new Root({ [PASSWORD_FIELDS]: [password] }), { username: 'demo-user', password: 'p' });

    expect(named.value).toBe('demo-user');
    expect(plain.value).toBe('');
  });

  it('never takes the password field itself for the username', () => {
    const password = new Field();
    password.form = new Form({ [TIERS[2]]: [password] });

    const result = inPage(new Root({ [PASSWORD_FIELDS]: [password] }), {
      username: 'demo-user',
      password: 'a-password',
    });

    expect(result.username).toBe(false);
    expect(password.value).toBe('a-password');
  });

  it('passes over a field nobody can see', () => {
    const hidden = new Field(true);
    const password = new Field();
    const document = new Root({ [PASSWORD_FIELDS]: [hidden, password] });

    inPage(document, { username: '', password: 'a-password' });

    expect(hidden.value).toBe('');
    expect(password.value).toBe('a-password');
  });

  it('focuses the password field on a page with no form of its own', () => {
    const password = new Field();

    const result = inPage(new Root({ [PASSWORD_FIELDS]: [password] }), {
      username: '',
      password: 'a-password',
    });

    expect(result.submitted).toBe(false);
    expect(password.focused).toBe(true);
  });

  it('answers a page with no password field', () => {
    expect(inPage(new Root({}), { username: 'u', password: 'p' })).toEqual({
      found: false,
      username: false,
      submitted: false,
    });
  });

  it('changes nothing when it is only asked whether the form is there', () => {
    const password = new Field();
    const username = new Field();
    password.form = new Form({ [TIERS[0]]: [username] });

    expect(inPage(new Root({ [PASSWORD_FIELDS]: [password] }), null)).toEqual({
      found: true,
      username: true,
      submitted: false,
    });
    expect(password.value).toBe('');
    expect(password.events).toEqual([]);
  });
});

describe('the sign-in across a page', () => {
  it('presses Enter when the page did not submit the form itself', async () => {
    const { page, pressed } = tab([{ found: true, username: true, submitted: false }]);

    expect(await fillSignInForm(page, { username: 'u', password: 'p' }, SITE)).toBe('filled');
    expect(pressed).toEqual(['Enter']);
  });

  it('leaves the keyboard alone when the form submitted itself', async () => {
    const { page, pressed } = tab([{ found: true, username: true, submitted: true }]);

    await fillSignInForm(page, { username: 'u', password: 'p' }, SITE);
    expect(pressed).toEqual([]);
  });

  it('carries on past a frame that has gone away, and takes the one that answers', async () => {
    const { page } = tab([
      new Error('Frame was detached'),
      { found: true, username: false, submitted: true },
    ]);

    expect(await fillSignInForm(page, { username: 'u', password: 'p' }, SITE)).toBe('filled');
  });

  it('reports a page with nothing to fill', async () => {
    const { page, pressed } = tab([{ found: false, username: false, submitted: false }]);

    expect(await fillSignInForm(page, { username: 'u', password: 'p' }, SITE)).toBe('no_form');
    expect(pressed).toEqual([]);
  });

  it('answers with the fields the page asks for, and nothing for a page with none', async () => {
    const both = tab([{ found: true, username: true, submitted: false }]);
    const passwordOnly = tab([{ found: true, username: false, submitted: false }]);
    const none = tab([{ found: false, username: false, submitted: false }]);

    expect(await findSignIn(both.page)).toEqual({ password: true, username: true, site: SITE });
    expect(await findSignIn(passwordOnly.page)).toEqual({
      password: true,
      username: false,
      site: SITE,
    });
    expect(await findSignIn(none.page)).toBeNull();
  });

  /**
   * A sign-in form is often an iframe from another origin, and that origin is what the
   * box names. Nothing else on the page is offered the credentials, whatever it holds.
   */
  it('names the frame holding the form, not the page around it', async () => {
    const { page } = tab(
      [
        { found: false, username: false, submitted: false },
        { found: true, username: true, submitted: false },
      ],
      { origins: ['https://news.example.com', 'https://accounts.example.com'] },
    );

    expect(await findSignIn(page)).toEqual({
      password: true,
      username: true,
      site: 'https://accounts.example.com',
    });
  });

  it('types into that frame alone, and into no other', async () => {
    const { page, frames } = tab(
      [
        { found: true, username: true, submitted: true },
        { found: true, username: true, submitted: true },
      ],
      { origins: ['https://evil.example.com', SITE] },
    );

    expect(await fillSignInForm(page, { username: 'u', password: 'p' }, SITE)).toBe('filled');
    expect(frames[0].evaluate).not.toHaveBeenCalled();
    expect(frames[1].evaluate).toHaveBeenCalled();
  });

  it('refuses a page whose frames have all moved to another site', async () => {
    const { page } = tab([{ found: true, username: true, submitted: true }], {
      origins: ['https://evil.example.com'],
    });

    expect(await fillSignInForm(page, { username: 'u', password: 'p' }, SITE)).toBe('no_form');
  });

  it('leaves a closed tab alone', async () => {
    const { page } = tab([{ found: true, username: true, submitted: true }], { closed: true });

    expect(await findSignIn(page)).toBeNull();
    expect(await fillSignInForm(page, { username: 'u', password: 'p' }, SITE)).toBe('no_form');
  });
});

/**
 * A sign-in that asks for the username first. The user answered one box, so the runtime
 * takes both screens: username, submit, wait for the password field, password, submit.
 */
describe('a sign-in in two steps', () => {
  const firstStep = { found: false, username: true, submitted: true };
  const secondStep = { found: true, username: false, submitted: true };

  it('types the username, then the password the next screen asks for', async () => {
    const { page, asked } = scripted([firstStep, firstStep, secondStep, secondStep]);

    expect(await fillSignInForm(page, { username: 'demo-user', password: 'a-password' }, SITE)).toBe(
      'filled',
    );
    expect(asked.map((arg) => [arg.username, arg.password])).toEqual([
      [null, null],
      ['demo-user', null],
      [null, null],
      [null, 'a-password'],
    ]);
  });

  it('waits for the password screen rather than giving up on the first look', async () => {
    const { page, asked } = scripted([
      firstStep,
      firstStep,
      firstStep, // still on the username screen
      secondStep,
      secondStep,
    ]);

    expect(await fillSignInForm(page, { username: 'demo-user', password: 'a-password' }, SITE)).toBe(
      'filled',
    );
    expect(asked).toHaveLength(5);
  });

  it('says so when the password screen never comes', async () => {
    const { page } = scripted([firstStep]);

    expect(await fillSignInForm(page, { username: 'demo-user', password: 'a-password' }, SITE)).toBe(
      'no_password_step',
    );
  });

  it('presses Enter for a step the page did not submit itself', async () => {
    const { page, pressed } = scripted([
      { ...firstStep, submitted: false },
      { ...firstStep, submitted: false },
      { ...secondStep, submitted: false },
      { ...secondStep, submitted: false },
    ]);

    await fillSignInForm(page, { username: 'demo-user', password: 'a-password' }, SITE);
    expect(pressed).toEqual(['Enter', 'Enter']);
  });
});
