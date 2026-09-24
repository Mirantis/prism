# Dictation

You can speak a message instead of typing it. Press the microphone, speak, and
press send: the words arrive as your message in the chat. The agent does not
speak back, and the recording is not kept.

## What you need

The same Realtime credential [voice chat](voice-chat.md#what-you-need) uses. The
transcriber is `OPENAI_TRANSCRIPTION_MODEL`; see
[Configuration](configuration.md#voice-meetings).

A dictation does not use the agent's voice. You can dictate while a voice chat
or a Meet call is live on another connection.

## Using it

Press the microphone beside the send button in the [Web UI](web-ui.md#chat)'s chat
composer, and speak. The browser asks for the microphone the first time. Press
send when you are done, or ✕ to discard the recording.

Another client speaks the dictation frames on the chat connection:
`dictation_start`, binary pcm16 audio, and `dictation_stop`, with
`commit: false` to discard. `src/services/websocket-gateway.service.ts` defines
them.

## When it doesn't work

- **The dictation is refused.** The text at the top of the composer says why: a voice
  chat is running on the same connection, or the agent has no managed voice
  provider.
- **The microphone is blocked.** Allow it for the page in the browser's site
  settings, then press the microphone again.
- **Nothing is sent.** The recording had no speech in it.
- **A recording stops by itself.** It reached five minutes, and what you said
  is sent.
