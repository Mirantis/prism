/**
 * The esbuild plugin that binds a Prism plugin's page to the web UI's own
 * React, components and query client.
 *
 * A page must not bundle its own React. Two React copies in one document break
 * hooks, and a plugin's `<Card>` has to be the same component the rest of the
 * SPA renders or the page will not match the product. So the page's imports
 * resolve to a global the SPA installs before it loads any plugin module
 * (`web/src/plugin-host/`), and esbuild emits no React at all.
 *
 * Two specifiers, and only two:
 *
 *   `@prism/plugin`              the host object, with `api` bound to this plugin
 *   `@prism/plugin/jsx-runtime`  the names automatic JSX needs
 *
 * A single default export is what keeps this drift-free: the host can add a
 * component without a name list in this file having to learn about it. The
 * jsx-runtime's names are fixed by the JSX transform, so enumerating those is
 * safe.
 *
 * The plugin's id is written into the module here, at build time, rather than
 * read from the host when the page loads. `api` is plugin-scoped, and a page
 * reads the host once as its module evaluates — so taking the id from the host
 * would make a page's identity depend on which plugin the SPA happened to
 * install last.
 */

import type { Plugin } from 'esbuild';

/** The global the SPA installs. Also referenced by `web/src/plugin-host/`. */
export const HOST_GLOBAL = '__PRISM_PLUGIN_HOST__';

export const HOST_SPECIFIER = '@prism/plugin';
export const JSX_SPECIFIER = '@prism/plugin/jsx-runtime';

const HOST_NAMESPACE = 'prism-plugin-host';

/**
 * A page that runs before the SPA has installed the host has no way to render,
 * and the failure is worth naming: without this the page fails on a property
 * read of undefined, which points at the plugin's own code rather than at the
 * load order.
 */
const HOST_LOOKUP = `
const host = globalThis.${HOST_GLOBAL};
if (!host) {
  throw new Error(
    'The Prism plugin host is not installed. A plugin page can only run inside the Prism web UI.',
  );
}
`;

function hostModule(pluginId: string): string {
  return `${HOST_LOOKUP}
export default host.forPlugin(${JSON.stringify(pluginId)});
`;
}

/**
 * `jsxDEV` is exported alongside the production names because esbuild emits it
 * when a build runs in development mode. Both come from the same host object,
 * so a page behaves identically either way.
 */
const JSX_MODULE = `${HOST_LOOKUP}
const runtime = host.jsxRuntime;
export const Fragment = runtime.Fragment;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const jsxDEV = runtime.jsxDEV ?? runtime.jsx;
`;

/**
 * Bare specifiers a plugin author is likely to reach for out of habit, mapped
 * to the advice that fixes it. Answering with a build error naming the host
 * import beats esbuild's own "could not resolve", which reads as a missing
 * dependency the author is meant to install — and installing one is exactly
 * what must not happen here.
 */
const REDIRECTED = new Map<string, string>([
  ['react', 'React and its hooks come off the host object'],
  ['react-dom', 'the SPA owns rendering'],
  ['react/jsx-runtime', 'the runtime already points the JSX transform at the host'],
  ['@tanstack/react-query', '`useQuery` and `useMutation` come off the host object'],
  ['lucide-react', 'use `<Icon name="…" />` from the host object'],
]);

/**
 * Resolve the host specifiers to virtual modules, and turn a direct import of
 * anything the host already provides into a build error that says so.
 */
export function prismPluginHostShim(pluginId: string): Plugin {
  return {
    name: 'prism-plugin-host',
    setup(build) {
      build.onResolve({ filter: /^@prism\/plugin(\/jsx-runtime)?$/ }, (args) => ({
        path: args.path,
        namespace: HOST_NAMESPACE,
      }));

      build.onResolve({ filter: /.*/ }, (args) => {
        const advice = REDIRECTED.get(args.path);
        if (!advice) return null;
        return {
          errors: [
            {
              text: `Import "${args.path}" is not available to a plugin page — ${advice}. Write \`import host from '${HOST_SPECIFIER}'\` instead.`,
            },
          ],
        };
      });

      build.onLoad({ filter: /.*/, namespace: HOST_NAMESPACE }, (args) => ({
        contents: args.path === JSX_SPECIFIER ? JSX_MODULE : hostModule(pluginId),
        loader: 'js',
      }));
    },
  };
}
