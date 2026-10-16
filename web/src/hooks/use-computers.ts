import { useQuery } from '@tanstack/react-query';
import { listComputers } from '@/api/computer';

export const COMPUTERS_QUERY_KEY = ['computers'] as const;

/**
 * The agent's computers: its own, when the runtime has one, first. Fetched once and kept
 * current by the `computer` frame on the chat socket.
 */
export function useComputers() {
  return useQuery({
    queryKey: COMPUTERS_QUERY_KEY,
    queryFn: async () => (await listComputers()).computers,
    staleTime: Infinity,
  });
}
