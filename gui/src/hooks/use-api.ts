import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../lib/api';

interface Options {
  /** Skip fetching when false (or when path is null). */
  enabled?: boolean;
  /** Poll every N ms while mounted. */
  refetchInterval?: number;
}

interface Result<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Minimal data-fetching hook for the runtime's read-only GET endpoints.
 * Pass `path: null` (or `enabled: false`) to defer a dependent fetch.
 * `refetch()` re-runs the GET (e.g. after a mutation).
 */
export function useApi<T>(path: string | null, opts: Options = {}): Result<T> {
  const { enabled = true, refetchInterval } = opts;
  const active = enabled && path != null;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(active);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!active || path == null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const fetchOnce = () => {
      apiGet<T>(path)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(e as Error);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    fetchOnce();
    const timer = refetchInterval ? setInterval(fetchOnce, refetchInterval) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [path, active, refetchInterval, nonce]);

  return { data, loading, error, refetch };
}
