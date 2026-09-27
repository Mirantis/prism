import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { UpdateBannerLive } from '@/components/layout/update-banner-live';

/**
 * Query gate for the update strip: renders nothing when the updater is off
 * for this install (containers, dev runs), where no update event can ever
 * arrive. A failed status fetch keeps
 * the strip hidden; a failed update check never surfaces in the UI.
 */
export function UpdateBanner() {
  const { data: status } = useQuery({
    queryKey: ['update-status'],
    queryFn: runtimeApi.updateStatus,
    refetchInterval: 30 * 60_000,
  });

  if (!status?.enabled) return null;
  return <UpdateBannerLive status={status} />;
}
