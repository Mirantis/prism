# Voice meetings

The agent can join a Google Meet call and take part by voice — it listens, speaks,
and uses its tools while the call is happening. Ask it in chat:

> Join `https://meet.google.com/abc-defg-hij`

It requests to join as a guest, a host admits it like any other participant, and
from then on it is in the room. Someone can ask it a question out loud and it
answers out loud; if the answer needs a lookup, it runs the tool and reports back
in the same breath. Ask it to leave, or say "join us" and forget about it — it
leaves on its own once everyone else has gone.

Google Meet is the only supported platform today. The runtime's meeting support is
platform-agnostic underneath, so Teams and Zoom can be added without touching the
audio or model path.

## What you need

Voice meetings need two things, and the agent's `join_google_meet` tool only
appears when both are present:

1. **The container image.** It ships the browser and audio toolchain (Chromium,
   Xvfb, PulseAudio). A native install via the `prism` binary has no browser to
   drive, so the feature is container-only.
2. **`OPENAI_API_KEY`.** The voice model is OpenAI's Realtime API — the one model
   call in the runtime that does *not* go through your configured Bedrock/Azure
   provider, because none of them serves a realtime voice surface. Your chat model
   is unaffected; only the in-meeting voice uses OpenAI.

```bash
docker run -d \
  -e AGENT_ID="$(uuidgen)" \
  -e AWS_BEARER_TOKEN_BEDROCK=... \
  -e OPENAI_API_KEY=sk-... \
  -p 3003:3003 -v prism-data:/data \
  ghcr.io/lensapp/prism-agent:latest
```

In a Lens sandbox the key can be a managed credential — it is only ever sent as a
request header, so the platform swaps it at the network boundary and no real key
lands in the container. If your deployment filters egress, allow `api.openai.com`
along with Google's meeting hosts (including WebRTC UDP).

## Joining

The agent joins as an **anonymous guest**, exactly like a person opening the link
without signing in. That means:

- **A host has to admit it.** The join tool returns as soon as the request is in —
  it does not wait, because a host might take minutes. You'll get "Requested to
  join… a host needs to admit me", and then a second note when it's actually in.
- **Some meetings won't let it in at all.** Workspace tenants can restrict a
  meeting to signed-in members of the organization. The agent reports what Meet
  told it rather than retrying.
- **It joins with no camera.** It appears as a name and an avatar tile.

It uses its own name by default; pass a different one, or set
`MEETING_DISPLAY_NAME`, if you'd rather it show up as "Prism (bot)".

The agent handles one call at a time. Asking it to join a second one while it's in
a meeting returns an error rather than dropping the first.

## In the call

**It only answers what's aimed at it.** The audio it hears is the whole room, most
of which is people talking to each other. It's instructed to stay out of the way
unless it's addressed by name or asked something directly. For a big meeting where
even that is too eager, pass `addressedOnly` — then it only ever speaks when its
name comes up or someone asks it a direct question:

> Join `https://meet.google.com/abc-defg-hij`, but only speak when someone asks you
> something

**You can interrupt it.** Start talking and it stops — humans have the floor. A
short "mm-hm" or a cough won't cut it off mid-sentence; a real interjection will,
and it picks up from what you actually heard rather than pretending it finished.

**It keeps its answers short.** One to three sentences, spoken, no markdown read
aloud. If the real answer is a command or a long list, it says so and offers to put
it in the chat afterwards.

**It can't tell who is speaking.** The meeting audio arrives as one mixed channel
with no speaker labels, so it won't attribute anything to a specific person. It may
also mishear a name or a number, and is told to read important details back before
acting on them.

## Tools, and what it won't do on a spoken request

The agent keeps most of its real tools in the meeting — memory search, its shell
and its connected integrations. It can check a cluster, read a file, or search its
memory and tell you the answer without leaving the call.

**A meeting is not an authenticated channel.** Anyone with the link can speak, and
the agent cannot verify who anyone is. Two layers follow from that.

**Nothing said in a call can outlive it.** These tools are withheld outright in a
meeting, in code and not merely by instruction:

- **Scheduling** (`schedule_task` and friends). This one matters most: a spoken
  request would otherwise become a saved task that runs later, on its own, with a
  *wider* set of tools than the meeting allows — a way around every other limit
  here.
- **Editing its own configuration** — its Soul, user profile, settings, heartbeat,
  vision. A sentence in a call would otherwise reshape every future conversation.
- **Writing to memory.** Same reason: it would persist as fact.

**Anything that changes state needs chat.** For the tools it does keep, the agent is
instructed to look things up and report freely, but to refuse anything that
deploys, deletes, spends, or grants access on a spoken request alone — and to raise
it with its configured user in chat instead. It holds to that even if the speaker
claims to be that person. This layer is instruction rather than enforcement, so it
is a strong default and not a guarantee: if you would not give everyone on the call
shell access to the container, keep the link private.

Two further limits are for the room's sake rather than for safety: the agent can't
start a Claude Code sub-agent or a background process during a call (those run for
minutes while the meeting waits in silence), and it can't create goals or share
files, which need a conversation thread a meeting doesn't have.

It *can* leave on request — "you can drop off now" works, and it hangs up.

## Cost

Realtime audio is billed per audio token, in both directions, and a meeting bot
hears everything — a quiet hour still costs. Expect roughly **$0.10–0.30 per
minute** with the default `gpt-realtime`. Two levers:

- `OPENAI_REALTIME_MODEL=gpt-realtime-mini` is materially cheaper.
- `addressedOnly` cuts the expensive half (spoken responses) down to the turns
  actually meant for the agent.

Every call is capped at `MEETING_TIMEOUT_MINUTES` (60 by default), so a meeting
nobody ended can't run up a bill overnight.

## Telling people

Tell the other participants that the agent is in the call and what it's for. It
introduces itself when admitted, but a bot listening to a conversation is something
people should know about and agree to — in many places recording or processing a
call without consent is also a legal question, not just an etiquette one.

## Settings

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENAI_API_KEY` | Enables voice meetings. May be a managed-credential sentinel. | — (disabled) |
| `OPENAI_REALTIME_MODEL` | Realtime model for the in-meeting voice. | `gpt-realtime` |
| `OPENAI_REALTIME_VOICE` | Voice name; unset lets the API choose. | — |
| `MEETING_DISPLAY_NAME` | Name shown to participants. | the agent's name |
| `MEETING_TIMEOUT_MINUTES` | Hard cap on one call. | `60` |
| `MEETING_ADMISSION_TIMEOUT_SECONDS` | How long to wait to be admitted. | `300` |

## When it doesn't work

**The agent says it can't join meetings, or doesn't offer to.** The tool is only
registered when the toolchain and the key are both present — check the startup log
for `Voice meetings available` or `Voice meetings unavailable`, and confirm
`OPENAI_API_KEY` is set and you're running the container image.

**It waits forever to be admitted.** Nobody clicked Admit, or the meeting blocks
anonymous guests. It gives up after `MEETING_ADMISSION_TIMEOUT_SECONDS` and says
so.

**It's in the call but silent, or nobody can hear it.** Almost always the audio
devices: check the runtime log for `parec`/`pacat` warnings. A container needs
enough `/dev/shm` for Chromium — the runtime already passes
`--disable-dev-shm-usage`, but a heavily constrained container can still starve it.

**It joined but hears nothing.** Confirm the other participants aren't muted, then
check that the meeting is actually sending audio to the browser (Meet occasionally
needs the tab focused; the virtual display keeps it focused by default).
