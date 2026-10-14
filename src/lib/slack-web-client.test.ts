import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackWebClient, stripBodyToken } from './slack-web-client';

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SlackWebClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a call's token in the Authorization header and not in the body", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await new SlackWebClient('__nexus_cred:bot__').chat.postMessage({
      token: '__nexus_cred:call__',
      channel: 'C0EXAMPLE',
      text: 'hello',
    });

    const init = fetchMock.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer __nexus_cred:call__');
    const body = new URLSearchParams(init.body as string);
    expect(body.has('token')).toBe(false);
    expect(body.get('channel')).toBe('C0EXAMPLE');
  });

  it('sends a JSON body unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const body = JSON.stringify({ text: 'a=1&token=abc' });

    await stripBodyToken('https://hooks.slack.com/actions/T0/1/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(fetchMock.mock.calls[0][1]!.body).toBe(body);
  });

  it('drops the token from a multipart upload body', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();
    form.append('token', '__nexus_cred:call__');
    form.append('channels', 'C0EXAMPLE');

    await stripBodyToken('https://slack.com/api/files.upload', { method: 'POST', body: form });

    const sent = fetchMock.mock.calls[0][1]!.body as FormData;
    expect(sent.has('token')).toBe(false);
    expect(sent.get('channels')).toBe('C0EXAMPLE');
  });
});
