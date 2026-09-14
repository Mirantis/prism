/**
 * Loads and renders one plugin's page.
 *
 * The module comes from the runtime over HTTP, so this is the one place in the
 * SPA that imports code it did not bundle. Three states are worth showing on
 * their own terms: still loading, the plugin reported a build problem, and the
 * module loaded but failed while rendering. The last two are what a plugin
 * author sees while writing a page, so each names what to fix.
 */

import { Component, useEffect, useState } from 'react';
import type { ComponentType, ErrorInfo, ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import type { PrismPluginSummary } from '@/types';

/** Modules already fetched, keyed by plugin and revision. */
const loaded = new Map<string, ComponentType>();

function moduleUrl(plugin: PrismPluginSummary): string {
  return `/agents/prism-plugins/${encodeURIComponent(plugin.id)}/page.js?rev=${plugin.revision}`;
}

async function loadPage(plugin: PrismPluginSummary): Promise<ComponentType> {
  const key = `${plugin.id}@${plugin.revision}`;
  const cached = loaded.get(key);
  if (cached) return cached;

  // `@vite-ignore` — the URL is only known at runtime, and Vite would otherwise
  // try to resolve it while building the SPA.
  const mod = (await import(/* @vite-ignore */ moduleUrl(plugin))) as {
    default?: unknown;
  };
  if (typeof mod.default !== 'function') {
    throw new Error('web/page.tsx must default-export a React component.');
  }
  const component = mod.default as ComponentType;
  loaded.set(key, component);
  return component;
}

/** Problems the runtime already found, shown before anything is imported. */
function Diagnostics({ plugin }: { plugin: PrismPluginSummary }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>This plugin reported {plugin.diagnostics.length} problem(s)</AlertTitle>
      <AlertDescription>
        <ul className="flex list-disc flex-col gap-1 pl-4">
          {plugin.diagnostics.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

interface BoundaryProps {
  children: ReactNode;
  pluginId: string;
}

/**
 * Catches a throw from inside the plugin's own component. A plugin page is code
 * the SPA did not compile, so without this a bad render blanks the whole app
 * rather than the one page.
 */
class PluginErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[PrismPlugin:${this.props.pluginId}] page render failed`, error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Alert variant="destructive">
        <AlertTitle>This page failed while rendering</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
}

export function PluginPage({ plugin }: { plugin: PrismPluginSummary }) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; Page: ComponentType } | { status: 'failed'; error: string }
  >({ status: 'loading' });

  const key = `${plugin.id}@${plugin.revision}`;

  useEffect(() => {
    // A plugin whose page did not build has nothing to import, and asking for it
    // would be a 404 on every visit whose failure this component then discards —
    // the render below shows the build error instead.
    if (!plugin.hasPage) return;

    let current = true;
    setState({ status: 'loading' });
    loadPage(plugin)
      .then((Page) => {
        if (current) setState({ status: 'ready', Page });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setState({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      current = false;
    };
    // Keyed on the plugin and its revision: a rebuilt page is a new module URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, plugin.hasPage]);

  if (!plugin.hasPage) {
    // A page that failed to build leaves no module either, so both cases arrive
    // here — but only one of them means the plugin ships no page. Saying that
    // about a page whose source is right there, with a compile error above it,
    // sends its author looking for the wrong thing.
    const buildFailed = plugin.diagnostics.some((detail) => detail.startsWith('web'));
    return (
      <div className="flex flex-col gap-4">
        {plugin.diagnostics.length > 0 && <Diagnostics plugin={plugin} />}
        {!buildFailed && (
          <Alert>
            <AlertTitle>{plugin.name} has no page</AlertTitle>
            <AlertDescription>
              This plugin ships no <code>web/page.tsx</code>, so there is nothing to show here.
            </AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {plugin.diagnostics.length > 0 && <Diagnostics plugin={plugin} />}

      {state.status === 'loading' && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>This page could not be loaded</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && (
        <PluginErrorBoundary pluginId={plugin.id}>
          <state.Page />
        </PluginErrorBoundary>
      )}
    </div>
  );
}
