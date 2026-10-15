/**
 * Teams Helper — Microsoft Graph client utilities for e2e tests.
 *
 * Posts messages as a real human (a delegated Graph *user* token, not the
 * bot's credentials) into a pre-provisioned team channel and the user's
 * personal chat with the bot, and polls for the bot's replies.
 *
 * Required env (the @teams Before hook skips the suite when any is missing):
 * - TEAMS_E2E_USER_TOKEN   delegated Graph token for the human test user
 *                          (scopes: ChannelMessage.Send, Chat.ReadWrite,
 *                          ChannelMessage.Read.All)
 * - TEAMS_E2E_TEAM_ID      the test team's group id
 * - TEAMS_E2E_CHANNEL_ID   a channel in that team with the bot app added
 * - TEAMS_E2E_CHAT_ID      the human user's personal chat with the bot
 * - TEAMS_E2E_BOT_APP_ID   the bot's app id (for @mention entities)
 * - TEAMS_E2E_BOT_NAME     the bot's display name (mention text)
 *
 * The Azure Bot's messaging endpoint must point at the runtime under test —
 * Bot Framework cannot reach localhost. Tunnel the runtime's bot port
 * (TEAMS_PORT), which serves only the messaging endpoint; never tunnel the
 * runtime port, whose other routes are unauthenticated (see e2e/README.md).
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Teams e2e tests`);
  return value;
}

async function graphFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = requireEnv('TEAMS_E2E_USER_TOKEN');
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

interface GraphMessage {
  id: string;
  createdDateTime: string;
  body?: { content?: string };
  from?: { application?: { id?: string } | null; user?: { id?: string } | null };
}

/**
 * Post a top-level channel message that @mentions the bot. Returns the
 * message id — the root of the reply thread the bot answers into.
 */
export async function postChannelMention(text: string): Promise<string> {
  const teamId = requireEnv('TEAMS_E2E_TEAM_ID');
  const channelId = requireEnv('TEAMS_E2E_CHANNEL_ID');
  const botAppId = requireEnv('TEAMS_E2E_BOT_APP_ID');
  const botName = requireEnv('TEAMS_E2E_BOT_NAME');

  const message = await graphFetch<GraphMessage>(
    `/teams/${teamId}/channels/${channelId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        body: {
          contentType: 'html',
          content: `<at id="0">${botName}</at> ${text}`,
        },
        mentions: [
          {
            id: 0,
            mentionText: botName,
            mentioned: { application: { id: botAppId, displayName: botName } },
          },
        ],
      }),
    }
  );
  return message.id;
}

/**
 * Post a reply into a channel thread without mentioning the bot. Returns the
 * reply's creation time.
 */
export async function postThreadReply(rootMessageId: string, text: string): Promise<string> {
  const teamId = requireEnv('TEAMS_E2E_TEAM_ID');
  const channelId = requireEnv('TEAMS_E2E_CHANNEL_ID');
  const reply = await graphFetch<GraphMessage>(
    `/teams/${teamId}/channels/${channelId}/messages/${rootMessageId}/replies`,
    {
      method: 'POST',
      body: JSON.stringify({ body: { contentType: 'text', content: text } }),
    }
  );
  return reply.createdDateTime;
}

/**
 * Poll a channel thread until a bot (application-sent) reply appears, newer
 * than `sinceIso` when given. Returns the reply's plain-ish body content.
 */
export async function waitForBotThreadReply(
  rootMessageId: string,
  timeoutMs = 90_000,
  intervalMs = 3_000,
  sinceIso?: string
): Promise<string> {
  const teamId = requireEnv('TEAMS_E2E_TEAM_ID');
  const channelId = requireEnv('TEAMS_E2E_CHANNEL_ID');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await graphFetch<{ value: GraphMessage[] }>(
      `/teams/${teamId}/channels/${channelId}/messages/${rootMessageId}/replies`
    );
    const botReply = value.find(
      (m) => m.from?.application && (!sinceIso || m.createdDateTime > sinceIso)
    );
    if (botReply?.body?.content) return botReply.body.content;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Bot did not reply in the channel thread within ${timeoutMs}ms`);
}

/** Post a message into the human user's personal chat with the bot. */
export async function postChatMessage(text: string): Promise<string> {
  const chatId = requireEnv('TEAMS_E2E_CHAT_ID');
  const message = await graphFetch<GraphMessage>(`/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body: { contentType: 'text', content: text } }),
  });
  return message.createdDateTime;
}

/**
 * Post a rich-text (HTML) message into the personal chat, the way pasting
 * formatted text does — the body rides a `text/html` attachment with `text`
 * empty. Returns the message's creation time.
 */
export async function postChatHtml(html: string): Promise<string> {
  const chatId = requireEnv('TEAMS_E2E_CHAT_ID');
  const message = await graphFetch<GraphMessage>(`/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body: { contentType: 'html', content: html } }),
  });
  return message.createdDateTime;
}

/** A 16x16 solid red PNG. */
export const RED_SQUARE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=';

/**
 * Post a message with an inline PNG into the personal chat, the way pasting
 * an image does. Returns the message's creation time.
 */
export async function postChatImage(text: string, pngBase64: string): Promise<string> {
  const chatId = requireEnv('TEAMS_E2E_CHAT_ID');
  const message = await graphFetch<GraphMessage>(`/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      body: {
        contentType: 'html',
        content: `<p>${text}</p><img src="../hostedContents/1/$value" style="width:16px;height:16px">`,
      },
      hostedContents: [
        {
          '@microsoft.graph.temporaryId': '1',
          contentBytes: pngBase64,
          contentType: 'image/png',
        },
      ],
    }),
  });
  return message.createdDateTime;
}

/**
 * Poll the personal chat until a bot message newer than `sinceIso` appears.
 */
export async function waitForBotChatReply(
  sinceIso: string,
  timeoutMs = 90_000,
  intervalMs = 3_000
): Promise<string> {
  const chatId = requireEnv('TEAMS_E2E_CHAT_ID');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await graphFetch<{ value: GraphMessage[] }>(
      `/chats/${chatId}/messages?$top=20`
    );
    const botReply = value.find(
      (m) => m.from?.application && m.createdDateTime > sinceIso && m.body?.content
    );
    if (botReply?.body?.content) return botReply.body.content;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Bot did not reply in the personal chat within ${timeoutMs}ms`);
}
