import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  fillSignInForm,
  hasSignInForm,
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
function inPage(document: Root, credentials: { username: string; password: string } | null) {
  const arg: PageArgument = {
    password: credentials?.password ?? null,
    username: credentials?.username ?? '',
    passwordFields: PASSWORD_FIELDS,
    usernameFields: TIERS,
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

/** A tab whose frames answer with what the in-page half reports. */
function tab(frames: (ReturnType<typeof signInInPage> | Error)[], closed = false) {
  const pressed: string[] = [];
  const page = {
    isClosed: () => closed,
    keyboard: { press: vi.fn(async (key: string) => void pressed.push(key)) },
    frames: () =>
      frames.map((answer) => ({
        evaluate: vi.fn(async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        }),
      })),
  } as unknown as Page;
  return { page, pressed };
}

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

    expect(await fillSignInForm(page, { username: 'u', password: 'p' })).toBe('filled');
    expect(pressed).toEqual(['Enter']);
  });

  it('leaves the keyboard alone when the form submitted itself', async () => {
    const { page, pressed } = tab([{ found: true, username: true, submitted: true }]);

    await fillSignInForm(page, { username: 'u', password: 'p' });
    expect(pressed).toEqual([]);
  });

  it('carries on past a frame that has gone away, and takes the one that answers', async () => {
    const { page } = tab([
      new Error('Frame was detached'),
      { found: true, username: false, submitted: true },
    ]);

    expect(await fillSignInForm(page, { username: 'u', password: 'p' })).toBe('filled');
  });

  it('reports a page with nothing to fill', async () => {
    const { page, pressed } = tab([{ found: false, username: false, submitted: false }]);

    expect(await fillSignInForm(page, { username: 'u', password: 'p' })).toBe('no_form');
    expect(pressed).toEqual([]);
  });

  it('is a sign-in for the box only when both fields are there', async () => {
    const both = tab([{ found: true, username: true, submitted: false }]);
    const passwordOnly = tab([{ found: true, username: false, submitted: false }]);

    expect(await hasSignInForm(both.page)).toBe(true);
    expect(await hasSignInForm(passwordOnly.page)).toBe(false);
  });

  it('leaves a closed tab alone', async () => {
    const { page } = tab([{ found: true, username: true, submitted: true }], true);

    expect(await hasSignInForm(page)).toBe(false);
    expect(await fillSignInForm(page, { username: 'u', password: 'p' })).toBe('no_form');
  });
});
