# Computer link protocol

This page is for people writing the client that connects a computer to Prism, so
the agent can use it. It describes version 1 of the computer link,
`/api/computer-link`.

The schemas in `backend/src/services/computer/remote/link_protocol.rs` are the authority.

## Adding the computer

Reach Prism the way the web UI does: the platform in front of Prism signs the
user in. An HTTP 401 or 403 comes from that platform. Refresh the sign-in and try
again at once.

Add the computer once, and keep the `id` you get back:

```http
POST /agents/computers
{"name":"Work laptop","platform":"macos","installationId":"<uuid v4>"}
```

- `platform` is `macos`, `windows` or `linux`.
- Make up `installationId` once per installation and keep it. Adding again with
  the same `installationId` answers `200` with the same computer, renamed when
  the name differs, instead of `201` with a new one.
- `409` means another computer has that name. Pick another one, such as
  `Work laptop (2)`.
- The user renames and removes computers on the Computer page.

## Connecting

1. Open `wss://<prism>/api/computer-link?computer=<id>`. Use `ws://` only to a
   loopback address. Send no `Origin` header.
2. `404` means the computer was removed. Add it again.
3. Send `initialize` as the first message, within 10 seconds:

   ```json
   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"client":{"name":"prism-computer","version":"1.0.0"},"platform":"macos","displays":[{"id":"1","width":3024,"height":1964,"scale":2,"primary":true}],"capabilities":["screen","input","windows","elements","stream"],"problems":[{"capability":"elements","message":"Accessibility permission is not granted."}]}}
   ```

   - `client.version` is your app's version.
   - `width` and `height` are the display's pixels, as a full-size capture has
     them. `scale` is pixels per point.
   - List only the capabilities that work now. For one that does not, say why in
     `problems`. The user and the agent see that message.

4. Prism answers:

   ```json
   {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"computer":{"id":"…","name":"Work laptop"},"pingIntervalSeconds":30}}
   ```

A newer link for the same computer replaces the older one.

## Messages

- Each text frame is one JSON-RPC 2.0 message. There are no batches. A frame is
  at most 16 MiB.
- Both sides send requests. Keep your own request ids.
- Apply requests and notifications in the order they arrive. Answer a request
  when its effect has happened, for example when the click has been delivered.
- To refuse a request, answer error code `-32000` with `data.reason`. The agent
  reads `message`, so write it for a person.

| `data.reason` | Meaning |
|---|---|
| `permission_denied` | The system did not allow it. Add `data.permission`, the permission's name. |
| `unsupported` | This computer cannot do that. |
| `held` | The person at the computer has control. |
| `busy` | Another agent is using this computer. |
| `invalid_params` | The params were wrong. |
| `internal` | Anything else. |

### Requests from Prism

| Method | Params | Result |
|---|---|---|
| `screen.capture` | `display?, format: "jpeg"\|"png", maxWidth?, maxHeight?, quality?` | `mediaType, width, height, data` (base64) |
| `input.click` | `x, y, button, count` | `{}` |
| `input.pointer` | `x, y` | `{}` |
| `input.button` | `button, down` | `{}` |
| `input.wheel` | `x, y, dy` | `{}` |
| `input.key` | `keys` | `{}` |
| `input.text` | `text` | `{}` |
| `windows.list` | | `windows: [{ id, title, app, x, y, width, height, focused, minimized }]` |
| `windows.act` | `id, action: "focus"\|"close"\|"maximize"\|"restore"\|"minimize"` | `{}` |
| `elements.list` | `filter?` | `elements: [{ app, role, name, x, y, width, height }]` |
| `stream.start` | `display?, encodings, maxWidth, fps` | `encoding, codec?, width, height` |
| `stream.stop` | | `{}` |

- A request without `display` is for the primary display.
- `maxWidth` and `maxHeight` are hard bounds: scale the picture or the stream down until
  it fits both, keeping the display's shape, and never send it larger. Prism refuses a
  capture larger than it asked for. `quality` is the JPEG quality, from 1 to 100.
- `button` is `left`, `middle` or `right`. `count: 2` is a double-click.
- `dy` is wheel notches. A positive `dy` scrolls down.
- `elements.list` lists the controls a person can act on. The frontmost
  application's windows and the menu bar are enough. `filter` is part of a name,
  matched without case. Prism matches names again, so you may ignore it.
- `role` is an AT-SPI role name. Map your platform's roles to these: `push button`,
  `toggle button`, `check box`, `radio button`, `menu`, `menu item`,
  `check menu item`, `radio menu item`, `page tab`, `list item`, `tree item`,
  `link`, `text`, `entry`, `password text`, `combo box`, `spin button`,
  `slider`, `icon`, `frame` (a window) and `dialog`. Prism ignores an element
  with any other role.
- The `input.*` methods also arrive as notifications, without an `id`: the steps
  of a drag, and the hand of a person who controls the computer from the web UI.

### Coordinates and keys

- Every coordinate is in pixels of the display's full capture, from its top-left
  corner. Divide by `scale` to get points.
- `keys` is X11 key names joined with `+`, such as `Return`, `ctrl+l` or
  `super+c`. The modifiers are `ctrl`, `alt`, `shift` and `super`. On macOS,
  `super` is Command and `alt` is Option. On Windows, `super` is the Windows key.

### The screen stream

- Answer `stream.start` before you send the stream's first frame. Prism drops a frame
  that arrives before the answer, as part of the stream it replaces.
- A `stream.start` while a stream runs starts it again, with a new encoder and a
  keyframe first.
- Each binary frame starts with two bytes, then the payload:

| Byte 0 | Byte 1 | Payload |
|---|---|---|
| `0x03` | bit 0 set on a keyframe | one H.264 access unit, Annex B |
| `0x01` | `0` | one JPEG picture, for `encoding: "jpeg"` |

- Put SPS and PPS before every keyframe. `codec` is an RFC 6381 string, such as
  `avc1.640028`.
- When your socket backs up, skip video up to the next keyframe.

### Notifications

From Prism:

- `computer.state` `{ agentActive, watched, controller, owner, help }` says who
  is using the computer.
  - `agentActive` is `true` while the agent holds the computer.
  - `watched` is `true` while someone watches the screen in the web UI.
  - `controller` is `viewer`, `local` or `null`.
  - `owner` is `{ threadId, mode, title? }` or `null`. `title` is the
    conversation's title.
  - `help` is `{ id, reason }` or `null`: the agent waits for the person to do
    something on this computer, which `reason` describes.

From the client:

| Method | Params | Meaning |
|---|---|---|
| `local.hold` | | The person at the computer takes control. |
| `local.release` | | They give it back. |
| `displays.changed` | `displays` | The displays changed. |
| `capabilities.changed` | `capabilities, problems` | A capability started or stopped working. |

## The person at the computer

- Send `local.hold` when the person takes over, and refuse `screen.capture`,
  `elements.list`, `windows.list` and `input.*` with `held` until you send
  `local.release`. The agent waits until then.
- While `help` is set, a hold is the answer to it, and Prism calls no model until
  the release. To finish the help request after the release, call
  `POST /agents/computer/help/<id>` with `{"action":"continue"}`. Send
  `{"action":"dismiss"}` to dismiss it.

## Staying connected

- Prism pings every `pingIntervalSeconds` and closes a link that has not answered
  by the next ping.
- Prism closes the link with these codes:

| Code | Meaning | What to do |
|---|---|---|
| 1001 | Prism is shutting down | Reconnect. |
| 4400 | Protocol error, or no `initialize` first | Stop and report the error. |
| 4403 | The computer was removed | Forget its id and stop. |
| 4409 | A newer link replaced this one | Stop. |
| 4426 | Protocol version not supported | Tell the person to update. |

- After any other close or a network error, reconnect. Wait 1 second the first
  time, double the wait up to 60 seconds, and add jitter. Reset the wait once a
  link has stayed open for 30 seconds.
