# Terminal-Bench 2.1 adapter

Runs Prism as a custom agent under [Harbor](https://github.com/laude-institute/harbor),
the official harness for [Terminal-Bench 2.1](https://www.tbench.ai/docs/run-terminal-bench-2-1).

| File | Role |
|------|------|
| `prism_agent.py` | The Harbor `BaseInstalledAgent` — installs Prism per sandbox, runs one turn, reports usage |
| `install-prism.sh` | In-sandbox installer: downloads a published release, unpacks it, registers no service |
| `run-prism.sh` | In-sandbox driver: start server → wait for health → one chat turn → shut down |
| `test_prism_agent.py` | Tests for the adapter's pure helpers |

## Prerequisites

```bash
uv tool install harbor          # requires Docker running
```

## Run

```bash
export AWS_BEARER_TOKEN_BEDROCK=<key>

harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path "prism_agent:PrismAgent" \
  -m anthropic.claude-opus-4-8 \
  --ak provider=bedrock-mantle \
  --ak reasoning_effort=high \
  --ae 'AWS_BEARER_TOKEN_BEDROCK=${AWS_BEARER_TOKEN_BEDROCK}' \
  --ae 'AWS_REGION=us-east-1' \
  -k 5
```

Harbor imports the adapter by module path, so run from this directory or put it
on `PYTHONPATH`. `-k 5` matches the official parameters (89 tasks × 5 trials).

## Smoke test

A full sweep is 445 trials, so validate in two cheap steps first.

**1. Is the harness itself working?** The built-in `oracle` agent runs each
task's reference solution, so anything failing here is Docker or Harbor, not
Prism. `-l 5` limits the run to 5 tasks.

```bash
harbor run -d terminal-bench/terminal-bench-2-1 -a oracle -l 5
```

Expect all 5 to pass. Harbor writes results to `jobs/<timestamp>/` in the working
directory (git-ignored here); per-task rewards are in
`jobs/<timestamp>/result.json` under `reward_stats`.

**The host must be amd64.** Terminal-Bench task images are amd64-only, and under
Docker's QEMU emulation on an arm64 host (Apple Silicon) the verifiers segfault:

```text
qemu: uncaught target signal 11 (Segmentation fault) - core dumped
```

That surfaces as a *task failure*, not an infrastructure error — an oracle run on
this machine scored 1/4, with a QEMU segfault in the verifier log of every failing
task and none in the passing one. Any adapter numbers collected that way are
meaningless. Run on an amd64 Linux host, or offload the sandboxes:

```bash
export DAYTONA_API_KEY=<key>
harbor run -d terminal-bench/terminal-bench-2-1 -a oracle -l 5 --env daytona
```

Run the oracle check first on whatever host you choose, and only continue when it
passes clean.

**2. Is the adapter working?** Same 5 tasks through Prism, one trial each:

```bash
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path "prism_agent:PrismAgent" \
  -m anthropic.claude-opus-4-8 --ak provider=bedrock-mantle --ak reasoning_effort=high \
  --ae 'AWS_BEARER_TOKEN_BEDROCK=${AWS_BEARER_TOKEN_BEDROCK}' \
  -l 5 -k 1
```

Pass rate is not the point here — installing, booting, dispatching the turn, and
recording usage are. Check `/logs/agent/prism-server.log` in a trial's artifacts
if a trial produced no response.

## Agent kwargs (`--ak`)

| Kwarg | Default | Meaning |
|-------|---------|---------|
| `provider` | `bedrock-mantle` | `bedrock-mantle`, `bedrock`, or `azure`. Selects which model env var carries `-m`. |
| `reasoning_effort` | `high` | `low`…`max`. Reaches the model on `bedrock-mantle`/`azure` only — see below. |
| `thinking` | `adaptive` | `adaptive` or `disabled`. Sent explicitly because Opus 4.8/4.7 do no thinking without it — see below. |
| `disabled_tools` | `claude_code,claude_code_status` | Comma-separated tool names withheld. Pass `--ak disabled_tools=` to withhold nothing. |
| `release_tag` | `latest` | Release to install, e.g. `v2026.8.10130628`. Pin it so a sweep cannot straddle two builds. |
| `turn_timeout` | `5400` | Seconds allowed for the single chat turn. |
| `boot_timeout` | `120` | Seconds allowed for the runtime to answer `/health`. |

Credentials go through `--ae`, never `--ak`: the adapter never handles them, it
only relies on Harbor putting them in the sandbox env.

The model defaults to `anthropic.claude-opus-4-8` (bare — Mantle serves no
cross-region inference profiles) when `-m` is omitted.

## Three settings that decide whether the number means anything

**`claude_code` is disabled by default, on purpose.** Prism ships a
`claude_code` tool that dispatches Claude Code as a sub-agent. Left enabled, a
trial can hand the entire task to that nested agent, and the resulting score
measures Claude Code rather than Prism's own loop. The adapter therefore passes
`PRISM_DISABLED_TOOLS=claude_code,claude_code_status`. Removing the binary would
not work — the tool would still be advertised and the model would waste steps
calling it — so the gate is in the runtime.

**Thinking is sent explicitly, because omitting it is not neutral.** Opus 4.8 and
Opus 4.7 do **no** thinking unless `adaptive` is sent — unlike Fable 5 (always
thinks) or Opus 5 (thinks by default). Prism does not send the field on its own,
so on the Opus 4.8 default this adapter would otherwise benchmark a non-thinking
model against an agentic suite. Hence `thinking=adaptive`.

**Effort and thinking only reach the model on the Anthropic Messages surface.**
Prism sends both under `providerOptions.anthropic`. The `bedrock-mantle` and
`azure` vendors build their model with `createAnthropic`, so they apply. Native
`bedrock` goes through Converse, whose provider id is `bedrock`, so both are
ignored — silently, with no error. Use `provider=bedrock-mantle` when either
matters. That is why it is the default here.

## Why the runtime runs inside the sandbox

Prism is a server, not a one-shot CLI, and its shell tools (`shell_exec`,
`shell_write_file`, …) spawn children of `prism-server` rather than going through
Harbor's `environment.exec`. A server on the runner would edit the runner's
filesystem while the grader inspects the container's. So `run-prism.sh` starts
the runtime in the task sandbox and derives `SHELL_WORKSPACE_ROOT` from the
working directory Harbor execs it in, which is the tree the instruction refers
to.

`install-prism.sh` exists rather than reusing the repo-root `install.sh` because
that one registers the runtime with launchd/systemd. A task container has
neither, so `systemctl --user` fails and `set -e` takes the install down with it.

## Per-trial isolation

Each trial gets a fresh `AGENT_ID`, so the runtime bootstraps a new agent — new
thread, empty memory — for an id its database has never seen. Nothing carries
across the 89 tasks.

`PRISM_DISABLE_AUTONOMY=true` covers the rest: no heartbeat timer, no cron
registration, no goal resumption, no session resets, no background sweeps. A
trial is therefore exactly the one turn Harbor dispatched, which is the point —
an autonomous turn editing the task tree while the grader inspects it would make
the result unattributable. The adapter also keeps the SQLite file outside the
task tree so a "no unexpected files" check cannot trip on it, and clears
`OTEL_EXPORTER_OTLP_ENDPOINT` so a sweep does not ship 445 trials of telemetry to
the production collector.

## Known limitation

`STEP_LIMIT` is 100 (`src/constants.ts`). At 100 steps the runtime stops calling
tools and asks the model to summarize instead, so a task needing more than 100
tool-use steps ends with a summary rather than finished work. It is a compile-time
constant, not an env var — raise it on this branch if trials are hitting it, and
check the step counts the adapter records in `n_steps` to find out whether they
are.

## Tests

```bash
python -m pytest benchmark/
```

Covers the pure helpers only — model-id normalization, request-body escaping,
and response parsing. The install and run path needs a real `harbor run`; use the
one-task smoke test above.
