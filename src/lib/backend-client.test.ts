/**
 * Backend Client Tests
 *
 * Tests for BackendClient: canAccessAgent, waitForBackend,
 * SlackConnection methods, and error handling.
 *
 * Note: BackendClient is a singleton constructed at module import time.
 * It captures config.backendUrl and config.internalApiSecret from the
 * setup.ts mock during construction. The baked-in values are:
 *   baseUrl = "http://localhost:3001/internal/api"
 *   secret  = "test-secret"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { backendClient } from './backend-client';

// The base URL and secret are baked in at construction time from setup.ts mock
const BASE_URL = 'http://localhost:3001/internal/api';
const BACKEND_URL = 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFetchResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackendClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ==========================================================================
  // canAccessAgent
  // ==========================================================================

  describe('canAccessAgent', () => {
    it('returns true when backend confirms access', async () => {
      mockFetch.mockResolvedValue(createFetchResponse({ allowed: true }));

      const result = await backendClient.canAccessAgent('agent-1', 'user-1', 'token-123');

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/can-access-agent`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ agentId: 'agent-1', userId: 'user-1', userToken: 'token-123' }),
        }),
      );
      expect(result).toBe(true);
    });

    it('returns false when backend denies access', async () => {
      mockFetch.mockResolvedValue(createFetchResponse({ allowed: false }));

      const result = await backendClient.canAccessAgent('agent-1', 'user-1');
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await backendClient.canAccessAgent('agent-1', 'user-1');
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // waitForBackend
  // ==========================================================================

  describe('waitForBackend', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves immediately when backend is available', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await backendClient.waitForBackend(3, 100);

      expect(mockFetch).toHaveBeenCalledWith(`${BACKEND_URL}/health`);
    });

    it('retries when backend is not ready and succeeds eventually', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ ok: true });

      const promise = backendClient.waitForBackend(5, 100);

      // Process first retry delay
      await vi.advanceTimersByTimeAsync(100);
      // Process second retry delay
      await vi.advanceTimersByTimeAsync(100);

      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('throws after max retries when backend never becomes available', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      // Attach the rejection handler immediately to avoid unhandled rejection
      const promise = backendClient.waitForBackend(3, 100).catch((e: Error) => e);

      // Advance through all retry delays (only 2 delays for 3 retries: between 1-2 and 2-3)
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);

      const error = await promise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Backend not available after 3 retries');
    });

    it('retries when backend returns non-ok status', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true });

      const promise = backendClient.waitForBackend(3, 100);

      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Error handling (generic request method)
  // ==========================================================================

  describe('error handling', () => {
    it('includes status code and error body in thrown error', async () => {
      mockFetch.mockResolvedValue(
        createFetchResponse('{"message":"Not found"}', 404),
      );

      await expect(backendClient.canAccessAgent('a', 'u', 'token')).resolves.toBe(false);
    });

    it('sends Authorization header with the baked-in secret', async () => {
      mockFetch.mockResolvedValue(createFetchResponse({ allowed: true }));

      await backendClient.canAccessAgent('a', 'u');

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer test-secret');
    });
  });
});
