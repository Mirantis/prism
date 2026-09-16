# The agent's computer

Prism has its own desktop and browser. Ask it to use websites or desktop apps in chat, goals, or scheduled tasks. Open **Computer** in the [Web UI](web-ui.md) at any time to watch it work.

## What you need

Run the published container image, which includes the desktop packages. Signed-in browser sessions are saved in the persistent data volume.

## Watching and taking control

Opening **Computer** shows the live desktop. Work continues when you leave the page. The status shows who has control and links to the active conversation.

Click the screen to use the mouse and keyboard. Paste types into the focused field. Press Esc or **Continue** to hand the computer back to Prism. Closing the page while you have control keeps Prism paused.

While you have control, ask Prism to inspect the screen if you need guidance. Press **Sound** to hear the desktop, or **Talk** to start optional [voice chat](voice-chat.md), initially muted.

## When Prism needs help

Prism sends a help request with **Open Computer** when a website needs sign-in, a CAPTCHA, or another step for you. On Computer, the request appears beside the screen, or above it on smaller displays. Click the screen, finish the step directly on the desktop, and press Esc or **Continue** to resume the request. You can also tell Prism in the originating chat that you finished helping.

A blocked website can wait while Prism works elsewhere. When you hand back control, the interrupted turn finishes first; the request you unblocked follows it. **Dismiss** closes a help request; Prism treats it as dismissed in later conversation turns. **Stop current task** cancels the invocation using the computer.

## Several requests

Computer requests take turns. A conversation waiting for the desktop shows **Waiting for the computer** and offers **Stop current task**. Other requests can continue using connectors or shell tools. Prism handles desktop steps in the main conversation and can delegate other work to subagents.

Voice can discuss the screen and pass instructions to an active chat task. A voice call creates no chat history of its own.

## Links from Slack

Lens-hosted deployments supply the public address automatically through `NEXUS_INGRESS_ORIGINS_WEB` (or the name of the exposed Web UI port). Set `PRISM_PUBLIC_URL` for standalone deployments or to override that address, including any path prefix.

## Troubleshooting

- **Computer is missing.** Run the published container image with its desktop packages.
- **The viewer reconnects.** Wait for the live stream, then take control again if needed.
- **The tab needing help has closed.** Use the current desktop or tell Prism to reopen the website.
- **The runtime restarted.** Ask Prism to continue the interrupted request. Browser logins stored in the data volume remain available.
