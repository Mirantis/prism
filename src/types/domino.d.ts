/**
 * Type shim for `@mixmark-io/domino`, whose own declarations name the module `domino`
 * and need the DOM types this build leaves out. Only the parts used here.
 */
declare module '@mixmark-io/domino' {
  interface DominoElement {
    readonly innerHTML: string;
    readonly outerHTML: string;
    getAttribute(name: string): string | null;
  }

  interface DominoDocument {
    readonly title: string;
    readonly documentElement: DominoElement;
    readonly body: DominoElement;
    querySelector(selectors: string): DominoElement | null;
  }

  export function createDocument(html: string): DominoDocument;
}
