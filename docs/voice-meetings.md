# Voice meetings

Prism Agent can join a Google Meet call and take part by voice — it listens, speaks,
and uses its tools while the call is happening. Ask it in chat:

> Join `https://meet.google.com/abc-defg-hij`

It joins signed into its own Google account, a host admits it like any other
participant, and from then on it is in the room. Someone can ask it a question out
loud and it answers out loud; if the answer needs a lookup, it runs the tool and
reports back in the same breath. Ask it to leave, or say "join us" and forget about
it — it leaves on its own once everyone else has gone.

**Speaking is the only thing it can do during a call.** It cannot post to the
meeting's chat panel, to Slack or to your chat session, and nothing said in the call
is written down anywhere afterwards. Work it can't finish in the call is the
exception: it schedules that as a one-off task and the answer reaches your chat
afterwards. See [In the call](#in-the-call).

Google Meet is the only supported platform today. The runtime's meeting support is
platform-agnostic underneath, so Teams and Zoom can be added without touching the
audio or model path.

## What you need

Voice meetings need three things, and the agent's `join_meeting` tool only
appears when the first two are present:

1. **The container image.** It ships the browser and audio toolchain (Chromium,
   Xvfb, PulseAudio). A native install via the `prism` binary has no browser to
   drive, so the feature is container-only.
2. **`OPENAI_API_KEY`.** The voice model is OpenAI's Realtime API, connected
   directly to `api.openai.com` — it never rides the Lens Agents gateway, whose
   openai mount routes POST only. Your chat model is unaffected: on the Claude platforms
   only the in-meeting voice uses OpenAI, and with `LLM_PROVIDER=openai` chat
   shares this same key (see [Configuration](configuration.md#provider-selection)).
3. **A Google account for the agent** (`GOOGLE_BOT_EMAIL` / `GOOGLE_BOT_PASSWORD`).
   This one is not optional in practice — see below. Note the password has to be the
   **real password, in plain text**: the agent signs in by typing it into Google's
   form, so unlike other secrets it can't be a managed-credential placeholder that
   gets swapped in on the wire. Google Meet offers no bot or service-account API, so
   this is the price of being in a call at all — give the agent a dedicated account
   with nothing else attached to it, **one per agent**. Sharing an account between
   agents works, but each one then sees the other's name on its own tile and only
   one can be in a call at a time.

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

`AWS_BEARER_TOKEN_BEDROCK` and `OPENAI_API_KEY` are only ever sent as request
headers, so in a Lens sandbox they can be managed credentials that the platform
swaps at the network boundary — no real secret lands in the container.
`GOOGLE_BOT_PASSWORD` cannot: the browser types it into Google's own sign-in form
over TLS to Google, so the container has to hold the real value.

### Egress

If your deployment filters outbound traffic, a meeting needs these:

| Host | Why |
|------|-----|
| `api.openai.com:443` | The Realtime voice session. Goes direct — no managed-inference vendor serves this surface, so it is never proxied through a gateway |
| `meet.google.com:443` | The call itself |
| `accounts.google.com:443` | Signing the agent in |
| `myaccount.google.com:443` | Checking whether the profile is still signed in. Easy to miss, and blocking it makes every join run a full login |
| `www.gstatic.com:443`, `fonts.gstatic.com:443` | Where Google's sign-in page loads its scripts and fonts. Without them the login form may not render |
| `clients6.google.com:443`, `hangouts.clients6.google.com:443` | Meet's signaling backend |

**Audio needs more than an HTTPS allowlist.** Meet carries media over WebRTC, so a
CONNECT-based allowlist cannot carry it at any hostname — a proxy tunnels TCP.
Without it the agent is admitted to the call and then dropped, with Meet reporting
*"Couldn't start the video call because of a network error"*: a participant that
appears, stays mute, and leaves. Per
[Google's network requirements](https://knowledge.workspace.google.com/admin/meet/prepare-your-network-for-meet-meetings-and-live-streams),
allow **UDP 3478 and 19302–19309** to `74.125.250.0/24`, `74.125.247.128/32` and
`142.250.82.0/24` (plus the IPv6 equivalents). Where UDP cannot be opened, Meet
falls back to TCP 443 via the TURN relays `meet.turns.goog` and
`workspace.turns.goog` — those must be **tunnelled, not TLS-inspected**, and Google
warns that proxied media costs call quality.

`www.google.com` is **not** required, and is worth leaving blocked: it is Search and
an open redirector (`google.com/url?q=`), so allowing it hands a browser-driving
agent a general path to the web. A signed-out profile is bounced there by the
sign-in check, but the check does not need the page to load — the navigation simply
fails, the agent concludes it is not signed in, and it logs in normally.

Chromium also reaches for its own update, variations and optimization-guide
endpoints (`clients2.google.com`, `redirector.gvt1.com`, `play.google.com`,
`android.clients.google.com`, `content-autofill.googleapis.com`,
`optimizationguide-pa.googleapis.com`, `generativelanguage.googleapis.com` and
similar). **None of these are needed** — meetings work with them denied, and they
are worth recognising in an audit log so they don't read as the agent reaching for
something it shouldn't.

**If you use an HTTP proxy, exempt loopback.** The runtime drives Chromium over a
debugging port on `127.0.0.1`, and a proxy that intercepts that connection breaks
every join with a `socket hang up` roughly 30 seconds in — a message that blames the
browser rather than the proxy. The runtime adds `127.0.0.1`, `localhost` and `::1` to
`NO_PROXY` itself, so this should not bite; if you set `NO_PROXY` in your own
deployment, include the literal `127.0.0.1` rather than only `localhost`, since the
match is on the URL host and no name resolution happens.

**If the proxy intercepts TLS, the container hands Chromium the CA itself.** A Lens
sandbox terminates TLS at its boundary proxy and makes that trustworthy by appending
its CAs to the system bundle and pointing `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and
friends at it. Chromium ignores all of that, so `start.sh` writes the sandbox's CAs to
`/etc/chromium/policies/managed/prism-ca.json` (and the `/etc/opt/chrome` equivalent)
as a `CACertificates` policy on every start, because one of those CAs is generated
fresh inside the sandbox each time. Outside a sandbox nothing is written and nothing
changes.

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

So the runtime does not try. Ask it to join a Meet call with no account configured
and it says so immediately, rather than starting a browser and an audio stack to
sit in a lobby that will refuse it.

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
  join… a host needs to admit me". Ask the agent for its meeting status to find out
  whether it got in.
- **Some meetings won't let it in at all.** A tenant can restrict a meeting to
  members of its own organization. The agent gives up rather than retrying, and the
  reason Meet gave is in the runtime log.
- **A dead link looks like a guest prompt.** Meet offers a guest name field for a
  meeting that has ended, even to a signed-in visitor, and then refuses the join.
  If a join fails, check the meeting is still running with a host in it — that is
  by far the most common cause.
- **It joins with no camera.** It appears as a name and an avatar tile.

Participants see the Google account's own name — there is no setting for it. The
join tool takes an optional display name, but it only reaches platforms that admit
named guests, and Google Meet is not one of them.

The agent handles one call at a time. Asking it to join a second one while it's in
a meeting returns an error rather than dropping the first.

## In the call

**It reads the room before it speaks.** The audio it hears is the whole room, and the
words alone never say who they were aimed at — it is one mixed channel with no speaker
labels. So how much it speaks up depends on how many people are in the call:

- **Just you and the agent.** It answers everything you say, as an assistant on a
  call with you would.
- **Anyone else in the call.** It stays quiet until you bring it in by name
  ("Prism, can you check the cluster?"), and then stays with the exchange — a
  follow-up like "did you find anything?" doesn't need the name again. Everything
  else — two people working through a problem with each other — it sits through in
  silence, however much a sentence might have sounded like a request.

It switches over as people join and leave, within about ten seconds. You don't
have to ask for any of this, but you can override it per call:

> Join `https://meet.google.com/abc-defg-hij` and only speak when someone says your
> name

**Name it to start, not to continue.** Once it's part of an exchange, follow-ups
reach it without the name — "did you find anything?", "try the other cluster", "no,
the staging one". What decides that is what the exchange looks like, not a stopwatch:
an earlier version stayed engaged for fifteen seconds after speaking, and in a real
room those fifteen seconds are mostly people starting to talk to *each other*, so it
answered them. Being able to see the conversation is what makes the difference — it
can tell "did you find anything?" asked of it from the same words asked of somebody
else.

**Its name is what gets its attention, but it isn't matched literally.** It listens
to what you actually said — the audio, not a transcript of it — and decides whether
you were talking to it. That allows for a name said quickly or half-swallowed, and
it knows the difference between talking *to* it and talking *about* it, so "I asked
Prism about that yesterday" doesn't summon it. It also knows a request aimed at
somebody else, so "Emma, could you ask Prism about the cluster?" is Emma's to
answer, not the agent's.

It answers to whatever it's called in its workspace, so renaming the agent renames
what you say to get its attention.

<a id="names"></a>
**Where you put the name doesn't matter.** "Prism, can you check the deploy?" and
"can you check the deploy, Prism?" both get a reply as soon as you stop talking, and
so does a name in the middle of a sentence. It hears how the sentence was said, so a
name that a transcript would have mangled is not a name it misses.

It deliberately does **not** try to work out whether a sentence merely sounds like a
request for an assistant. A call is a single mixed audio channel with no speaker
labels, so "can you add that to the list?" is the same whether it was said to the
agent or to the person next to you — and a bot guessing at that is a bot that
interrupts. The cost of that is the one rule you have to remember: bring it in by
name the first time.

**If it can't tell, it says nothing.** Working out whether it was addressed is one
question put to the model on every utterance, and when that question can't be
answered — a network problem, an overloaded model — it stays quiet rather than
guessing. So a call where it answers nothing at all, even to its name, is a
different problem from one where it ignores a single sentence. `gate_failed` in the
`meeting ended` event counts it.

**English only, for now.** It is told to say so and to offer to continue in a chat
session, which has no such limit.

**You can interrupt it.** Start talking and it stops — humans have the floor. A
short "mm-hm" or a cough won't cut it off mid-sentence; a real interjection will,
and it picks up from what you actually heard rather than pretending it finished.

**It keeps its answers short.** One to three sentences, spoken, no markdown read
aloud. If the real answer is a command or a long list, it says what the thing does
and offers to walk through it out loud, or spells the part that matters slowly.

**It talks, and it can put one line in the call's chat.** Speech is how it answers. For
the things speech mangles — a link, an identifier, a command to paste — it can post one
short plain-text message into the meeting's own chat panel instead. That is a hand-over,
not a second conversation: nothing reads the chat back to it, so a question typed there
never reaches it, and it is told never to post an answer it should be speaking. Nothing
else leaves a call — no message anywhere else and no file — and it is instructed never to
offer. If you want more than that one line as text, ask it again in a chat session. The
call itself is not kept: no transcript, no summary, not the messages it posts in the chat,
and no record in your conversation history at all. Ask it "what did we decide in the
meeting?" afterwards and it won't know. Its own log says no more than that by default —
see [Settings](#settings) if you need to turn the words on to diagnose something. The one
thing that outlives a call is work you asked for and it could not finish in the call: it
schedules that, and the result appears in your chat — see
[Tools](#tools-and-what-it-wont-do-on-a-spoken-request).

**It can't hear who is speaking, but it can look.** The meeting audio arrives as one
mixed channel with no speaker labels, so nothing in what the agent hears says who said
it — which is why it can't tell "ask the agent" from "ask the person next to you" except
by the words, and why the rules above are what they are. It may also mishear a name or a
number, and is told to read important details back before acting on them.

**It can tell you who it is answering.** The agent can find out who last spoke and who
else is in the call, so it can answer you by name. It says so plainly when it can't tell,
and is told never to guess one: during a pause, when two people talk over each other, or
when several of you are in the same room sharing one microphone. In that last case the
meeting mixes you into a single stream, so the agent knows the group spoke but not which
of you did, and will say as much rather than pick one of your names.

None of these names are written to the log.

## Tools, and what it won't do on a spoken request

The agent has its **full toolset** in a call — the same memory, shell, scheduling
and integration tools it has in chat, with nothing destructive withheld. It can check
a cluster, read a file, search its memory or kick off longer work and tell you the
answer without leaving the meeting. It's asked to say something like "let me check
that real quick" before each tool call, so a pause never sounds like it dropped off.

If you ask for something the call has no time for — a question that needs digging or a
change that needs writing — it schedules a **one-off task** rather than leaving the
work unfinished, picks a time, and says out loud what it set up and when it runs. The
result appears in your chat with the agent after the call, not in the room and not in
the meeting's chat panel. It says it as something arranged, never as something already
done. See [Scheduled tasks](scheduled-tasks.md).

A tool result in a call is capped at **12,000 characters**, lower than chat's 30,000,
because everything a tool returns stays in the call's live session and the agent has
to speak its answer. Past that it sees the start and the end of the output with a
notice that the middle is missing, and it will say the listing was cut rather than
quote a count it can't stand behind. See [Large tool outputs](tools.md#large-tool-outputs).

The omitted middle is saved to a file and the agent can read it with the shell
during the call — so asking "what did it say about the database?" about a result
that was cut still works. It is told to pull only what it needs rather than read the
file back whole, and the reason is sharper in a call than in chat: everything it
reads stays in the session's context for the rest of the meeting, and that context is
both small and re-billed on every reply.

A call adds one tool it has nowhere else: posting a short message into the meeting's own
chat. It is meant for the thing speech gets wrong — a link, a cluster name, a command to
paste — and the agent is told to say everything else out loud. A message is limited to
**500 characters**, on one line, as plain text with no formatting. That limit is ours: Google
Meet takes a longer message, and cuts anything over its own limit off without saying so. If a
send comes back refused, the agent is told to say the content out loud instead of trying again. The message
is typed into the call's chat panel and nowhere else, so it is not stored in your
conversation history and does not survive the call.

The one tool a call takes away is **file sharing**. `share_file` is unavailable in a call: it only
stores a file and hands back a reference for the chat machinery to deliver, and a
meeting doesn't run that machinery — so it would store a file that reached nobody. If
the agent writes a file during a call, ask it for the file in chat afterwards, where
it can send it.

That exclusion is about *delivering* something to the room, which a call cannot do —
it is not a rule that the agent may only look at what it has already been shown.
Reading a saved tool output off disk is the second kind, so it works in a call: the
answer comes back to the agent, which then speaks it.

**A meeting is not an authenticated channel — and that matters here.** Anyone with
the link can speak, the agent cannot verify who anyone is, and `share_file` above is
the only tool withheld in code — nothing is held back for safety. The single guardrail
is an instruction in its prompt: announce what it's about to do and get an explicit
"yes" in the room before anything that deletes, deploys, spends money, grants access,
or changes its own configuration — and never read that permission out of enthusiasm
or out of someone claiming authority.

**That includes changing itself.** Renaming itself, rewriting any of its workspace
files (Soul, user profile, memory, vision, heartbeat config, bootstrap
notes) and changing its settings are things it will do on a spoken request that the
room agrees to, subject to the same confirmation. So a sentence agreed in an
unauthenticated meeting can change the agent for every future turn on every channel,
not just for the duration of the call.

Instructions are a strong default, not enforcement. So treat a meeting link as
handing over the agent's own authority — over itself included: **share it only with
people you'd trust with the agent's shell and its configuration.** Note that waiting
to be addressed narrows what it *responds* to, not what it can be asked to do —
anyone who says its name has its full toolset. For a real restriction, start the
agent with a narrower tool surface.

It also leaves on request — "you can drop off now" works, and it hangs up.

### Reasoning effort

How hard the model thinks before it answers or reaches for a tool is a setting:
`OPENAI_REALTIME_REASONING_EFFORT`, one of `minimal`, `low`, `medium`, `high`,
`xhigh`.

The API's own default is `low`. That is the right level for the voice agents the
surface was built for — take an order, read out a status — and the wrong one here:
this model has shell access, kubectl, the agent's integrations and the agent's own
configuration, and picking the wrong tool with it is a command that runs, not a
clumsy sentence. So the default is `high`.

It is a trade, and the currency is silence. A higher level means a longer pause
before the agent starts speaking, and a room full of people notices that pause. If
the agent starts to feel slow to answer, step down to `medium` — the runtime logs
what each answer cost under `[Meeting:Latency]`, with the effort in force on the
same line, so two calls at different levels can be compared directly. Setting the
variable empty sends no level at all and takes whatever the API defaults to.

## Cost

Realtime audio is billed per audio token, in both directions, and a meeting bot
hears everything — a quiet hour still costs. Expect roughly **$0.10–0.30 per
minute** with the default `gpt-realtime-2.1`. Two levers:

- `OPENAI_REALTIME_MODEL=gpt-realtime-mini` is materially cheaper.
- `OPENAI_REALTIME_REASONING_EFFORT` moves the bill too: thinking is output tokens,
  so a lower level spends less per answer as well as answering sooner. See
  [Reasoning effort](#reasoning-effort) for what it costs in accuracy.
- In a call with several people, staying quiet unless addressed cuts the expensive
  half — spoken responses — down to the turns actually meant for the agent. That
  happens on its own; there is nothing to switch on.

Working out whether you were talking to the agent is one short question per
utterance, asked of the same model that is already listening. It answers in a single
word, and it looks back over the last few turns of the call rather than the whole
thing, so what it costs does not grow as the meeting goes on. None at all in a
one-to-one call, where nothing needs deciding.

Input transcription costs nothing unless you ask for it. Nothing depends on it — it
exists so a call can be read back in the log — so it is only requested when
`MEETING_TRANSCRIPT_LOGGING=full`. Turn that on and it bills per audio minute, at a
small fraction of the Realtime audio rate for the same minute. The conversation
itself stays pure audio either way.

**A call cannot run past an hour.** OpenAI's Realtime sessions end at 60 minutes,
which is not configurable and applies regardless of `MEETING_TIMEOUT_MINUTES`. When
it happens the agent drops out of the call rather than winding down — ask it to
rejoin if the meeting is still going.

Every call is capped at `MEETING_TIMEOUT_MINUTES` (60 by default), so a meeting
nobody ended can't run up a bill overnight.

## Telling people

Tell the other participants that the agent is in the call and what it's for. It
introduces itself when admitted, but a bot listening to a conversation is something
people should know about and agree to — in many places recording or processing a
call without consent is also a legal question, not just an etiquette one.

Nothing is recorded: the call's audio goes to the Realtime model and is not stored by
the runtime, and no transcript or summary is written. Whether OpenAI retains anything
is between you and your OpenAI account settings. The exception is a task the agent
schedules during the call: its name and its instruction are written from what was
asked, and stay until the task runs.

That includes the runtime's own log, which by default carries no word anyone said and
no attendee's name — it records that an utterance was judged, not what it was. The one
way to change that is `MEETING_TRANSCRIPT_LOGGING`, below; if you turn it up, the
people in the room are being written down in a place that outlives the call, and that
is the same thing to tell them about as the agent's presence.

## Settings

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENAI_API_KEY` | Enables voice meetings. May be a managed-credential sentinel. Shared with the chat provider when `LLM_PROVIDER=openai`. | — (disabled) |
| `OPENAI_REALTIME_MODEL` | Realtime model for the in-meeting voice. | `gpt-realtime-2.1` |
| `OPENAI_REALTIME_VOICE` | Voice name. | `marin` |
| `OPENAI_REALTIME_REASONING_EFFORT` | How hard the model thinks before answering or picking a tool: `minimal`, `low`, `medium`, `high`, `xhigh`. Defaults higher than the API's own `low` — see [Reasoning effort](#reasoning-effort). Empty takes the API default. | `high` |
| `OPENAI_TRANSCRIPTION_MODEL` | Transcriber used only so a call can be read back in the log — never fed to the model, and nothing waits on it. Only requested when `MEETING_TRANSCRIPT_LOGGING=full`, since it bills per audio minute and by default the words are dropped. The default accepts name hints, which is what keeps names legible in the log — see [Names](#names). | `gpt-live-transcribe` |
| `OPENAI_NOISE_REDUCTION` | Server-side noise reduction over the meeting audio before turn detection and transcription see it: `off`, `near_field`, `far_field`. Off by default on purpose — what arrives is Meet's already-cleaned mix, and reducing it again cost a live agent most of what a quieter person in the room said. | `off` |
| `MEETING_TRANSCRIPT_LOGGING` | Whether what was said may appear in the runtime's log: `off` or `full`. See [What ends up in the log](#what-ends-up-in-the-log). | `off` |
| `MEETING_TIMEOUT_MINUTES` | Hard cap on one call. | `60` |
| `MEETING_ADMISSION_TIMEOUT_SECONDS` | How long to wait in the waiting room, counted from when the join request goes in. | `300` |

Reaching the lobby has its own budget, so a slow-loading Meet page never eats into
the waiting-room time.

### What ends up in the log

Every utterance the agent judges produces one line in the runtime's log, and
`MEETING_TRANSCRIPT_LOGGING` decides whether the utterance itself goes on it.

| Value | What a line carries |
|-------|---------------------|
| `off` (default) | The verdict, which utterance it belongs to, how long it took, and **how many** people were in the room. No words, no attendee names. |
| `full` | The above, plus the room's roster and anything the model said beyond the verdict, and a second line per utterance carrying what was said. |

Under `full` the words arrive on a line of their own rather than beside the verdict.
Transcription finishes after the decision has already been made, so the two cannot
share a line; they carry the same utterance id, which is what pairs them.

`off` is the default because a call is not an authenticated surface: whoever is in
the room did not agree to be written into a log that outlives it, and a mishearing
("Prism" → "Pritham") means the words recorded are not even reliably theirs. Most
diagnosis doesn't need them — `off` still separates "it decided no" from "it never
got an answer", and gives you the time each decision took.

It is a setting of its own rather than a log level on purpose. Raising the log level
is something you do to chase an unrelated problem, and it should never be the thing
that starts recording a meeting. It also means `full` gives you the sentences without
the rest of the runtime's debug output.

Turn it on only for as long as you need it, and tell the room. Nothing here reaches
product telemetry either way — that surface gets counts.

**A message the agent posts in the chat is never written to the log.** There is no setting
for it. Every send still writes one line, and that line carries whether the message went
out, how long it was, how long it took, and — when it failed — the step the send stopped
at. The text itself appears nowhere, at any log level, and in no telemetry property.

A send that failed or was refused writes its line as a warning, because it is silence in
the room with no other symptom: Meet publishes no chat API, so this runs by driving the
chat panel the way a person would, and a send that quietly did nothing is the failure
worth catching. The same line covers a message the agent refused to send: too long, or
sent while it wasn't in a call.

### The microphone

Google Meet mutes a new joiner automatically once a call is past a handful of people.
The agent unmutes itself on the way in — the same click you would make — and then
checks two things: that Meet's own microphone control reads live, and that the browser
really opened the virtual capture device.

If it cannot confirm both, **it stays in the call.** The runtime log records which half
failed, the agent itself is told it may be inaudible, and it keeps trying to unmute
itself, once every ten seconds, for as long as the call lasts. When that works it
introduces itself to the room then — a greeting nobody could hear was never a greeting.

It stays rather than leaving because the microphone is only half of what it is doing
there. It hears the room through a different device entirely, so an agent that cannot
be heard is still following the meeting, still being asked things, and still able to
act on them; the reply just doesn't arrive by voice. Leaving would throw that away to
avoid one of its failure modes. Nor would leaving be safe on this evidence: both checks
read things that can break on their own — a Google UI change, a quirk in the container's
audio — and treating either as proof would turn a cosmetic change into an agent that
refuses every meeting.

While it cannot confirm it is audible, the agent answers only when somebody says its
name, even in a one-to-one call where it would normally answer everything. Answering
every sentence into a void costs exactly what answering it aloud costs.

The one case it will not join at all is a meeting where Meet offers *only* to let it in
without a microphone — see below.

### The screen — not yet exposed to the agent (developer notes)

**The agent cannot share its screen.** No tool asks it to, and no setting turns one on.
Ask it to present and it will not be able to. The rest of this section is a note for
whoever adds that tool, not something you can do today.

Its browser *can* share. Meet's **Share screen** control resolves in it, and what it
shares is the virtual display the browser runs on — so the room would see the agent's
own browser windows. Driving that needs the browser's debugging port, which stays
inside the container.

Two details a share tool will have to handle. The shared display holds the Meet window
itself, so Meet warns about the self-view and offers **Show my screen anyway**; that
button keeps the presentation up, and the warning can return later in a call. And the
capture is the whole screen rather than one window, so whatever the agent means to show
has to be the window on top.

## When it doesn't work

**The agent says it can't join meetings, or doesn't offer to.** The tool is only
registered when the toolchain and the key are both present — check the startup log
for `Voice meetings available` or `Voice meetings unavailable`, and confirm
`OPENAI_API_KEY` is set and you're running the container image.

**It isn't answering to its name.** In a call with more than one other person the
agent answers only when it is spoken to. Each decision is logged — look for
`[Meeting:Gate]`. The line says what was decided, for which utterance, and how long
it took; by default it does not say what was decided *on*, which is enough to
separate three different problems and not enough to say why. A decision that says
no is one thing; a line reporting no verdict at all is another, and means the
question could not be answered rather than that the answer was no; no line at all
means the utterance never closed. `gate_failed` in the `meeting ended` event counts
the middle case across the whole call. To read the sentence itself you need
`MEETING_TRANSCRIPT_LOGGING=full` — with the room's agreement, and turn it back off
afterwards.

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
`join_button`, `admission` or `microphone`. A successful join carries
`muted_on_entry` (whether Meet had muted the agent) and `mic_confirmed` (whether the
room can hear it) on `meeting joined`.

**It says it's in the call but couldn't confirm its microphone.** It is still in the
meeting, still listening, and still retrying the unmute every ten seconds — so the
first thing to do is wait a few seconds and see whether it reports itself working. If
it doesn't, the log names which half failed: `Microphone is still muted after every
attempt` (Meet's control never flipped — usually a dialog covering the call controls,
or a Meet UI change that has broken the selector) or `bot_mic is still not being
captured` (the browser never opened the device, so look for `parec`/`pacat` warnings
and check `/dev/shm`).

Watch `mic_confirmed` on the `meeting joined` event if you run more than one of these.
The whole bug behind this behavior was a silent agent nobody measured, and a fleet
where that property turns false everywhere is the same outage wearing a different hat —
a rotted selector, degrading quietly into meetings the agent attends but cannot speak
in.

**It says Meet only offered to let it in without a microphone.** Meet paints that
offer when it can't find a capture device for the tab at all, and the panel carrying
it covers the join button — so this used to surface as "the join button never became
available", which pointed at the wrong thing entirely. Fix the container's audio
devices (the same `parec`/`pacat` and `/dev/shm` checks as above); no browser-side
setting will help.

**It's in the call but silent, and said nothing about its microphone.** Then both
checks passed and the fault is further down: the audio devices are the usual cause, so
check the runtime log for `parec`/`pacat` warnings. A container needs enough `/dev/shm`
for Chromium — the runtime already passes `--disable-dev-shm-usage`, but a heavily
constrained container can still starve it. Note that the agent no longer accepts Meet's
"Continue without microphone" offer: taking it joined the call with no capture device
at all, which nothing later could undo.

**It joined but hears nothing.** Confirm the other participants aren't muted, then
check that the meeting is actually sending audio to the browser (Meet occasionally
needs the tab focused; the virtual display keeps it focused by default).

**It left mid-call and the log says it lost its voice connection.** The Realtime socket
dropped — a network blip, a revoked key, or OpenAI ending the session. It leaves rather than
sitting in the room unable to hear or speak, and it doesn't reconnect, because a fresh
session would rejoin the conversation with none of its context. Ask it to join again.
Recurring drops are worth checking against egress filtering on `api.openai.com`.
