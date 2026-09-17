# The agent's computer

Prism has its own desktop and browser. Ask it to use websites or desktop apps in chat, goals, or scheduled tasks. Open **Computer** in the [Web UI](web-ui.md) at any time to watch it work.

## What you need

Run the published container image, which includes the desktop packages. Signed-in browser sessions are saved in the persistent data volume.

## Watching and taking control

Opening **Computer** shows the live desktop at 1920×1080, scaled to fit your window. Work continues when you leave the page. The status shows who has control and links to the active conversation.

Click the screen to use the mouse and keyboard. Paste types into the focused field. Press Esc or **Return control** to hand the computer back to Prism. Closing the page while you have control keeps Prism paused.

While you have control, ask Prism to inspect the screen if you need guidance. Desktop sound is on; use **Sound** to mute it. Choose **Talk** to start optional [voice chat](voice-chat.md), initially muted.

## Showing Prism your own screen

During a voice call, **Share screen** shows Prism your own screen, window or tab, the way
you would in a video call. Ask it to look and it reads what is there.

**Record** captures that screen while you talk through what you are doing, for something
that takes more than a glance. Press stop and Prism is given the whole thing — your screen
as it changed, and your voice over it — and answers about it. It cannot hear you while a
recording runs, so it will not interrupt, and a recording stops itself after five minutes.

## When Prism needs help

Prism slides the live desktop into a resizable panel over the right side of the whole chat when it needs help. Close it with the X and reopen it from the help request in the chat, or use fullscreen when you need more room. Click the desktop, finish the step, and press Esc or **I’m done** to resume the request. The chat keeps a compact completed or dismissed status where the request appeared after the panel closes.

A blocked website can wait while Prism works elsewhere. When you hand back control, the interrupted turn finishes first; the request you unblocked follows it. **Dismiss** closes a help request; Prism treats it as dismissed in later conversation turns. **Stop** cancels the invocation using the computer.

## Several requests

Computer requests take turns. A conversation waiting for the desktop shows **Waiting for the computer** and offers **Stop**. Other requests can continue using connectors or shell tools. Prism handles desktop steps in the main conversation and can delegate other work to subagents.

Voice can discuss the screen and pass instructions to an active chat task. A voice call creates no chat history of its own.

## Links from Slack

Lens-hosted deployments supply the public address automatically through `NEXUS_INGRESS_ORIGINS_WEB` (or the name of the exposed Web UI port). Set `PRISM_PUBLIC_URL` for standalone deployments or to override that address, including any path prefix.

## Troubleshooting

- **Computer is missing.** Run the published container image with its desktop packages.
- **The viewer reconnects.** Wait for the live stream, then take control again if needed.
- **The tab needing help has closed.** Use the current desktop or tell Prism to reopen the website.
- **The runtime restarted.** Ask Prism to continue the interrupted request. Browser logins stored in the data volume remain available.
