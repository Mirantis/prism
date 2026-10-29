import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { mayReceiveSlackToken, SlackWebClient, stripBodyToken } from './slack-web-client';

const API_PROXY = 'https://api.example.test/slack/api/';

function useApiProxy(url: string | undefined): void {
  (config as { slackApiUrl?: string }).slackApiUrl = url;
}

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

describe('SLACK_API_URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useApiProxy(undefined);
  });

  it('sends every Web API call to the Slack API proxy', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    useApiProxy(API_PROXY);

    await new SlackWebClient('__nexus_cred:proxy__').chat.postMessage({ channel: 'C0EXAMPLE', text: 'hello' });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.test/slack/api/chat.postMessage');
  });

  it('sends them to Slack when it is unset', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await new SlackWebClient('xoxb-test').chat.postMessage({ channel: 'C0EXAMPLE', text: 'hello' });

    expect(fetchMock.mock.calls[0][0]).toBe('https://slack.com/api/chat.postMessage');
  });
});

describe('mayReceiveSlackToken', () => {
  afterEach(() => useApiProxy(undefined));

  it.each([
    ['https://files.slack.com/files-pri/T0-F0/report.pdf', true],
    ['https://slack.com/api/files.info', true],
    ['http://files.slack.com/files-pri/T0-F0/report.pdf', false],
    ['https://files.slack.com.example.test/report.pdf', false],
    ['https://api.example.test/slack/files/F0EXAMPLE', false],
    ['not a url', false],
  ])('without a proxy, %s → %s', (url, expected) => {
    expect(mayReceiveSlackToken(url)).toBe(expected);
  });

  it.each([
    ['https://api.example.test/slack/files/F0EXAMPLE', true],
    ['https://files.slack.com/files-pri/T0-F0/report.pdf', true],
    ['https://other.example.test/slack/files/F0EXAMPLE', false],
    ['http://api.example.test/slack/files/F0EXAMPLE', false],
  ])('with the proxy, %s → %s', (url, expected) => {
    useApiProxy(API_PROXY);
    expect(mayReceiveSlackToken(url)).toBe(expected);
  });
});
