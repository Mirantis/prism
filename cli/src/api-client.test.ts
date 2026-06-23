import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// loadConfig() is read once at HttpApiClient construction time to derive the
// base URL, so stub it to a fixed httpUrl (with a trailing slash to prove the
// client strips it).
vi.mock('./config.js', () => ({
  loadConfig: () => ({
    agentName: 'Test',
    modelId: 'test-model',
    hideCursor: false,
    hideStatusBar: false,
    httpUrl: 'http://example.test:3003/',
  }),
}));

import { HttpApiClient, ApiError, AgentDetails } from './api-client.js';

const BASE = 'http://example.test:3003';

/** Build a fetch Response-ish stub for a 2xx JSON body. */
function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Build a fetch Response-ish stub for a 204 No Content / empty-body reply. */
function noContent(status = 204): Response {
  return {
    ok: true,
    status,
    text: async () => '',
  } as unknown as Response;
}

/** Build a fetch Response-ish stub for a non-2xx JSON body. */
function fail(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit | undefined;
} {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
  return { url, init };
}

describe('HttpApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: HttpApiClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new HttpApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('strips the trailing slash from the configured base URL', async () => {
    fetchMock.mockResolvedValue(ok({ agentId: 'a', userId: 'u', name: 'n' }));
    await client.getMe();
    expect(lastCall(fetchMock).url).toBe(`${BASE}/agents/me`);
  });

  it('GET requests carry no body or Content-Type header', async () => {
    fetchMock.mockResolvedValue(ok({ model: null }));
    await client.getModel();
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/model`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
  });

  it('setName PATCHes the right URL with a JSON { name } body', async () => {
    fetchMock.mockResolvedValue(ok({ name: 'Nova' }));
    const result = await client.setName('Nova');
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/name`);
    expect(init?.method).toBe('PATCH');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ name: 'Nova' }));
    expect(result).toEqual({ name: 'Nova' });
  });

  it('setModel PATCHes a JSON { model } body (including null to reset)', async () => {
    fetchMock.mockResolvedValue(ok({ model: null }));
    await client.setModel(null);
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/model`);
    expect(init?.method).toBe('PATCH');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ model: null }));
  });

  it('getHeartbeatModel GETs /agents/heartbeat-model', async () => {
    fetchMock.mockResolvedValue(ok({ model: null, effective: 'main' }));
    const result = await client.getHeartbeatModel();
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/heartbeat-model`);
    expect(init?.method).toBe('GET');
    expect(result).toEqual({ model: null, effective: 'main' });
  });

  it('setHeartbeatModel PATCHes /agents/heartbeat-model with a JSON { model } body', async () => {
    fetchMock.mockResolvedValue(ok({ model: 'hb', effective: 'hb' }));
    await client.setHeartbeatModel('hb');
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/heartbeat-model`);
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ model: 'hb' }));
  });

  it('getCronModel GETs /agents/cron-model', async () => {
    fetchMock.mockResolvedValue(ok({ model: null, effective: 'main' }));
    const result = await client.getCronModel();
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/cron-model`);
    expect(init?.method).toBe('GET');
    expect(result).toEqual({ model: null, effective: 'main' });
  });

  it('setCronModel PATCHes /agents/cron-model with null to reset', async () => {
    fetchMock.mockResolvedValue(ok({ model: null, effective: 'main' }));
    await client.setCronModel(null);
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/cron-model`);
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ model: null }));
  });

  it('createCronTask POSTs the input as the JSON body', async () => {
    fetchMock.mockResolvedValue(ok({ id: 't1' }));
    const input = { name: 'daily', schedule: '0 9 * * *', instruction: 'check things' };
    await client.createCronTask(input);
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/cron-tasks`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify(input));
  });

  it('setHeartbeatInterval PATCHes a JSON { intervalMs } body', async () => {
    fetchMock.mockResolvedValue(ok({ isActive: true, lastRun: null, isRunning: false, consecutiveErrors: 0 }));
    await client.setHeartbeatInterval(60000);
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/heartbeat/interval`);
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ intervalMs: 60000 }));
  });

  it('startHeartbeat POSTs the agent wrapped in { agent }', async () => {
    fetchMock.mockResolvedValue(ok({ success: true, message: 'started' }));
    const agent = { id: 'a1', name: 'Prism' } as unknown as AgentDetails;
    await client.startHeartbeat(agent);
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/heartbeat/start`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ agent }));
  });

  it('deleteCronTask DELETEs the task-scoped URL', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));
    await client.deleteCronTask('task-42');
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/cron-tasks/task-42`);
    expect(init?.method).toBe('DELETE');
  });

  it('resolves (not rejects) when a successful mutation replies 204 No Content', async () => {
    fetchMock.mockResolvedValue(noContent());
    await expect(client.deleteCronTask('task-42')).resolves.toBeUndefined();
  });

  it('resolves when a successful mutation replies an empty body with status 200', async () => {
    fetchMock.mockResolvedValue(noContent(200));
    await expect(client.stopHeartbeat()).resolves.toBeUndefined();
  });

  it('getDetails unwraps the { agent } envelope', async () => {
    const agent = { id: 'a1', name: 'Prism' } as unknown as AgentDetails;
    fetchMock.mockResolvedValue(ok({ agent }));
    const result = await client.getDetails();
    expect(lastCall(fetchMock).url).toBe(`${BASE}/agents/details`);
    expect(result).toEqual(agent);
  });

  it('throws ApiError with status and parsed message on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(fail(404, { error: 'agent not found' }));
    await expect(client.setName('x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'agent not found',
      detail: 'agent not found',
    });
    await expect(client.setName('x')).rejects.toBeInstanceOf(ApiError);
  });

  it('uses the body detail field when error is absent', async () => {
    fetchMock.mockResolvedValue(fail(400, { detail: 'bad interval' }));
    const err = await client.setHeartbeatInterval(5).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad interval');
    expect(err.detail).toBe('bad interval');
  });

  it('falls back to a status message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    const err = await client.getModel().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('Request failed with status 500');
    expect(err.detail).toBeUndefined();
  });

  describe('uploadAttachment', () => {
    let dir: string;
    let filePath: string;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-upload-test-'));
      filePath = path.join(dir, 'notes.txt');
      fs.writeFileSync(filePath, 'hello attachment');
      fs.writeFileSync(path.join(dir, 'empty.txt'), '');
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('POSTs multipart FormData with the basename and no manual Content-Type', async () => {
      const meta = { id: 'att-1', filename: 'notes.txt', mediaType: 'text/plain', sizeBytes: 16, category: 'text' };
      fetchMock.mockResolvedValue(ok(meta));

      const result = await client.uploadAttachment(filePath);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${BASE}/agents/attachments`);
      expect(init?.method).toBe('POST');
      // Content-Type must be unset so fetch writes the multipart boundary.
      expect(init?.headers).toBeUndefined();
      expect(init?.body).toBeInstanceOf(FormData);
      const entry = (init?.body as FormData).get('file') as File;
      expect(entry.name).toBe('notes.txt');
      expect(result).toEqual(meta);
    });

    it('rejects a missing file without calling fetch', async () => {
      await expect(client.uploadAttachment(path.join(dir, 'nope.txt'))).rejects.toThrow(
        /File not found/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a directory without calling fetch', async () => {
      await expect(client.uploadAttachment(dir)).rejects.toThrow(/is a directory/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an empty file without calling fetch', async () => {
      await expect(client.uploadAttachment(path.join(dir, 'empty.txt'))).rejects.toThrow(
        /File is empty/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an oversized file without calling fetch', async () => {
      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
        isDirectory: () => false,
        size: 11 * 1024 * 1024,
      } as unknown as fs.Stats);
      try {
        await expect(client.uploadAttachment(filePath)).rejects.toThrow(/File too large/);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        statSpy.mockRestore();
      }
    });

    it('surfaces the server 400 as an ApiError (server stays authoritative)', async () => {
      fetchMock.mockResolvedValue(fail(400, { error: 'Upload rejected: File too large (max 10 MB)' }));
      const err = await client.uploadAttachment(filePath).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).toContain('File too large');
    });
  });

  it('deleteAttachment DELETEs the attachment-scoped URL', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));
    await client.deleteAttachment('att-9');
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/agents/attachments/att-9`);
    expect(init?.method).toBe('DELETE');
  });
});
