/**
 * The sign-in form on a page, found and filled by rule.
 *
 * A help request the model marks as a plain sign-in is answered with a username and a
 * password the user types in their own client. The runtime types those into the blocked
 * tab and submits the form. Which field takes which value is decided here, by selectors
 * in a fixed order, so the same page always answers the same way and no model sees what
 * was typed.
 *
 * A sign-in that asks for the username first and the password on the screen after it is
 * driven the same way, one step at a time. The user answers one box either way.
 */

import type { Page } from 'playwright-core';
import { logger } from '../../logger';
import { withTimeout } from '../../utils/with-timeout';

/**
 * A field holding a password: the ordinary one, and the one a "show password" control has
 * turned into plain text, which keeps its autocomplete name.
 */
export const PASSWORD_FIELDS = 'input[type="password" i], input[autocomplete*="password" i]';

/**
 * Where the username goes, most explicit first. The first tier with a field wins.
 *
 * The last tier is any text field: right beside a password field, and wrong on its own,
 * where a search box would answer to it. A first step is recognized from the tiers that
 * name the field instead — see `NAMED_USERNAME_TIERS`.
 */
const USERNAME_FIELDS = [
  'input[autocomplete="username" i], input[autocomplete="email" i]',
  'input[type="email" i], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]',
  'input[type="text" i], input[type="tel" i], input:not([type])',
];

/** How many of those tiers name the field, rather than merely allowing it. */
const NAMED_USERNAME_TIERS = 2;

/** What submits a form. A button with no type is a submit button inside one. */
const SUBMIT_CONTROLS = 'button[type="submit" i], input[type="submit" i], button:not([type])';

/**
 * How long one frame gets. `page.evaluate` has no deadline of its own, and the agent is
 * stopped for as long as this runs.
 */
const FILL_TIMEOUT_MS = 5_000;

/** How long the password screen gets to arrive, and how often it is looked for. */
const PASSWORD_STEP_TIMEOUT_MS = 15_000;
const PASSWORD_STEP_POLL_MS = 400;

export interface SignInCredentials {
  username: string;
  password: string;
}

/** What the page holds, and what it did with what it was handed. */
export interface SignInResult {
  /** A visible password field is there. */
  found: boolean;
  /**
   * A field for the username is there. On a page with no password field it is a named
   * one, which is the first step of a sign-in that asks in two.
   */
  username: boolean;
  /** The page submitted the step itself; otherwise a real key press does it. */
  submitted: boolean;
}

/** A page's sign-in, as `findSignIn` reports it. */
export interface SignInShape {
  /** The page asks for the password now. False on the first step of a two-step sign-in. */
  password: boolean;
  /** The page has a field for the username. */
  username: boolean;
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
  /** The password to type, or null to leave a password field alone. */
  password: string | null;
  /** The username to type, or null to leave a username field alone. */
  username: string | null;
  passwordFields: string;
  usernameFields: string[];
  namedUsernameTiers: number;
  submitControls: string;
}

/**
 * Find the sign-in, and fill what this step asks for.
 *
 * Runs in the page: a field is set through the prototype's setter and told about it,
 * which is what a framework holding its state listens for. Two nulls find the form and
 * change nothing, which is how a request is checked before the box for it is offered, and
 * how the password screen is waited for.
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
  for (let i = 0; i < roots.length; i++) {
    for (const element of Array.from(roots[i].querySelectorAll('*'))) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }

  let password: FieldElement | null = null;
  let root: Root = globals.document;
  for (const candidate of roots) {
    for (const field of Array.from(candidate.querySelectorAll(arg.passwordFields))) {
      if (!visible(field)) continue;
      password = field;
      root = candidate;
      break;
    }
    if (password) break;
  }

  // The username sits in the password field's own form where there is one. On a first
  // step there is no password field to look around, so every root is searched, and only
  // by the tiers that name the field.
  const scopes: (Root | FormElement)[] = password ? [password.form ?? root] : roots;
  const tiers = password ? arg.usernameFields : arg.usernameFields.slice(0, arg.namedUsernameTiers);
  let username: FieldElement | null = null;
  for (const tier of tiers) {
    for (const scope of scopes) {
      for (const field of Array.from(scope.querySelectorAll(tier))) {
        if (field === password || !visible(field)) continue;
        username = field;
        break;
      }
      if (username) break;
    }
    if (username) break;
  }

  const found = password !== null;
  if (arg.password === null && arg.username === null) {
    return { found, username: username !== null, submitted: false };
  }

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
  if (username && arg.username !== null) set(username, arg.username);
  if (password && arg.password !== null) set(password, arg.password);

  // What this step filled last, which is where the key press lands when the page has no
  // form of its own.
  const filled = arg.password !== null ? password : username;
  if (!filled) return { found, username: username !== null, submitted: false };
  filled.focus();

  const form = filled.form;
  if (!form) return { found, username: username !== null, submitted: false };
  form.requestSubmit(form.querySelector(arg.submitControls) ?? undefined);
  return { found, username: username !== null, submitted: true };
}

function pageArgument(username: string | null, password: string | null): PageArgument {
  return {
    password,
    username,
    passwordFields: PASSWORD_FIELDS,
    usernameFields: USERNAME_FIELDS,
    namedUsernameTiers: NAMED_USERNAME_TIERS,
    submitControls: SUBMIT_CONTROLS,
  };
}

const NOTHING: SignInResult = { found: false, username: false, submitted: false };

/** Ask every frame, and answer with the first holding a sign-in. */
async function run(page: Page, arg: PageArgument): Promise<SignInResult> {
  if (page.isClosed()) return NOTHING;
  let best = NOTHING;
  for (const frame of page.frames()) {
    const result = await withTimeout(frame.evaluate(signInInPage, arg), FILL_TIMEOUT_MS).catch(
      (err: unknown) => {
        // A frame part-way through a navigation answers nothing. That is a step of an
        // ordinary sign-in rather than a fault, and the caller asks again.
        logger.debug({ err }, '[Computer] A frame could not be asked about its sign-in form');
        return NOTHING;
      },
    );
    if (result.found) return result;
    // A first step: keep it, in case a later frame holds the whole form.
    if (result.username) best = result;
  }
  return best;
}

/** The sign-in this page holds, or null when it holds none. */
export async function findSignIn(page: Page): Promise<SignInShape | null> {
  const result = await run(page, pageArgument(null, null));
  if (!result.found && !result.username) return null;
  return { password: result.found, username: result.username };
}

/** Press what submits this step, when the page did not submit it itself. */
async function submitStep(page: Page, result: SignInResult): Promise<void> {
  if (!result.submitted) await page.keyboard.press('Enter');
}

/** Wait for the screen that asks for the password, as a person waits for it to load. */
async function waitForPasswordStep(page: Page): Promise<boolean> {
  const deadline = Date.now() + PASSWORD_STEP_TIMEOUT_MS;
  for (;;) {
    if ((await run(page, pageArgument(null, null))).found) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(PASSWORD_STEP_POLL_MS);
  }
}

/**
 * Type the credentials into the page's sign-in and submit it.
 *
 * A page asking for both at once takes one step. A page asking for the username first
 * takes two: the username goes in, that step is submitted, and the password follows once
 * the page shows a field for it.
 *
 * A page whose form submits itself needs nothing more. One without a form gets a real key
 * press on the field the fill left focused, which is what a person does and what a page
 * listening for Enter expects.
 */
export async function fillSignInForm(
  page: Page,
  credentials: SignInCredentials,
): Promise<'filled' | 'no_form' | 'no_password_step'> {
  const shape = await findSignIn(page);
  if (!shape) return 'no_form';

  if (!shape.password) {
    const first = await run(page, pageArgument(credentials.username, null));
    if (!first.username) return 'no_form';
    await submitStep(page, first);
    if (!(await waitForPasswordStep(page))) {
      logger.warn('[Computer] A sign-in took the username and never asked for the password');
      return 'no_password_step';
    }
    const second = await run(page, pageArgument(null, credentials.password));
    if (!second.found) return 'no_password_step';
    await submitStep(page, second);
    logger.info('[Computer] Signed in over two steps');
    return 'filled';
  }

  const result = await run(page, pageArgument(credentials.username, credentials.password));
  if (!result.found) return 'no_form';
  await submitStep(page, result);
  logger.info(`[Computer] Signed in on ${result.username ? 'two fields' : 'a password field'}`);
  return 'filled';
}
