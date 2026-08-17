# Microsoft Teams

Prism can run in Microsoft Teams — responding to personal chats and channel
@mentions, holding threaded conversations, and delivering heartbeat and
scheduled-task output. Unlike Slack (which uses Socket Mode), **Teams requires
an inbound HTTPS endpoint**: Microsoft's Bot Service delivers each message as
an HTTPS POST to a public URL you register on an Azure Bot resource.

Teams is optional. The runtime starts fine without it; add it when you want it.

## Setting up the Teams app

### Runtime credentials

| Variable | Value |
|----------|-------|
| `TEAMS_APP_ID` | The Entra app registration's Application (client) ID. |
| `TEAMS_APP_PASSWORD` | The app registration's client secret. Must be the **real secret value**. |
| `TEAMS_APP_TENANT_ID` | The Entra tenant the app is registered in. |

All three required variables must be set for the adapter to start; otherwise it
stays idle. See **[Configuration](configuration.md)**.

### The public messaging endpoint

The runtime serves the bot endpoint at:

```
POST /agents/teams/messages
```

Microsoft must be able to reach it over public HTTPS with a valid certificate —
`localhost` will not work.

**Expose only this one path — never the whole port.** The runtime's other
routes (the `/agents/*` management API, the web UI, the WebSocket) carry no
authentication of their own; in production a platform in front of the container
terminates auth for them. Whatever makes the messaging endpoint public (a
reverse proxy, ingress, or tunnel) must forward **exclusively**
`POST /agents/teams/messages` to the runtime's port (`3003`) and answer
everything else itself. Publishing the bare port would put unauthenticated
management operations on the internet.

Every inbound request on this path is authenticated in the runtime: the Teams
SDK validates the Bot Framework JWT (issued by Microsoft Entra) before the
agent sees the activity — which is what makes exposing this single path safe
without extra auth at the proxy.

For local development, put a path-restricting proxy in front and tunnel the
**proxy's** port, not the runtime's. For example with
[Caddy](https://caddyserver.com/) and a
[dev tunnel](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/):

```bash
# Caddyfile — forward only the bot endpoint; answer everything else with 404.
cat > Caddyfile <<'EOF'
:3979 {
    @teams {
        method POST
        path /agents/teams/messages
    }
    handle @teams {
        reverse_proxy 127.0.0.1:3003
    }
    handle {
        respond 404
    }
}
EOF
caddy run --config Caddyfile &

devtunnel host -p 3979 --allow-anonymous
```

### Azure setup checklist

1. **Entra app registration** — Microsoft Entra ID → App registrations → New.
   Record the Application (client) ID and the tenant ID, then create a client
   secret under *Certificates & secrets* (copy the value immediately).
2. **Azure Bot resource** — create an **Azure Bot**, choose type
   **Single Tenant**, and select *Use existing app registration* with your
   Application ID.
3. **Messaging endpoint** — in the bot's *Configuration*, set the messaging
   endpoint to `https://<your-host>/agents/teams/messages`.
4. **Teams channel** — in the bot's *Channels*, enable **Microsoft Teams**.
5. **Teams app package** — create a Teams app manifest that points at the bot
   (scopes `personal` and `team`, `"supportsFiles": true` so people can send
   it files in a personal chat, `"supportsChannelFeatures": "tier1"`) and
   give it the `ChannelMessage.Read.Group` permission, so the agent can follow
   up in a channel thread without an @mention. Without the permission the
   agent answers @mentions only. The manifest needs these entries:

   ```json
   "webApplicationInfo": { "id": "<TEAMS_APP_ID>", "resource": "https://prism" },
   "authorization": {
     "permissions": {
       "resourceSpecific": [{ "name": "ChannelMessage.Read.Group", "type": "Application" }]
     }
   }
   ```

   Upload the package to your tenant, either through the
   [Teams Developer Portal](https://dev.teams.microsoft.com/) or with the
   Teams CLI:

   ```bash
   npm install -g @microsoft/teams.cli
   teams login
   teams app create --name my-agent \
     --endpoint https://<your-host>/agents/teams/messages
   ```

   Your tenant must allow custom app upload (sideloading).
6. Copy the three credentials into the runtime's environment (the `.env` file
   for a native install, `-e` flags for Docker) and restart.
7. **Optional: files shared in channels.** A file shared in a channel is stored
   in the team's SharePoint. To let the agent read it, a Microsoft 365 admin
   adds the Microsoft Graph **application** permission `Files.Read.All` to the
   app registration (*API permissions*) and grants admin consent. Without it,
   the agent tells you it could not read the file.

## Linking your identity

Before the agent will talk to you, it needs to know who you are. Linking is
started from the **[Web UI → Channels](web-ui.md#channels)** page, which issues
a short-lived six-character code.

### Personal Mode — chat with the agent

1. In the Web UI, open **Channels** and click **Link Account** under the
   Microsoft Teams section's Personal Mode. You get a six-character code
   (e.g. `A1B2C3`), valid for about 15 minutes.
2. Open a personal chat with the agent in Teams and send it the code.
3. The agent confirms the link. From then on you can chat with it there.

If an unrecognized person messages the agent, it replies with a short prompt
explaining how to link, rather than answering.

### Team Mode — link channels

1. In the Web UI **Channels** page, click **Add channel** under the Microsoft
   Teams section to generate a **channel link code**.
2. Add the agent's Teams app to the team.
3. **@mention the agent** in the channel with the code. The agent confirms it's
   now connected.

You can link **multiple channels** — click **Add channel** again for each one;
linked channels appear in a table on the Channels page, each with an **Unlink**
action. A channel can only be linked to one agent.

#### The main channel

When several channels are linked, one is the **main channel** (marked ★ in the
table; the first channel you link becomes main by default). **Heartbeat alerts**
post to the main channel only — never fanned out to every linked channel. Use
**Set main** in the table to move it.

Personal Mode and Team Mode are mutually exclusive — unlink all channels before
switching to a personal link, and vice-versa.

## How the agent behaves in Teams

- **Personal chats.** It replies to everything you send. The chat history is
  kept separate from the web chat, so Teams messages don't show up there.
- **Channels.** The agent answers when you **@mention** it. In a thread it has
  answered in, it also answers a reply that asks it for something, with or
  without a mention, and leaves replies meant for other people alone. It reads
  those replies as part of the thread. The agent knows **which channel** it's
  replying in (the channel name is part of its context).
- **Threads.** The agent replies **in the thread** of the message that
  mentioned it; a top-level mention starts a thread. Each Teams reply chain
  maps to its own Prism conversation thread.
- **Working cue.** When your message arrives the agent shows a brief typing
  indicator. Teams expires typing indicators after a few seconds, so on long
  tasks the cue fades before the reply lands.
- **Messages sent mid-reply.** Long tasks post progress as they go, and a
  message that lands mid-task is handed to the work already in flight — the
  agent picks it up at its next step and adjusts.
- **Files.** The agent reads files you send it in a personal chat, images you
  paste into a message, and files shared in a channel when the optional
  [admin permission](#azure-setup-checklist) is granted. A file it shares
  arrives as a download link, which opens on the machine that runs Prism. On a
  server, set the [public Web UI address](configuration.md#public-web-ui-address).
- **Formatting.** Replies are markdown; unlike Slack, Teams renders tables.
- **Feedback buttons** (👍 / 👎) are not yet available on Teams.

Autonomous messages from the agent — [heartbeat](heartbeat.md) alerts and
[scheduled task](scheduled-tasks.md) results — arrive as posts. In Team Mode,
heartbeat alerts go to the [main channel](#the-main-channel); in Personal Mode
they arrive in your personal chat.

## Current limitations

The first Teams integration covers chat and autonomous delivery. Not yet
supported: file uploads into Teams, reactions, feedback buttons,
group chats (the agent answers personal chats and channels only), and
heartbeat-trigger channels.
