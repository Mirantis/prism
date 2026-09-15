# Voice chat

You can talk to the agent out loud: your client sends your microphone, the agent
answers, and its tools run while you speak. Where
[voice meetings](voice-meetings.md) put the agent in a Google Meet call, a voice
chat is a direct conversation between the agent and one client.

**Nothing about the call is written down.** There is no transcript, and no
message appears in the thread. What you hear is all the call produces.

## What you need

Only `OPENAI_API_KEY`, the same key voice meetings use — see
[Configuration](configuration.md#voice-chat).

If the runtime's outbound network is filtered, allow `api.openai.com`. A runtime
that cannot reach it refuses the call and says why.

Nothing else. The audio travels on the connection your client already uses for
chat, so a voice chat works wherever chat works: a container, a hosted sandbox
behind a reverse proxy, the installed binary. A voice meeting needs Chromium and
PulseAudio; this needs neither.

The agent has one voice, so **one call at a time**. A voice chat is refused while
a Meet call is live, and a Meet call is refused while a voice chat is live.

## Starting a call

Press the microphone in the chat composer of the [Web UI](web-ui.md#chat). The
browser asks for the microphone the first time, and the same button ends the
call. While a call runs, a second button beside it mutes the microphone: the
agent hears nothing until you press it again, and keeps talking to you in the
meantime.

The terminal UI has no voice control. Another client starts a call by speaking
the runtime's voice frames on the chat connection —
`src/services/voice/socket-audio.ts` and
`src/services/websocket-gateway.service.ts` define them.

## The agent's computer

Press **Talk** on the Web UI's **Computer** page to discuss the live desktop.
Voice can pass your instructions to an active chat task. See
**[The agent's computer](computer.md)**.

## Who the agent answers

A voice chat is either a conversation or a room, and the client says which when
the call starts. Changing it means ending the call and starting another.

**A conversation** is the default: one person is talking to the agent, so
everything the microphone hears is meant for it, and the agent answers each
utterance as soon as you stop speaking. This is a phone held to your ear.

**A room** is several people talking, most of it to each other. The agent listens
to all of it and answers only the utterances aimed at it, so somebody has to call
it by name. A name that is mentioned rather than used — "I asked Prism about that
yesterday" — does not summon it, and a follow-up inside an exchange it is already
part of reaches it without the name being repeated. Expect two things: the agent
stays quiet for long stretches, which is it working, and each answer starts about
a second later than in a conversation.

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
as handing over the agent's own authority, its own configuration included. Waiting
to be addressed narrows what the agent *responds* to, not what it can be asked to
do. For a real restriction, start the agent with a narrower tool surface.

## When it doesn't work

- **The call is refused.** The text says why: a Meet call holds the agent's
  voice, another client already has the session, or the runtime is still loading
  its agent and the call can be retried.
- **The call ends on its own.** The agent's model session closed. Start another.
- **The agent talks over you, or answers nothing.** Both are the client's audio
  handling: it has to send your microphone continuously, silence included, since
  the silence is how the end of an utterance is found, and it has to drop
  unplayed audio when the runtime tells it to.
- **Speech sounds broken on a mobile link.** The audio rides the chat connection,
  which has no jitter buffer and no packet-loss concealment, so a poor link sounds
  worse here than a media transport would.
