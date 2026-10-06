# @lensapp/prism-client

The browser client for a Prism agent runtime: the `/api/ws` chat protocol (version 2),
the socket that keeps a conversation in step with the runtime, and a client for the
runtime's REST surface with its types. The Prism web UI is built on it.

[`docs/websocket-protocol.md`](https://github.com/lensapp/prism-agent/blob/main/docs/websocket-protocol.md) describes the protocol. The runtime's
schemas in [`src/protocol/chat-protocol.ts`](https://github.com/lensapp/prism-agent/blob/main/src/protocol/chat-protocol.ts) are its authority, and this package's
contract test replays a recorded session from `src/protocol/fixtures/` against the
client.

```ts
import { ChatConnection } from '@lensapp/prism-client';

const connection = new ChatConnection(() => 'wss://agent.example.com/api/ws');
connection.listen({ message: (message) => console.log(message.content) });
connection.start();
```

A page on another origin reaches the agent through the Lens Agents sandbox ingress with a
bearer token. The runtime must list that page's origin in `PRISM_ALLOWED_ORIGINS`, and the
ingress in `sandboxIngress.corsOrigins`. Both options below are read again for each socket and
each request, so a short-lived token stays current:

```ts
import { ChatConnection, createRuntimeClient, ingressProtocols } from '@lensapp/prism-client';

const agent = 'https://my-agent.agents.example.com';
const connection = new ChatConnection(() => `${agent.replace(/^http/, 'ws')}/api/ws`, {
  protocols: async () => ingressProtocols(await getToken()),
  clientName: 'my-app',
});
const api = createRuntimeClient({
  baseUrl: agent,
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
});
```

`fetchAttachment(id)` reads an attachment with the same headers, since an `<img src>` on
another origin cannot carry the token.

`@lensapp/prism-client/testing` exports `FakeWebSocket`, a stand-in that lets a test
play the runtime.
