# Voice chat

You can talk to the agent out loud: your client sends your microphone, the agent
answers, and its tools run while you speak. Where
[voice calls](voice-calls.md) put the agent in a call on its computer, a voice
chat is a direct conversation between the agent and one client.

**Nothing about the call is written down.** There is no transcript, and no
message appears in the thread. What you hear is all the call produces. To speak a
message into the thread instead, use [dictation](dictation.md).

## What you need

An OpenAI voice credential, from managed OpenAI/Azure or `OPENAI_REALTIME_API_KEY` /
`OPENAI_API_KEY` in a standalone direct setup (no managed inference variables
or custom `OPENAI_BASE_URL`), shared with voice calls — see
[Configuration](configuration.md#voice-chat). A managed endpoint has to serve GPT-Live.

If outbound traffic is filtered, allow the resolved voice endpoint: Lens for
managed voice, or `api.openai.com` for direct voice.

Nothing else. The audio travels on the connection your client already uses for
chat, so a voice chat works wherever chat works: a container, a hosted sandbox
behind a reverse proxy, the installed binary. A voice call needs the agent's
computer; this does not.

The agent has one voice, so **one call at a time**. A voice chat is refused while
a voice call is live, and a voice call is refused while a voice chat is live.

## Starting a call

Press the phone at the top right of the [Web UI](web-ui.md#chat)'s chat page; the
browser asks for the microphone the first time. A call and a
[voice message](dictation.md) cannot run at the same time.

The terminal UI has no voice control. Another client starts a call by speaking
the runtime's voice frames on the chat connection —
`src/services/voice/socket-audio.ts` and
`src/services/websocket-gateway.service.ts` define them.

## The agent's computer

Press **Talk** on the Web UI's **Computer** page to discuss the live desktop.
The agent uses the computer itself, or passes your instructions to a chat task that
is using it. See
**[The agent's computer](computer.md)**.

When you record your screen there, the agent hears you talk it through and waits. When
you stop, it looks at the pictures of your screen and answers.

## Who the agent answers

The agent's voice is OpenAI's GPT-Live model. It takes its own turns, and it stops when
you talk over it. The voice hands work that needs thought or a tool to the agent, which
runs on its own chat model with all its tools. The voice keeps talking while the agent
works, and requests run one at a time, in order.

It answers you. If other people near your microphone talk to each other, it keeps
listening and says nothing until somebody speaks to it, by name or with a direct
question.

## What it can do, and its authority

The agent brings the tools it has in a call: its shell, its memory, its
configuration, and whatever else the runtime gives it. The one tool withheld is
**file sharing** — it stores a file and hands back a reference for the chat
machinery to deliver, which a call does not run, so it would file something away
that reached nobody. Ask the agent for the file in chat afterwards.

**A call is not an authenticated channel.** The runtime does not authenticate a
voice chat any more than it authenticates its other endpoints: auth is terminated
by the platform routing in front of the container. Whoever reaches that
connection can speak, and the agent cannot verify who they are.

Nothing is held back for safety. The single guardrail is an instruction in the
agent's prompt: announce what it is about to do and get an explicit "yes" before
anything that deletes, deploys, spends money, grants access, or changes its own
configuration. **That includes changing itself** — renaming itself, rewriting its
Soul, user profile, memory, vision or heartbeat config, and changing its
settings. So a sentence agreed in a call can change the agent for every future
turn on every channel, not just for the length of the call.

Instructions are a strong default, not enforcement. Treat access to a voice chat
as handing over the agent's own authority, its own configuration included. For a real
restriction, start the agent with a narrower tool surface.

## When it doesn't work

- **The call is refused.** The text says why: a voice call holds the agent's
  voice, another client already has the session, or the runtime is still loading
  its agent and the call can be retried.
- **The call does not start on a managed install.** The runtime log shows
  `Live handshake failed`. With a `404` status, the Lens gateway does not serve
  GPT-Live; set `OPENAI_REALTIME_API_KEY` to use OpenAI directly.
- **The call ends on its own.** The agent's voice session closed. Start another.
- **The agent talks over you, or answers nothing.** Both are the client's audio
  handling: it has to send your microphone continuously, silence included, since
  the silence is how the voice hears that you stopped, and it has to drop
  unplayed audio when the runtime tells it to.
- **Speech sounds broken on a mobile link.** The audio rides the chat connection,
  which has no jitter buffer and no packet-loss concealment, so a poor link sounds
  worse here than a media transport would.
