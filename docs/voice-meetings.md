# Voice meetings

The agent can join a Google Meet call and take part by voice — it listens, speaks,
and uses its tools while the call is happening. Ask it in chat:

> Join `https://meet.google.com/abc-defg-hij`

It joins signed into its own Google account, a host admits it like any other
participant, and from then on it is in the room. Someone can ask it a question out
loud and it answers out loud; if the answer needs a lookup, it runs the tool and
reports back in the same breath. Ask it to leave, or say "join us" and forget about
it — it leaves on its own once everyone else has gone.

**Speaking is the only thing it can do from a call.** It cannot post to the
meeting's chat panel, to Slack or to your chat session, and nothing said in the call
is written down anywhere afterwards. See [In the call](#in-the-call).

Google Meet is the only supported platform today. The runtime's meeting support is
platform-agnostic underneath, so Teams and Zoom can be added without touching the
audio or model path.

## What you need

Voice meetings need three things, and the agent's `join_google_meet` tool only
appears when the first two are present:

1. **The container image.** It ships the browser and audio toolchain (Chromium,
   Xvfb, PulseAudio). A native install via the `prism` binary has no browser to
   drive, so the feature is container-only.
2. **`OPENAI_API_KEY`.** The voice model is OpenAI's Realtime API — the one model
   call in the runtime that does *not* go through your configured Bedrock/Azure
   provider, because none of them serves a realtime voice surface. Your chat model
   is unaffected; only the in-meeting voice uses OpenAI.
3. **A Google account for the agent** (`GOOGLE_BOT_EMAIL` / `GOOGLE_BOT_PASSWORD`).
   This one is not optional in practice — see below.

```bash
docker run -d \
  -e AGENT_ID="$(uuidgen)" \
  -e AWS_BEARER_TOKEN_BEDROCK=... \
  -e OPENAI_API_KEY=sk-... \
  -e GOOGLE_BOT_EMAIL=prism-bot@example.com \
  -e GOOGLE_BOT_PASSWORD=... \
  -p 3003:3003 -v prism-data:/data \
  ghcr.io/lensapp/prism-agent:latest
```

In a Lens sandbox these can be managed credentials — they are only ever sent as
request headers or typed into Google's own form, so the platform swaps them at the
network boundary and no real secret lands in the container. If your deployment
filters egress, allow `api.openai.com` along with Google's meeting and accounts
hosts (including WebRTC UDP).

### Why the agent needs its own Google account

**Google auto-denies automated anonymous guests.** Asking to join without signing in
gets refused about a second after the request — the join RPC returns 403 and *the
host is never shown a request to admit*. This is policy rather than bot detection:
Google's documentation states that anonymous users and third-party bots using "Ask
to join" are denied without host action, and their March 2026 "safeguarded guest
admit flow" defaults to deny. Patched automation, real Chrome, human-like pacing and
honest user agents all hit the same wall; the same browser signed into an account
joins normally. Every commercial meeting-bot vendor uses signed-in accounts for the
same reason.

So give the agent a **dedicated** account, not a person's:

- It signs in once and the browser profile is kept under `/data`, so later meetings
  reuse the session. That also matters for reliability — Google challenges a *new*
  device, not a returning one.
- If the session goes stale, the agent notices and signs in again on its own.
- The account's display name is what participants see in the call.
- **Accounts with a phone/hardware-key challenge or enforced SSO can't be signed in
  unattended.** The runtime will report what Google's page said and fall back to a
  guest attempt (which will be denied). For those tenants, seed the profile out of
  band instead.

An account inside the meeting's own Workspace is the smoothest case: invite it to
the event and it can skip the waiting room entirely.

## Joining

The agent joins as its own signed-in participant. That means:

- **A host has to admit it.** The join tool returns as soon as the request is in —
  it does not wait, because a host might take minutes. You'll get "Requested to
  join… a host needs to admit me", and then a second note when it's actually in.
- **Some meetings won't let it in at all.** A tenant can restrict a meeting to
  members of its own organization. The agent reports what Meet told it rather than
  retrying.
- **A dead link looks like a guest prompt.** Meet offers a guest name field for a
  meeting that has ended, even to a signed-in visitor, and then refuses the join.
  If a join fails, check the meeting is still running with a host in it — that is
  by far the most common cause.
- **It joins with no camera.** It appears as a name and an avatar tile.

Participants see the Google account's own name. `MEETING_DISPLAY_NAME` only applies
on the guest path.

The agent handles one call at a time. Asking it to join a second one while it's in
a meeting returns an error rather than dropping the first.

## In the call

**It reads the room before it speaks.** The audio it hears is the whole room, and
it has no way to tell who is talking to whom — it is one mixed channel with no
speaker labels. So how much it speaks up depends on how many people are in the
call:

- **Just you and the agent.** It answers everything you say, as an assistant on a
  call with you would.
- **Anyone else in the call.** It stays quiet unless you call it by name ("Prism,
  can you check the cluster?") — every time, including follow-ups. Everything else —
  two people working through a problem with each other — it sits through in silence,
  however much a sentence might have sounded like a request.

It switches over as people join and leave, within about ten seconds. You don't
have to ask for any of this, but you can override it per call:

> Join `https://meet.google.com/abc-defg-hij` and only speak when someone says your
> name

**Say its name every time, including follow-ups.** There's no grace period. An
earlier version stayed engaged for fifteen seconds after speaking, so a follow-up
didn't need the name — but in a real room those fifteen seconds are mostly people
starting to talk to *each other*, and it answered them. One rule that always holds
turned out to be better than a shortcut that sometimes interrupts.

**Its name is what gets its attention, but it isn't matched literally.** Live
transcription mangles names — "Prism" has come back as "Pritham" — so a check
decides whether you called it, allowing for a clear mishearing. The same check
knows the difference between talking *to* it and talking *about* it, so "I asked
Prism about that yesterday" doesn't summon it.

It answers to whatever it's called in its workspace, so renaming the agent renames
what you say to get its attention.

It deliberately does **not** try to work out whether a sentence sounds like a
request for an assistant. A call is a single mixed audio channel with no speaker
labels, so "can you add that to the list?" reads exactly the same whether it was
said to the agent or to the person next to you — and a bot guessing at that is a
bot that interrupts. The cost of the stricter rule is that the first thing you say
to it in a group call needs its name.

**English only, for now.** The call's audio is transcribed as English so the agent
can work out what was aimed at it. Speaking another language degrades that rather
than failing outright — it may miss things said to it, or answer something that
wasn't. It's told to say so and offer to continue in a chat session, which has no
such limit.

**You can interrupt it.** Start talking and it stops — humans have the floor. A
short "mm-hm" or a cough won't cut it off mid-sentence; a real interjection will,
and it picks up from what you actually heard rather than pretending it finished.

**It keeps its answers short.** One to three sentences, spoken, no markdown read
aloud. If the real answer is a command or a long list, it says what the thing does
and offers to walk through it out loud, or spells the part that matters slowly.

**It can only talk.** There is no way for it to send anything out of a call — not a
message, not a file, not a link, and not to the meeting's own chat panel. It is
instructed never to offer, so if you want something as text, ask it again in a chat
session afterwards. Nothing about the call is kept either: no transcript, no summary,
and no record in your conversation history beyond a note that it joined and left. Ask
it "what did we decide in the meeting?" afterwards and it won't know.

**It can't tell who is speaking.** The meeting audio arrives as one mixed channel
with no speaker labels, so it won't attribute anything to a specific person — and
it can't tell "ask the agent" from "ask the person next to you" except by what the
words say, which is why the rules above are what they are. It may also mishear a
name or a number, and is told to read important details back before acting on them.

## Tools, and what it won't do on a spoken request

The agent has its **full toolset** in a call — the same memory, shell, scheduling
and integration tools it has in chat, with nothing destructive withheld. It can check
a cluster, read a file, search its memory or kick off longer work and tell you the
answer without leaving the meeting. It's asked to say something like "let me check
that real quick" before each tool call, so a pause never sounds like it dropped off.

The one exception is **file sharing**. `share_file` is unavailable in a call: it only
stores a file and hands back a reference for the chat machinery to deliver, and a
meeting doesn't run that machinery — so it would store a file that reached nobody. If
the agent writes a file during a call, ask it for the file in chat afterwards, where
it can send it.

**A meeting is not an authenticated channel — and that matters here.** Anyone with
the link can speak, the agent cannot verify who anyone is, and `share_file` above is
the only tool withheld in code — nothing is held back for safety. The single guardrail
is an instruction in its prompt: announce what it's about to do and get an explicit
"yes" in the room before anything that deletes, deploys, spends money, grants access,
or changes its own configuration — and never read that permission out of enthusiasm
or out of someone claiming authority.

**That includes changing itself.** Renaming itself and rewriting its Soul, its user
profile or its memory are things it will do on a spoken request that the room agrees
to. It used to refuse those outright; it no longer does, because the refusal also
turned down its own user asking in a call. So a sentence agreed in an unauthenticated
meeting can change the agent for every future turn on every channel, not just for the
duration of the call.

Instructions are a strong default, not enforcement. So treat a meeting link as
handing over the agent's own authority — over itself included: **share it only with
people you'd trust with the agent's shell and its configuration.** Note that waiting
to be addressed narrows what it *responds* to, not what it can be asked to do —
anyone who says its name has its full toolset. For a real restriction, start the
agent with a narrower tool surface.

It also leaves on request — "you can drop off now" works, and it hangs up.

## Cost

Realtime audio is billed per audio token, in both directions, and a meeting bot
hears everything — a quiet hour still costs. Expect roughly **$0.10–0.30 per
minute** with the default `gpt-realtime-2.1`. Two levers:

- `OPENAI_REALTIME_MODEL=gpt-realtime-mini` is materially cheaper.
- In a call with several people, staying quiet unless addressed cuts the expensive
  half — spoken responses — down to the turns actually meant for the agent. That
  happens on its own; there is nothing to switch on.

Deciding who was addressed needs a transcript, so input transcription runs on every
call. It bills per audio minute at a small fraction of the Realtime audio rate for
the same minute, and it never feeds the model — the conversation itself stays pure
audio. Working out whether you called the agent by name is one short call to the
small classification model — a few tokens per sentence, and none at all in a
one-to-one call, where nothing needs deciding.

Every call is capped at `MEETING_TIMEOUT_MINUTES` (60 by default), so a meeting
nobody ended can't run up a bill overnight.

## Telling people

Tell the other participants that the agent is in the call and what it's for. It
introduces itself when admitted, but a bot listening to a conversation is something
people should know about and agree to — in many places recording or processing a
call without consent is also a legal question, not just an etiquette one.

Nothing is recorded: the call's audio goes to the Realtime model and is not stored by
the runtime, and no transcript or summary is written. Whether OpenAI retains anything
is between you and your OpenAI account settings.

## Settings

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENAI_API_KEY` | Enables voice meetings. May be a managed-credential sentinel. | — (disabled) |
| `OPENAI_REALTIME_MODEL` | Realtime model for the in-meeting voice. | `gpt-realtime-2.1` |
| `OPENAI_REALTIME_VOICE` | Voice name. | `marin` |
| `OPENAI_TRANSCRIPTION_MODEL` | Transcriber used to decide whether the agent was spoken to. Runs on every call, billed per minute; never fed to the model. | `gpt-realtime-whisper` |
| `MEETING_DISPLAY_NAME` | Name shown to participants on the guest path only. | the agent's name |
| `MEETING_TIMEOUT_MINUTES` | Hard cap on one call. | `60` |
| `MEETING_ADMISSION_TIMEOUT_SECONDS` | How long to wait in the waiting room, counted from when the join request goes in. | `300` |

Reaching the lobby has its own budget, so a slow-loading Meet page never eats into
the waiting-room time.

## When it doesn't work

**The agent says it can't join meetings, or doesn't offer to.** The tool is only
registered when the toolchain and the key are both present — check the startup log
for `Voice meetings available` or `Voice meetings unavailable`, and confirm
`OPENAI_API_KEY` is set and you're running the container image.

**It waits forever to be admitted.** Nobody clicked Admit, or the meeting blocks
anonymous guests. It gives up after `MEETING_ADMISSION_TIMEOUT_SECONDS` and says
so.

**It said the meeting had ended, but the link was live — and joining again
worked.** Meet shows one catch-all wall for an ended meeting, a dead link and a
guest it refuses, and the runtime used to believe that text the first time it saw
it, including while the page was still rendering. A rejection now has to survive
three reads 1.2 seconds apart before it counts, and being in the call outranks
anything written on the page. A message that didn't survive shows up in the log as
`A rejection message did not persist`.

**It says it couldn't sign in to its Google account.** Google is challenging the
bot account — usually a "verify it's you" prompt that needs a code. The runtime says
so plainly instead of reporting Meet's refusal, because Meet answers an automated
anonymous guest with the same wall as an ended meeting. Sign in once by hand with
the profile under `<DATA>/meeting-browser-profile`, or clear that directory and let
the next join log in fresh. A screenshot of any failed join lands at
`<DATA>/meeting-join-failure.png`.

**Diagnosing which step failed.** Each join logs the elapsed time for page load,
the join-button hunt and the admission wait, and a failed attempt tags its
`meeting ended` telemetry event with `fail_step` — one of `page_load`, `lobby`,
`join_button` or `admission`.

**It's in the call but silent, or nobody can hear it.** Almost always the audio
devices: check the runtime log for `parec`/`pacat` warnings. A container needs
enough `/dev/shm` for Chromium — the runtime already passes
`--disable-dev-shm-usage`, but a heavily constrained container can still starve it.

**It joined but hears nothing.** Confirm the other participants aren't muted, then
check that the meeting is actually sending audio to the browser (Meet occasionally
needs the tab focused; the virtual display keeps it focused by default).

**It left mid-call saying it lost its voice connection.** The Realtime socket dropped
— a network blip, a revoked key, or OpenAI ending the session. It leaves rather than
sitting in the room unable to hear or speak, and it doesn't reconnect, because a fresh
session would rejoin the conversation with none of its context. Ask it to join again.
Recurring drops are worth checking against egress filtering on `api.openai.com`.
