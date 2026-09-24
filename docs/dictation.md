# Dictation

A client can send a spoken message instead of a typed one. You hold the
microphone and speak, and when you let go, the words arrive as your message in
the chat. The agent does not speak back, and the recording is not kept.

## What you need

The same Realtime credential [voice chat](voice-chat.md#what-you-need) uses. The
transcriber is `OPENAI_TRANSCRIPTION_MODEL`; see
[Configuration](configuration.md#voice-meetings).

A dictation does not use the agent's voice. You can dictate while a voice chat
or a Meet call is live on another connection.

## Using it

The Lens Agents iOS app has a microphone in its chat composer. Hold it to record,
and release to send. Tap it to record hands-free, then press send, or press ✕ to
discard the recording.

Any other client speaks the dictation frames on the chat connection:
`dictation_start`, binary pcm16 audio, and `dictation_stop`, with
`commit: false` to discard. `src/services/websocket-gateway.service.ts` defines
them.

## When it doesn't work

- **The dictation is refused.** The text says why: a voice chat is running on
  the same connection, or the agent has no managed voice provider.
- **Nothing is sent.** The recording had no speech in it.
- **A recording stops by itself.** It reached five minutes, and what you said
  is sent.
