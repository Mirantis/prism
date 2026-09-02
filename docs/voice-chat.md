# Voice chat

A client can talk to the agent over WebRTC: it sends your microphone, the agent
answers out loud, and its tools run while you speak. Where
[voice meetings](voice-meetings.md) put the agent in a Google Meet call, a voice
chat is a direct one-to-one conversation between the agent and one client.

This page is the client contract. It describes every frame on the wire, the audio
format in both directions, the session lifecycle and every error the runtime
sends, so a new client — a browser, an iOS app, a test harness — can be written
from this page alone.

**Nothing about the call is written down.** There is no transcript, and no message
appears in the thread. What you hear is all the call produces.

## What you need

1. **`OPENAI_API_KEY`.** The voice model is OpenAI's Realtime API, connected
   directly to `api.openai.com`. This is the same key voice meetings use — see
   [Configuration](configuration.md#voice-meetings).
2. **A runtime with WebRTC support.** The published container image has it. A build
   for a platform with no native WebRTC binding refuses an offer in words (see
   [Errors](#errors)) rather than failing silently.
3. **A reachable media path.** Read the next section before you write a client:
   it decides whether the connection can be established at all.

The agent has one voice, so **one call at a time**: a voice chat is refused while
a Meet call is live, and a Meet call is refused while a voice chat is live.

## Reachability, and its limit

The runtime offers its peer whatever STUN and TURN servers `VOICE_ICE_SERVERS`
names. **That list is empty by default, and the runtime provisions nothing.**

With an empty list the runtime offers **host candidates only**, so the client has
to reach the runtime's host directly. That covers `localhost`, a LAN, a Docker
port mapping and a test in one sandbox. It does **not** cover a browser reaching a
hosted runtime through an HTTPS reverse proxy or a tunnel: signalling arrives over
that proxy, the media path has nowhere to go, and the call never starts: the
client sends its offer, receives an answer, exchanges candidates, and never
receives `voice_state: live`.

Such a deployment needs a STUN server configured, and a network that blocks
direct UDP between the two ends needs a TURN relay as well. Configure them in
`VOICE_ICE_SERVERS` ([Configuration](configuration.md#voice-chat)); ICE then picks
the candidate that works, and no client change is needed.

## The signalling exchange

Signalling rides the WebSocket the client already uses for chat, at `/api/ws`.
**The audio does not** — it goes over the peer connection these frames set up.

Every frame is one JSON object with a `type` and a `payload`.

1. The client creates a peer connection, adds its microphone track, creates an
   offer, sets it as its local description, and sends `voice_offer`.
2. The runtime answers with `voice_answer`, or refuses with `voice_error`.
3. Both sides send `voice_ice` as they gather candidates. The runtime's first
   candidate always arrives **after** the answer.
4. The runtime sends `voice_state: live` when the media path is up. Audio flows in
   both directions from here.
5. The client sends `voice_stop` to end the call — or just closes the socket.
6. The runtime sends `voice_state: ended`. That is always the last frame of a
   session.

### Client to runtime

| Type | Payload | Meaning |
|------|---------|---------|
| `voice_offer` | `sdp` (string, required), `threadId` (string, optional) | Start a session. `threadId` is the thread the call belongs to, which the agent's tools use; omit it and the tools that need a thread work without one. |
| `voice_ice` | `candidate` (string, required), `sdpMid` (string), `sdpMLineIndex` (number) | One of your candidates. Send these after the answer arrives; one sent earlier, or one from a socket that does not hold the session, is dropped. A frame with no `candidate` string is ignored, so the end-of-gathering marker needs no frame of its own. |
| `voice_stop` | none | End the session. Only the socket whose offer opened the session can end it; from any other socket this does nothing. Sent before the answer arrives it still counts: the session ends as soon as it opens. |

### Runtime to client

| Type | Payload | Meaning |
|------|---------|---------|
| `voice_answer` | `sdp` (string) | The answer to your offer. Set it as your remote description. |
| `voice_ice` | `candidate`, `sdpMid`, `sdpMLineIndex`, `usernameFragment` | One of the runtime's candidates. Add it to your peer connection. The runtime sends no end-of-candidates frame. |
| `voice_state` | `state`: `live` or `ended` | `live` — the media path is up. `ended` — the session is over; release the microphone. |
| `voice_error` | `error` (string) | Why the session could not start, or could not continue. Readable text, meant to be shown to the user. |

### An example session

```json
→ {"type":"voice_offer","payload":{"sdp":"v=0\r\no=- 42 2 IN IP4 127.0.0.1\r\n…","threadId":"3f1c…"}}
← {"type":"voice_answer","payload":{"sdp":"v=0\r\no=- 17 1 IN IP4 127.0.0.1\r\n…"}}
← {"type":"voice_ice","payload":{"candidate":"candidate:1 1 udp 2130706431 10.0.0.4 51000 typ host","sdpMid":"0","sdpMLineIndex":0}}
→ {"type":"voice_ice","payload":{"candidate":"candidate:1 1 udp 2130706431 10.0.0.9 54321 typ host","sdpMid":"0","sdpMLineIndex":0}}
← {"type":"voice_state","payload":{"state":"live"}}
→ {"type":"voice_stop"}
← {"type":"voice_state","payload":{"state":"ended"}}
```

## The audio

The offer carries **one audio track, in both directions**: the runtime adds its
own audio track to the answer, so offer a single `sendrecv` audio m-line. No
video, and no data channel.

| Direction | What travels | What the client does |
|-----------|--------------|----------------------|
| Client to agent | Opus, mono, over the peer connection | Send an ordinary microphone track. The runtime decodes it. |
| Agent to client | Opus, mono, over the peer connection | Play the track it receives. |

Both sides are ordinary WebRTC audio: the codec is negotiated in the SDP and the
peers do the encoding. A client does not resample, re-frame or convert anything.
Inside the runtime the audio is 16-bit PCM, mono, at 48 kHz in both directions,
which is what the voice model takes and produces.

The agent yields the floor when you start talking, so an interruption works the
way it does in a phone call.

## The session lifecycle

| The client has | The state | What to do |
|----------------|-----------|------------|
| Sent `voice_offer` | Starting | Wait for `voice_answer` or `voice_error`. |
| `voice_answer` | Connecting | Set the remote description, exchange candidates. Show the user that the call is connecting, not that it is live. |
| `voice_state: live` | Live | Audio flows. Offer one control that ends the call. |
| `voice_error` | Failing or refused | Show the text. When it is a refusal, no session started and no `ended` follows. |
| Neither `live` nor an error | Failing | Watch your own peer connection. Treat its `failed` state as the end of the call, and send `voice_stop`. |
| `voice_state: ended` | Over | Release the microphone and close the peer connection. |

The runtime sets no deadline on a media path that never comes up: a peer that
never connects sends no `live`, no `voice_error` and no `ended`, so the client's
own peer connection is the only thing that reports it. This is the reverse-proxy
case above.

Three things end a session: the client's `voice_stop`, the socket closing, and a
failure. A failure sends `voice_error` first and `voice_state: ended` after, so a
client that only watches `ended` still tears down correctly, and one that shows
the error can say why. An ending the client asked for sends `ended` alone.

A runtime that shuts down ends the live session as it goes. The socket closes at
the same time, so treat a closed socket as the end of the call rather than waiting
for `ended`. A voice chat has no duration cap of its own: it runs until one of the
endings above.

Once a session has ended, a new `voice_offer` starts a new one.

## Errors

Every one of these arrives as `voice_error` with the text in `payload.error`.

| Text | Cause |
|------|-------|
| `A voice offer needs an sdp` | The `voice_offer` frame carried no `sdp` string. |
| `Agent runtime is still initializing; retry shortly` | The runtime has not finished loading its agent. Retry. |
| `This build cannot carry a voice chat — its WebRTC support is missing.` | This runtime has no native WebRTC binding. Voice chat is unavailable until the deployment changes; retrying does not help. |
| `I'm in a meeting call right now. That has to end before I can talk here.` | A Google Meet call holds the agent's voice. |
| `There is already a voice chat running. End that one first.` | Another client — a second tab, a second device — has the session. The running call is unaffected. |
| `Could not start the voice chat: …` | Startup failed, with the reason appended: the model session would not open, the offer could not be answered, or the agent's context could not be read. |
| `the media connection is failed` (also `closed`, `disconnected`) | The peer connection went away mid-call. `voice_state: ended` follows. |
| A reason from the model session, e.g. `the model closed the socket` | The Realtime session ended under the call. `voice_state: ended` follows. |

The first five are refusals: nothing started, and no `ended` frame follows. The
last three end a session that was running.

A microphone the user denies is the client's own error to report — the runtime
never sees it, because there is no offer to send.

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENAI_API_KEY` | Enables voice chat and voice meetings. | — (disabled) |
| `VOICE_ICE_SERVERS` | STUN and TURN servers the runtime's peer offers. | — (host candidates only) |

Both are described in [Configuration](configuration.md#voice-chat), with the
`VOICE_ICE_SERVERS` format and the voice and model settings the two voice
features share.
