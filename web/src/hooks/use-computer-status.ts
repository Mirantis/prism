import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { computerRequest } from '@/api/computer';
import type { ComputerStatus } from '@lensapp/prism-client';

/**
 * The state of the desktop. Fetched once when a page opens and kept current by the
 * `computer` frame on the chat socket, so an open page makes no repeating request.
 * An explicit `invalidateQueries` on `['computer']` still refetches.
 */
export function useComputerStatus(enabled = true) {
  return useQuery({
    queryKey: ['computer'],
    queryFn: () => computerRequest(),
    staleTime: Infinity,
    enabled,
  });
}

/** Write a `computer` frame into the cache the hook above reads. */
export function useComputerStatusFeed() {
  const queryClient = useQueryClient();
  return useCallback(
    (status: ComputerStatus) => {
      // A request still in flight would commit its own older reading over this frame,
      // and `staleTime: Infinity` then holds it until the next change. The frame is
      // the newer reading, so the request is dropped.
      void queryClient.cancelQueries({ queryKey: ['computer'], exact: true });
      queryClient.setQueryData(['computer'], status);
    },
    [queryClient],
  );
}
