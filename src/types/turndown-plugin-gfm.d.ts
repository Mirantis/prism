/** Type shim for `turndown-plugin-gfm`, which ships no types. Only the plugin set is used. */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export const gfm: TurndownService.Plugin;
}
