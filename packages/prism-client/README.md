# @lensapp/prism-client

The browser client for a Prism agent runtime: the `/api/ws` chat protocol (version 2),
the socket that keeps a conversation in step with the runtime, and the types the
runtime's REST surface answers with. The Prism web UI is built on it.

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

`@lensapp/prism-client/testing` exports `FakeWebSocket`, a stand-in that lets a test
play the runtime.
