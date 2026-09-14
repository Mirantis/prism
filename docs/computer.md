# The agent's computer

The **Computer** page in the [Web UI](web-ui.md) gives the agent a computer and
shows you its screen. You watch it work, you talk to it, and you can take the
keyboard and mouse yourself.

The page is a [voice chat](voice-chat.md) with a computer in it. Everything that
page says about a call applies here: what the agent can do, and what your
authority over it means.

## What you need

Only `OPENAI_API_KEY`, the same key voice chat uses — see
[Configuration](configuration.md#voice-chat).

The desktop needs packages that the container image installs. Run the published
image, or build one with `npm run docker:build`. On a host with a display of its
own, the agent gets a browser on that display and no desktop.

## Starting

Open **Computer** in the sidebar. The call starts and the agent greets you. Leave
the page and the call ends.

Your microphone starts muted. Press **Unmute** when you want the agent to hear
you.

## The screen

The page shows the agent's screen while it works. In the container that screen is
a whole desktop, so the agent can use a terminal, a file manager, or anything else
the image installs. On a host with its own display, the page shows the browser tab
in front instead.

The screen is made the size of the area the page draws it in, so you see the
desktop at its own resolution. Resize the browser window or go fullscreen and the
desktop follows, a moment after you stop. A very large window gets the largest
screen the runtime keeps, scaled up the rest of the way.

## Taking control

Click the screen to take the pointer and keyboard. Press Esc to give them back.

While the screen is on the page, pasting types your clipboard into whatever has
the focus on the desktop. This works whether or not you hold the pointer.

## Sharing your own screen

Press **Share screen** to show the agent your screen, a window or a tab, the way
you would in a video call. Ask the agent to look and it reads what is there.

"The screen" on its own means the agent's own screen, since that is the one you
are both watching. Say "my screen" for yours.

## One call at a time

The agent has one voice. Opening the Computer page while a call from the chat
composer is running is refused, and so is the reverse. Opening the page twice
moves the call to the newer page, which is what a reload does.

## When it doesn't work

- **The page says the screen would not start.** The image lacks the desktop
  packages. The message names the program it looked for. Build the image with
  `npm run docker:build`.
- **The page says the screen cannot be shown.** The browser has no video decoder
  for the stream. The call and its sound continue.
- **The call is refused.** Another call holds the agent's voice. The message says
  which one.
- **There is no desktop to take the pointer on.** The runtime found a display of
  its own, so the agent has a browser and no desktop around it.
