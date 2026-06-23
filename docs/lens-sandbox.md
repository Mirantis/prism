# Run with Lens Sandbox

[Lens Sandbox](https://github.com/lensapp/lens-sandbox) runs the same published
Prism image inside a local microVM, with every inbound and outbound connection
checked against a policy you control. It's a good fit when you want the agent to
act over a shell but want a hard boundary around what it can reach on the
network.

## Install the `lns` CLI

```bash
curl -fsSL https://get.lns.run | bash   # macOS on Apple Silicon
```

## Run Prism in the sandbox

```bash
lns run --cpus 2 --mem 2048 \
  -p 3003:3003 -v prism-data:/data \
  ghcr.io/lensapp/prism-agent:latest \
  -- /bin/sh -c './start.sh > /dev/null 2>&1 & exec prism'
```

The flags mirror the [Docker](docker.md) command:

- `--cpus` / `--mem` size the microVM.
- `-p 3003:3003` exposes the runtime (Web UI, WebSocket, Slack) on your host.
- `-v prism-data:/data` persists the agent's SQLite database in a named volume
  (list them with `lns volume ls`).
- The run attaches to your terminal interactively, booting straight into the
  `prism` TUI while the runtime starts in the background.

## Credentials and policy

A couple of things work differently from a plain Docker run:

- **Credentials come from the network boundary.** The sandbox supplies the
  Bedrock credential at the edge, so you don't pass `AWS_BEARER_TOKEN_BEDROCK`
  into the run.
- **Outbound access is policy-gated.** Start the run from a project directory,
  where `lns` keeps the policy that governs the run. The first time the agent
  reaches out over the network, the service raises an approval prompt for that
  connection; answering "always" remembers it so future runs proceed without
  asking.

Because the agent can run shell commands, spawn processes, and call out to tools
like `kubectl` and `gh`, the policy boundary is doing real work here: nothing
the agent does can open a network connection you haven't approved. See the
[Lens Sandbox docs](https://github.com/lensapp/lens-sandbox) for the full policy
and approval model.

## After it's running

Everything else behaves like any other Prism deployment — open the
**[Web UI](web-ui.md)** at <http://localhost:3003>, chat in the
**[Terminal UI](terminal-ui.md)**, and configure
**[Slack](slack.md)**, **[heartbeat](heartbeat.md)**, and
**[scheduled tasks](scheduled-tasks.md)** as usual.
