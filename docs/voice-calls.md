# Voice calls

Prism can take part by voice in a call on [its computer](computer.md). The call runs
in any app on that desktop: a web meeting in the browser, such as Google Meet, a Slack
huddle or Zoom on the web, or a call client installed on the computer. Ask it in chat:

> Join the call at `https://meet.example.com/abc-defg-hij`

The agent opens the link, turns its camera off, joins, and connects its voice. From
then on it hears the call, speaks in it, and uses its tools while the call runs. Open
**Computer** in the [Web UI](web-ui.md) to watch it.

The agent has one voice, so a call and a [voice chat](voice-chat.md) exclude each
other.

## What you need

1. **The agent's computer.** Run the published container image, which includes the
   desktop. See [The agent's computer](computer.md).
2. **A voice credential**, the same one voice chat uses. See
   [Configuration](configuration.md#voice-calls).
3. **A signed-in call app, when the app needs an account.** Open **Computer**, take
   control, and sign in once yourself. The session is saved in the data volume.
   Other people in the call see the name of that account, so use a dedicated one.

The agent offers to join a call only when the first two are present. A call in the
browser works with no other setup. To use a desktop call client, install it on the
computer.

### Egress

If your deployment filters outbound traffic, allow:

| Host | Why |
|------|-----|
| `api.openai.com:443` | Direct voice only. Managed voice connects to the Lens endpoint |
| The call app's own hosts | The call itself, and the app's sign-in |

**Call audio needs more than an HTTPS allowlist.** Call apps carry media over UDP, which
a CONNECT proxy cannot carry at any hostname. Without it the agent joins the call and
then hears nothing, or drops. Open the UDP ports your call app documents; for Google
Meet, see
[Google's network requirements](https://knowledge.workspace.google.com/admin/meet/prepare-your-network-for-meet-meetings-and-live-streams).
Where only TCP 443 is open, the app falls back to its relay servers. Tunnel those
connections, and do not TLS-inspect them.

## Joining

You can ask for a call in chat, or set one up ahead: a scheduled task, a goal or a
heartbeat check can join a call too. A webhook cannot.

The agent speaks through the computer's microphone, which the call app lists as
**PrismMicrophone**. After it joins, the agent says whether the app is using that
microphone. If it is not, nobody hears the agent: ask it to unmute in the app, or pick
**PrismMicrophone** yourself on the Computer page.

A host admits the agent from a waiting room like any other participant. The agent
takes part in one call at a time.

## In the call

**It takes its own turns.** The agent's voice is OpenAI's GPT-Live model. The voice
hands work that needs thought or a tool to the agent, which runs on its own chat model
with all its tools. The voice keeps talking while the agent works, tells you how the
work is going, and can answer you meanwhile. Requests run one at a time, in the order
you make them. Start talking and the voice stops.

**In a group, it answers when it is spoken to.** Say its name ("Prism, can you check
the cluster?") or ask it a direct question. When people talk to each other, it keeps
listening and says nothing.

**It uses the call app's own controls**, through its computer: mute and unmute, the
camera, the chat, screen sharing and the leave button. Ask it to type a link into the
chat, or to read what you typed there. A screen share shows the whole desktop.

**It hears the call as one stream.** It asks who is speaking when a name matters. It
can mishear a name or a number, and it reads important details back before it acts on
them.

**Every sound the desktop plays reaches the agent** as part of the call, a video in
another tab included.

On the Computer page you hear the other people in the call, but not Prism. If you are
also in the call yourself, mute the page's **Sound**.

## Tools, and what it will not do on a spoken request

The agent has all of its tools in a call except **file sharing**. Ask for a file in
chat after the call. When a website needs you, for example to sign in, the agent sends
a [help request](computer.md#when-prism-needs-help) to the Computer page, as in chat.

Work that does not fit in the call becomes a one-off
[scheduled task](scheduled-tasks.md). The agent says what it set up and when it runs,
and the result arrives in your chat after the call.

**A call is not an authenticated channel.** Anyone in the call can speak, and the agent
cannot verify who they are. The one guardrail is an instruction in its prompt: announce
what it is about to do and get an explicit "yes" before anything that deletes, deploys,
spends money, grants access, or changes its own configuration.

**That includes changing itself.** Renaming itself, rewriting its Soul, user profile,
memory, vision or heartbeat configuration, and changing its settings all follow the
same rule. So a sentence agreed in a call can change the agent for every later turn on
every channel.

An instruction is a strong default, not enforcement. Treat a call as handing the
agent's own authority to everyone in it, its configuration included. For a real
restriction, start the agent with a narrower tool surface.

## When the call ends

Ask the agent to leave. It presses the app's leave button and disconnects its voice.

The voice also ends by itself when:

- the call app releases the microphone and the call stays quiet for about a minute,
  as after a hang-up;
- the desktop stays silent for 15 minutes and no app uses the microphone;
- the call reaches `MEETING_TIMEOUT_MINUTES` (60 by default);
- the voice connection or the computer's audio is lost.

## Privacy

Nothing about a call is stored: no recording, no transcript, no summary, and no message
in your conversation. The call's audio goes to OpenAI's voice service, and each
request the voice hands on goes to the agent's chat model. A task the agent
schedules during the call keeps its name and instruction until it runs, and what the
agent types into the call app's chat stays in that app.

Tell the other participants that the agent is in the call and what it is for. In many
places, processing a call without consent is also a legal question.

The voice costs **$0.05 per minute** of the call, billed by the second. The agent's
work for each request uses its chat model, and its tokens count on the
[Activity page](web-ui.md#activity) like chat.

## Settings

The voice is set in [Configuration](configuration.md#voice-calls). Two settings apply to calls alone:

| Variable | Purpose | Default |
|----------|---------|---------|
| `MEETING_TRANSCRIPT_LOGGING` | Whether what was said may appear in the runtime's log: `off` or `full`. | `off` |
| `MEETING_TIMEOUT_MINUTES` | Hard cap on one call. | `60` |

### What ends up in the log

| Value | What the log contains |
|-------|-----------------------|
| `off` (default) | What the agent did in the call: joining, tools, the microphone, leaving. No words. |
| `full` | The above, plus a `[Voice:Heard]` line for what the call said and a `[Voice:Said]` line for what the agent said, one per stretch of speech. |

`off` is the default because the people in a call did not agree to be written into a
log that outlives it. Turn `full` on only for as long as you need it, and tell the
people in the call. Product telemetry contains no words at either setting.

## When it doesn't work

- **The agent does not offer to join.** The startup log says whether the agent's
  computer is available, and logs `Voice is not configured` when no voice credential
  is found.
- **Voice does not start on a managed install.** The log shows `Live handshake failed`.
  With a `404` status, the Lens gateway does not serve GPT-Live; set
  `OPENAI_REALTIME_API_KEY` to use OpenAI directly.
- **Nobody hears the agent.** The call app is muted or uses another microphone. Unmute
  it, or choose **PrismMicrophone** in the app's audio settings.
- **The agent hears nothing.** Check that the other participants are not muted, and
  that the call app plays through **PrismSpeaker**, the desktop's default speaker.
- **The agent does not answer to its name.** Say the name at the start of the request.
  To see what it heard, set `MEETING_TRANSCRIPT_LOGGING=full` with the agreement of
  the people in the call, and turn it off afterwards.
- **The voice left mid-call.** The voice connection or the computer's audio was lost.
  Ask the agent to connect its voice to the call again.
