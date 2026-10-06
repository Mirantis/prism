import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors.js';
import { createRuntimeClient } from './runtime-client.js';

describe('createRuntimeClient', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function headersOf(call: number): Record<string, string> {
    return fetchMock.mock.calls[call]![1]!.headers as Record<string, string>;
  }

  it('asks the page origin by default', async () => {
    fetchMock.mockResolvedValue(Response.json({ id: 'agent' }));
    await createRuntimeClient().me();
    expect(fetchMock.mock.calls[0]![0]).toBe('/agents/me');
  });

  it('asks the runtime it names, with the headers current at each request', async () => {
    let token = 'first';
    const client = createRuntimeClient({
      baseUrl: 'https://agent.example.com',
      headers: async () => ({ authorization: `Bearer ${token}` }),
    });
    fetchMock.mockImplementation(async () => Response.json([]));

    await client.listCronTasks();
    token = 'second';
    await client.listCronTasks();

    expect(fetchMock.mock.calls[0]![0]).toBe('https://agent.example.com/agents/cron-tasks');
    expect(headersOf(0)).toEqual({ 'content-type': 'application/json', authorization: 'Bearer first' });
    expect(headersOf(1).authorization).toBe('Bearer second');
  });

  it('leaves the content type of an upload to the browser', async () => {
    fetchMock.mockResolvedValue(Response.json({ id: 'file' }));
    const client = createRuntimeClient({ headers: () => ({ authorization: 'Bearer t' }) });
    await client.uploadAttachment(new File(['hi'], 'hi.txt'));
    expect(headersOf(0)).toEqual({ authorization: 'Bearer t' });
  });

  it('throws the runtime error with its status', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'No such task' }, { status: 404, statusText: 'Not Found' }));
    const error = await createRuntimeClient()
      .deleteCronTask('missing')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: 'No such task', status: 404 });
  });

  it('reads an attachment as bytes, authenticated like every request', async () => {
    fetchMock.mockResolvedValue(new Response('PNG', { headers: { 'content-type': 'image/png' } }));
    const client = createRuntimeClient({
      baseUrl: 'https://agent.example.com',
      headers: () => ({ authorization: 'Bearer t' }),
    });
    const blob = await client.fetchAttachment('a1');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://agent.example.com/agents/attachments/a1');
    expect(headersOf(0).authorization).toBe('Bearer t');
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('PNG');
  });
});
