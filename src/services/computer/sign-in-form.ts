/**
 * The sign-in form on a page, found and filled by rule.
 *
 * A help request the model marks as a plain sign-in is answered with a username and a
 * password the user types in their own client. The runtime types those into the blocked
 * tab and submits the form. Which field takes which value is decided here, by selectors
 * in a fixed order, so the same page always answers the same way and no model sees what
 * was typed.
 */

import type { Page } from 'playwright-core';
import { logger } from '../../logger';
import { withTimeout } from '../../utils/with-timeout';

/**
 * A field holding a password: the ordinary one, and the one a "show password" control has
 * turned into plain text, which keeps its autocomplete name.
 */
export const PASSWORD_FIELDS = 'input[type="password" i], input[autocomplete*="password" i]';

/** Where the username goes, most explicit first. The first tier with a field wins. */
const USERNAME_FIELDS = [
  'input[autocomplete="username" i], input[autocomplete="email" i]',
  'input[type="email" i], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]',
  'input[type="text" i], input[type="tel" i], input:not([type])',
];

/** What submits a form. A button with no type is a submit button inside one. */
const SUBMIT_CONTROLS = 'button[type="submit" i], input[type="submit" i], button:not([type])';

/**
 * How long one frame gets. `page.evaluate` has no deadline of its own, and the agent is
 * stopped for as long as this runs.
 */
const FILL_TIMEOUT_MS = 5_000;

export interface SignInCredentials {
  username: string;
  password: string;
}

/** What the page did with them. */
export interface SignInResult {
  /** A visible password field was there. */
  found: boolean;
  /** A field took the username as well. */
  username: boolean;
  /** The page submitted the form itself; otherwise a real key press does it. */
  submitted: boolean;
}

/** The slice of the DOM this touches; see `secure-window.ts` for why it is structural. */
interface FieldElement {
  value: string;
  disabled: boolean;
  form: FormElement | null;
  shadowRoot: Root | null;
  focus(): void;
  dispatchEvent(event: unknown): boolean;
  getClientRects(): { length: number };
}

interface FormElement {
  querySelector(selectors: string): FieldElement | null;
  querySelectorAll(selectors: string): ArrayLike<FieldElement>;
  requestSubmit(submitter?: unknown): void;
}

interface Root {
  querySelectorAll(selectors: string): ArrayLike<FieldElement & { shadowRoot: Root | null }>;
}

export interface PageArgument {
  password: string | null;
  username: string;
  passwordFields: string;
  usernameFields: string[];
  submitControls: string;
}

/**
 * Find the sign-in form, and fill it when there is something to fill.
 *
 * Runs in the page: the fields are set through the prototype's setter and told about it,
 * which is what a framework holding their state listens for. A `password` of null finds
 * the form and changes nothing, which is how a request is checked before the box for it
 * is offered.
 *
 * Exported for its own test, which stands in for the page: which field takes which value
 * is the part worth pinning, and a browser is not needed to ask that.
 */
export function signInInPage(arg: PageArgument): SignInResult {
  const globals = globalThis as unknown as {
    document: Root;
    Event: new (type: string, init: { bubbles: boolean }) => unknown;
    Object: typeof Object;
  };
  const visible = (field: FieldElement): boolean =>
    !field.disabled && field.getClientRects().length > 0;

  // Every open shadow root as well as the document: a design system can put the sign-in
  // form inside a web component, and `querySelectorAll` stops at the boundary.
  const roots: Root[] = [globals.document];
  let password: FieldElement | null = null;
  let root: Root = globals.document;
  for (let i = 0; i < roots.length && !password; i++) {
    for (const element of Array.from(roots[i].querySelectorAll('*'))) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    for (const field of Array.from(roots[i].querySelectorAll(arg.passwordFields))) {
      if (!visible(field)) continue;
      password = field;
      root = roots[i];
      break;
    }
  }
  if (!password) return { found: false, username: false, submitted: false };

  const scope: Root | FormElement = password.form ?? root;
  let username: FieldElement | null = null;
  for (const tier of arg.usernameFields) {
    for (const field of Array.from(scope.querySelectorAll(tier))) {
      if (field === password || !visible(field)) continue;
      username = field;
      break;
    }
    if (username) break;
  }
  if (arg.password === null) return { found: true, username: username !== null, submitted: false };

  const set = (field: FieldElement, value: string): void => {
    const setter = globals.Object.getOwnPropertyDescriptor(
      globals.Object.getPrototypeOf(field) as object,
      'value',
    )?.set;
    if (setter) setter.call(field, value);
    else field.value = value;
    field.dispatchEvent(new globals.Event('input', { bubbles: true }));
    field.dispatchEvent(new globals.Event('change', { bubbles: true }));
  };
  if (username) set(username, arg.username);
  set(password, arg.password);
  // Focused so that the key press below lands here when the page has no form of its own.
  password.focus();

  const form = password.form;
  if (!form) return { found: true, username: username !== null, submitted: false };
  form.requestSubmit(form.querySelector(arg.submitControls) ?? undefined);
  return { found: true, username: username !== null, submitted: true };
}

async function run(page: Page, credentials: SignInCredentials | null): Promise<SignInResult> {
  const arg: PageArgument = {
    password: credentials?.password ?? null,
    username: credentials?.username ?? '',
    passwordFields: PASSWORD_FIELDS,
    usernameFields: USERNAME_FIELDS,
    submitControls: SUBMIT_CONTROLS,
  };
  for (const frame of page.frames()) {
    const result = await withTimeout(frame.evaluate(signInInPage, arg), FILL_TIMEOUT_MS).catch(
      (err: unknown) => {
        logger.warn({ err }, '[Computer] A frame could not be asked about its sign-in form');
        return { found: false, username: false, submitted: false };
      },
    );
    if (result.found) return result;
  }
  return { found: false, username: false, submitted: false };
}

/**
 * Whether this page holds a sign-in that a username and a password answer.
 *
 * Both fields are required: a page asking for a password alone is a step of a longer
 * sign-in, and a box with a username field that goes nowhere is worse than the desktop
 * the user can reach anyway.
 */
export async function hasSignInForm(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  const result = await run(page, null);
  return result.found && result.username;
}

/**
 * Type the credentials into the page's sign-in form and submit it.
 *
 * A page whose form submits itself needs nothing more. One without a form gets a real key
 * press on the field the fill left focused, which is what a person does and what a page
 * listening for Enter expects.
 */
export async function fillSignInForm(
  page: Page,
  credentials: SignInCredentials,
): Promise<'filled' | 'no_form'> {
  if (page.isClosed()) return 'no_form';
  const result = await run(page, credentials);
  if (!result.found) return 'no_form';
  if (!result.submitted) await page.keyboard.press('Enter');
  logger.info(`[Computer] Signed in on ${result.username ? 'two fields' : 'a password field'}`);
  return 'filled';
}
