import { useCallback } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchComputerStatus } from '@/api/computer';
import { helpComputerId, LOCAL_COMPUTER_ID, type ComputerHelp, type ComputerStatus } from '@/types';
import { COMPUTERS_QUERY_KEY } from './use-computers';

/** Every computer's state sits under `['computer']`, so invalidating that refetches them all. */
export const computerStatusKey = (computerId: string) => ['computer', computerId] as const;

/**
 * The state of one computer, with its help requests. Fetched once when a page opens and
 * kept current by the `computer` frame on the chat socket, so an open page makes no
 * repeating request: the frame is the runtime's own computer's state, and a remote
 * computer's is fetched again whenever a frame arrives.
 */
export function useComputerStatus(computerId: string = LOCAL_COMPUTER_ID, enabled = true) {
  return useQuery({
    queryKey: computerStatusKey(computerId),
    queryFn: () => fetchComputerStatus(computerId),
    staleTime: Infinity,
    enabled,
  });
}

/** The state of several computers, from the same cache entries as the hook above. */
export function useComputerStatuses(computerIds: string[]): (ComputerStatus | undefined)[] {
  return useQueries({
    queries: computerIds.map((computerId) => ({
      queryKey: computerStatusKey(computerId),
      queryFn: () => fetchComputerStatus(computerId),
      staleTime: Infinity,
    })),
  }).map((query) => query.data);
}

/** Each request as its computer reports it now, or as it was given where none does. */
export function useCurrentHelp(requests: ComputerHelp[]): ComputerHelp[] {
  const ids = [...new Set(requests.map(helpComputerId))];
  const statuses = useComputerStatuses(ids);
  return requests.map((request) => {
    const status = statuses[ids.indexOf(helpComputerId(request))];
    return status?.help?.find((item) => item.id === request.id) ?? request;
  });
}

/** Write a `computer` frame into the caches the hooks above and `useComputers` read. */
export function useComputerStatusFeed() {
  const queryClient = useQueryClient();
  return useCallback(
    (frame: ComputerStatus) => {
      const { computers, ...status } = frame;
      // The frame lists every help request; each computer's state holds its own.
      const local = {
        ...status,
        help: status.help?.filter((help) => helpComputerId(help) === LOCAL_COMPUTER_ID),
      };
      // A request still in flight would commit its own older reading over this frame,
      // and `staleTime: Infinity` then holds it until the next change. The frame is
      // the newer reading, so the request is dropped.
      void queryClient.cancelQueries({ queryKey: computerStatusKey(LOCAL_COMPUTER_ID), exact: true });
      queryClient.setQueryData(computerStatusKey(LOCAL_COMPUTER_ID), local);
      if (computers) {
        void queryClient.cancelQueries({ queryKey: COMPUTERS_QUERY_KEY, exact: true });
        queryClient.setQueryData(COMPUTERS_QUERY_KEY, computers);
      }
      // The frame is also the newer reading of each remote computer's requests, and the
      // only one of a removed computer's, which a read can no longer refresh.
      for (const query of queryClient.getQueryCache().findAll({ queryKey: ['computer'] })) {
        const id = query.queryKey[1] as string;
        if (id === LOCAL_COMPUTER_ID) continue;
        queryClient.setQueryData<ComputerStatus>(
          computerStatusKey(id),
          (cached) => cached && { ...cached, help: status.help?.filter((help) => helpComputerId(help) === id) },
        );
      }
      // A computer the frame no longer lists was removed, and reading it again would answer
      // 404; its stale state goes once nothing shows it.
      const listed = computers && new Set(computers.map((computer) => computer.id));
      void queryClient.invalidateQueries({
        queryKey: ['computer'],
        predicate: (query) =>
          query.queryKey[1] !== LOCAL_COMPUTER_ID && (!listed || listed.has(query.queryKey[1] as string)),
      });
    },
    [queryClient],
  );
}
