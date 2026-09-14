import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { runtimeApi } from '@/api/runtime-client';
import { PluginPage } from '@/plugin-host/plugin-page';

/**
 * The one route every Prism plugin page renders under.
 *
 * The route table is generated from the filesystem at build time, so a plugin
 * discovered while the runtime is running cannot have a route file of its own.
 * One parameterised route resolves the plugin per request instead.
 */
export const Route = createFileRoute('/plugins/$pluginId')({
  component: PluginRoute,
});

function PluginRoute() {
  const { pluginId } = Route.useParams();
  const { data, isLoading } = useQuery({
    queryKey: ['prism-plugins'],
    queryFn: () => runtimeApi.listPrismPlugins(),
  });

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const plugin = data?.find((p) => p.id === pluginId);
  if (!plugin) {
    return (
      <Alert variant="destructive">
        <AlertTitle>No plugin called {pluginId}</AlertTitle>
        <AlertDescription>
          It may have been removed. Installed plugins appear in the navigation on the left.
        </AlertDescription>
      </Alert>
    );
  }

  return <PluginPage plugin={plugin} />;
}
