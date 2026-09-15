import { useQuery } from '@tanstack/react-query';
import { computerRequest } from '@/api/computer';

export function useComputerStatus(enabled = true) {
  return useQuery({ queryKey: ['computer'], queryFn: () => computerRequest(), refetchInterval: 2000, enabled });
}
