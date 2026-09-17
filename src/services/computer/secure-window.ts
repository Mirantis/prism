/**
 * What a secure takeover must not leave behind.
 *
 * The agent resumes with the screen in front of it, so a password still sitting in
 * a field would be readable the moment it looks. Clearing every password field is
 * also the answer to "did they submit the form": a submitted sign-in leaves no
 * field to clear, and an abandoned one leaves nothing that outlives the window.
 */

import type { Page } from 'playwright-core';
import { logger } from '../../logger';
import { withTimeout } from '../../utils/with-timeout';

/**
 * A field holding a password: the ordinary one, and the one a "show password"
 * control has turned into plain text, which keeps its autocomplete name.
 */
const PASSWORD_FIELDS = 'input[type="password" i], input[autocomplete*="password" i]';

/**
 * How long one frame gets. `page.evaluate` has no deadline of its own, and the agent
 * runs again when this is done, so a wedged frame would stop the runtime for good.
 */
const CLEAR_TIMEOUT_MS = 5_000;

/** The slice of the DOM this touches; see `browser-control.ts` for why it is structural. */
interface PasswordField {
  value: string;
  dispatchEvent(event: unknown): boolean;
}

interface FieldElement {
  shadowRoot: FieldRoot | null;
}

interface FieldRoot {
  querySelectorAll(selectors: string): ArrayLike<PasswordField & FieldElement>;
}

/**
 * Empty every password field in every frame of these tabs, and report how many held
 * something. A frame that does not answer, because it has gone or because it is wedged,
 * is reported and passed over.
 */
export async function clearPasswordFields(pages: readonly Page[]): Promise<number> {
  let cleared = 0;
  for (const page of pages) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      const evaluated = frame
        .evaluate((selector: string) => {
          const globals = globalThis as unknown as {
            document: FieldRoot;
            Event: new (type: string, init: { bubbles: boolean }) => unknown;
            Object: typeof Object;
          };
          // Every open shadow root as well as the document: a design system can put
          // the sign-in form inside a web component, and `querySelectorAll` stops at
          // the boundary. A closed root is unreachable by construction.
          const roots: FieldRoot[] = [globals.document];
          const fields: PasswordField[] = [];
          for (let i = 0; i < roots.length; i++) {
            for (const element of Array.from(roots[i].querySelectorAll('*'))) {
              if (element.shadowRoot) roots.push(element.shadowRoot);
            }
            for (const field of Array.from(roots[i].querySelectorAll(selector))) {
              fields.push(field);
            }
          }
          let count = 0;
          for (const field of fields) {
            if (!field.value) continue;
            // Through the prototype's setter, which is what a framework holding the
            // field's state listens for; assigning `value` alone can be re-rendered
            // straight back out of that state.
            const setter = globals.Object.getOwnPropertyDescriptor(
              globals.Object.getPrototypeOf(field) as object,
              'value',
            )?.set;
            if (setter) setter.call(field, '');
            else field.value = '';
            field.dispatchEvent(new globals.Event('input', { bubbles: true }));
            field.dispatchEvent(new globals.Event('change', { bubbles: true }));
            count++;
          }
          return count;
        }, PASSWORD_FIELDS);
      cleared += await withTimeout(evaluated, CLEAR_TIMEOUT_MS).catch((err: unknown) => {
        logger.warn({ err }, '[Computer] A frame could not be cleared');
        return 0;
      });
    }
  }
  if (cleared) logger.info(`[Computer] Cleared ${cleared} password field(s) after a secure takeover`);
  return cleared;
}
