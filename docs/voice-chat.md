# Voice chat

A client can talk to the agent out loud: it sends your microphone, the agent
answers, and its tools run while you speak. Where
[voice meetings](voice-meetings.md) put the agent in a Google Meet call, a voice
chat is a direct one-to-one conversation between the agent and one client.

This page is the client contract. It describes every frame on the wire, the audio
format in both directions, the session lifecycle and every error the runtime
sends, so a new client — a browser, an iOS app, a test harness — can be written
from this page alone.

**Nothing about the call is written down.** There is no transcript, and no message
appears in the thread. What you hear is all the call produces.

## What you need

Only `OPENAI_API_KEY`. The voice model is OpenAI's Realtime API, connected
directly to `api.openai.com` — the same key voice meetings use, see
[Configuration](configuration.md#voice-meetings).

Nothing else. The audio travels on the WebSocket the client already uses for
chat, so a voice chat works wherever chat works: a container, a hosted sandbox
behind a reverse proxy, the installed binary. It needs no relay, no ICE, no
browser and no audio packages — where a voice meeting needs Chromium and
PulseAudio, this needs neither.

The agent has one voice, so **one call at a time**: a voice chat is refused while
a Meet call is live, and a Meet call is refused while a voice chat is live.

## The exchange

Everything rides the WebSocket at `/api/ws` — the control frames and the audio
both. Control frames are JSON objects with a `type` and a `payload`; audio is
sent as **binary** frames.

1. The client sends `voice_start`.
2. The runtime answers `voice_hello` with the audio format, then
   `voice_state: live`. Audio flows in both directions from there — or the
   runtime refuses with `voice_error`.
3. Each side sends binary frames of audio for as long as the call runs.
4. The client sends `voice_stop` to end the call — or just closes the socket.
5. The runtime sends `voice_state: ended`. That is always the last frame of a
   session.

### Client to runtime

| Type | Payload | Meaning |
|------|---------|---------|
| `voice_start` | `threadId` (string, optional) | Start a session. `threadId` is the thread the call belongs to, which the agent's tools use; omit it and the tools that need a thread work without one. |
| *binary* | — | One frame of your microphone. See [The audio](#the-audio). |
| `voice_stop` | none | End the session. Only the socket that started the session can end it; from any other socket this does nothing. Sent before the session opens it still counts: the session ends as soon as it opens. |

### Runtime to client

| Type | Payload | Meaning |
|------|---------|---------|
| `voice_hello` | `format`: `{encoding, sampleRate, channels}` | The audio format, for both directions. Sent once, before `live`. |
| `voice_state` | `state`: `live` or `ended` | `live` — audio flows. `ended` — the session is over; release the microphone. |
| `voice_clear` | none | **Drop every audio frame you have not played yet, now.** See [Interrupting](#interrupting). |
| `voice_error` | `error` (string) | Why the session could not start, or could not continue. Readable text, meant to be shown to the user. |
| *binary* | — | One frame of the agent's speech. |

### An example session

```json
→ {"type":"voice_start","payload":{"threadId":"3f1c…"}}
← {"type":"voice_hello","payload":{"format":{"encoding":"pcm16","sampleRate":24000,"channels":1}}}
← {"type":"voice_state","payload":{"state":"live"}}
→ <binary: 480 bytes of pcm16>
← <binary: 960 bytes of pcm16>
← {"type":"voice_clear"}
→ {"type":"voice_stop"}
← {"type":"voice_state","payload":{"state":"ended"}}
```

## The audio

**pcm16, mono, 24 kHz, little-endian, in both directions.** One frame per binary
message; about 20 ms of audio per frame is a good size, and no size is required.

That rate is the voice model's own, so nothing between your microphone and the
model converts anything. Getting there is the client's job, and it is cheap: a
browser builds `new AudioContext({ sampleRate: 24000 })` and the platform
resamples capture into it; on iOS, `AVAudioConverter` does it.

A frame with an odd number of bytes is dropped — pcm16 is two bytes a sample, and
half a sample would shift every sample after it.

Two obligations, both load-bearing:

- **Stream continuously, silence included.** The turn detector needs the silence
  to decide an utterance has ended. A client that sends only while it thinks
  somebody is talking will hang mid-conversation.
- **Handle text and binary frames in the order they arrive.** `voice_clear` is
  ordered against the audio it cancels, so a client that hands audio to an audio
  thread while decoding JSON elsewhere will drop the wrong frames.

The agent yields the floor when you start talking, so an interruption works the
way it does in a phone call.

## Interrupting

When you interrupt, the runtime stops speaking and tells the model how much of
its answer you actually heard. It also sends **`voice_clear`**, because the audio
it had already written is in *your* buffer by then.

A client that ignores `voice_clear` keeps playing the sentence it was interrupted
in, for as long as its buffer holds — so the agent talks over the person who
interrupted it. Drop the queue when that frame arrives, and keep the queue small:
whatever is buffered is audio nobody can recall.

## The session lifecycle

| The client has | The state | What to do |
|----------------|-----------|------------|
| Sent `voice_start` | Starting | Wait for `voice_hello` or `voice_error`. |
| `voice_state: live` | Live | Audio flows. Offer one control that ends the call. |
| `voice_error` | Failing or refused | Show the text. When it is a refusal, no session started and no `ended` follows. |
| `voice_state: ended` | Over | Release the microphone. |

Three things end a session: the client's `voice_stop`, the socket closing, and a
failure. A failure sends `voice_error` first and `voice_state: ended` after, so a
client that only watches `ended` still tears down correctly, and one that shows
the error can say why. An ending the client asked for sends `ended` alone.

A runtime that shuts down ends the live session as it goes. The socket closes at
the same time, so treat a closed socket as the end of the call rather than
waiting for `ended`. A voice chat has no duration cap of its own: it runs until
one of the endings above.

Once a session has ended, a new `voice_start` starts a new one.

## Errors

Every one of these arrives as `voice_error` with the text in `payload.error`.

| Text | Cause |
|------|-------|
| `Agent runtime is still initializing; retry shortly` | The runtime has not finished loading its agent. Retry. |
| `I'm in a meeting call right now. That has to end before I can talk here.` | A Google Meet call holds the agent's voice. |
| `There is already a voice chat running. End that one first.` | Another client — a second tab, a second device — has the session. The running call is unaffected. |
| `Could not start the voice chat: …` | Startup failed, with the reason appended: the model session would not open, or the agent's context could not be read. |
| A reason from the model session, e.g. `the model closed the socket` | The Realtime session ended under the call. `voice_state: ended` follows. |

The first three are refusals: nothing started, and no `ended` frame follows. The
last two end a session that was running.

A microphone the user denies is the client's own error to report — the runtime
never sees it, because there is no `voice_start` to send.

## What this costs

Worth knowing if you are writing a client for a phone. A WebSocket has no jitter
buffer, no packet-loss concealment and no congestion control, so a poor mobile
link sounds worse here than a media transport would. pcm16 at 24 kHz is about
384 kbit/s each way.
