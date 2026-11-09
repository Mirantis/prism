//! A remote computer over a real link: a client on a WebSocket answering what the
//! computer asks.

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use super::*;
use crate::services::computer::computer::with_model_channel;
use crate::services::computer::remote::computer_link::tests::{
    FakeClient, Handler, eventually, linked,
};

/// A 1×1 JPEG, as base64: what the client answers a capture with.
const PIXEL: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

fn hello(capabilities: &[&str], displays: Value) -> InitializeParams {
    InitializeParams::parse(&json!({
        "protocolVersion": 1,
        "client": { "name": "test-client", "version": "1.2.3" },
        "platform": "macos",
        "displays": displays,
        "capabilities": capabilities,
    }))
    .unwrap()
}

fn laptop_display() -> Value {
    json!([{ "id": "main", "width": 2560, "height": 1440, "scale": 2, "primary": true }])
}

fn all_capabilities() -> InitializeParams {
    hello(
        &["screen", "input", "windows", "stream", "teleport"],
        laptop_display(),
    )
}

/// A computer named "Work laptop" on a link to a client answering with `handler`, and how
/// many times it reported a change.
async fn connect(
    handler: Handler,
    hello: InitializeParams,
) -> (Arc<RemoteComputer>, FakeClient, Arc<AtomicUsize>) {
    let (link, socket) = linked().await;
    let client = FakeClient::run(socket, handler);
    let changes = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&changes);
    let computer = RemoteComputer::new(
        Arc::new(|| "Work laptop".to_string()),
        Arc::clone(&link),
        hello,
        Some(Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        })),
    );
    link.start();
    (computer, client, changes)
}

/// A channel that keeps the pictures it is shown.
#[derive(Default)]
struct Pictures(Mutex<Vec<String>>);

impl ModelChannel for Pictures {
    fn show_image(&self, image_url: &str, _note: &str) -> bool {
        self.0.lock().push(image_url.to_string());
        true
    }

    fn notify(&self, _text: &str) {}
}

fn capture(width: i64, height: i64) -> Value {
    json!({ "mediaType": "image/jpeg", "width": width, "height": height, "data": PIXEL })
}

/// A sink that keeps the frames a viewer gets.
fn frames() -> (FrameSink, Arc<Mutex<Vec<ScreenFrame>>>) {
    let kept = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&kept);
    (Arc::new(move |frame| sink.lock().push(frame)), kept)
}

#[tokio::test]
async fn clicks_in_display_pixels_and_shows_the_model_the_screen_afterwards() {
    let (computer, client, _) = connect(
        FakeClient::answering(vec![
            ("input.click", json!({})),
            ("screen.capture", capture(1280, 720)),
        ]),
        all_capabilities(),
    )
    .await;
    let seen = Arc::new(Pictures::default());
    let result = with_model_channel(
        &*computer,
        seen.clone(),
        computer.click(ClickInput {
            x: Some(640.0),
            y: Some(360.0),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        DesktopActionResult::new(
            true,
            "Clicked left at (640, 360). The picture shows the screen now."
        )
    );
    // The model's picture of a 2560-wide screen is 1280 wide, so its coordinates double.
    assert_eq!(
        client.requests("input.click")[0]["params"],
        json!({ "x": 1280, "y": 720, "button": "left", "count": 1 })
    );
    let shot = &client.requests("screen.capture")[0]["params"];
    assert_eq!(shot["format"], json!("jpeg"));
    assert_eq!(shot["maxWidth"], json!(1280));
    assert_eq!(*seen.0.lock(), [format!("data:image/jpeg;base64,{PIXEL}")]);
}

#[tokio::test]
async fn maps_coordinates_from_the_picture_the_model_saw_and_refuses_one_wider_than_asked_for() {
    let width = Arc::new(AtomicI64::new(1000));
    let shown = Arc::clone(&width);
    let handler: Handler = Arc::new(move |method, _| match method {
        "input.click" => Ok(json!({})),
        "screen.capture" => {
            let width = shown.load(Ordering::SeqCst);
            Ok(capture(width, math_round(width as f64 * 0.5625) as i64))
        }
        _ => Err(json!({ "code": -32601, "message": "no" })),
    });
    let (computer, client, _) = connect(handler, all_capabilities()).await;
    let channel = Arc::new(Pictures::default());
    let look = with_model_channel(&*computer, channel.clone(), computer.look_at_screen())
        .await
        .unwrap();
    assert!(
        look.message.contains("as a 1000 by 563 picture"),
        "{}",
        look.message
    );
    with_model_channel(
        &*computer,
        channel.clone(),
        computer.click(ClickInput {
            x: Some(500.0),
            y: Some(281.0),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    // A 1000-wide picture of a 2560-wide display: the middle of it is the display's middle.
    let click = &client.requests("input.click")[0]["params"];
    assert_eq!(
        (click["x"].clone(), click["y"].clone()),
        (json!(1280), json!(719))
    );

    width.store(2560, Ordering::SeqCst);
    let refused = with_model_channel(&*computer, channel, computer.look_at_screen())
        .await
        .unwrap();
    assert!(!refused.success);
    assert!(
        refused
            .message
            .contains("larger than the 1280 by 720 it was asked for"),
        "{}",
        refused.message
    );
}

#[tokio::test]
async fn bounds_the_picture_of_a_portrait_display_on_both_axes() {
    let (computer, client, _) = connect(
        FakeClient::answering(vec![("screen.capture", capture(1080, 1920))]),
        hello(
            &["screen", "input", "windows", "stream"],
            json!([{ "id": "main", "width": 1080, "height": 1920, "scale": 1, "primary": true }]),
        ),
    )
    .await;
    let look = with_model_channel(
        &*computer,
        Arc::new(Pictures::default()),
        computer.look_at_screen(),
    )
    .await
    .unwrap();
    let shot = &client.requests("screen.capture")[0]["params"];
    assert_eq!(
        (shot["maxWidth"].clone(), shot["maxHeight"].clone()),
        (json!(720), json!(1280))
    );
    assert!(!look.success);
}

#[tokio::test]
async fn tells_the_model_which_permission_the_computer_is_missing() {
    let handler: Handler = Arc::new(|_, _| {
        Err(json!({
            "code": -32000,
            "message": "Accessibility permission is not granted.",
            "data": { "reason": "permission_denied", "permission": "Accessibility" },
        }))
    });
    let (computer, _client, _) = connect(handler, all_capabilities()).await;
    let typing = with_model_channel(
        &*computer,
        Arc::new(Pictures::default()),
        computer.type_text(TypeInput {
            text: "hello".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        typing.message,
        "That did not work: Accessibility permission is not granted. Ask your user to grant Accessibility to the computer client on Work laptop."
    );
}

#[tokio::test]
async fn says_what_a_computer_cannot_do_without_asking_it() {
    let (computer, client, _) = connect(
        FakeClient::answering(vec![]),
        hello(&["screen"], laptop_display()),
    )
    .await;
    let result = computer
        .list_elements(ListElementsInput::default())
        .await
        .unwrap();
    assert_eq!(
        result,
        DesktopActionResult::new(false, "Work laptop cannot read its controls.")
    );
    assert!(client.requests("elements.list").is_empty());
}

#[tokio::test]
async fn lists_the_windows_in_picture_coordinates() {
    let (computer, _client, _) = connect(
        FakeClient::answering(vec![(
            "windows.list",
            json!({ "windows": [
                { "id": "w1", "title": "Report", "app": "Numbers", "x": 0, "y": 0, "width": 200, "height": 100 },
            ] }),
        )]),
        all_capabilities(),
    )
    .await;
    let listed = computer.list_windows().await.unwrap();
    assert_eq!(
        listed.message,
        "1 window(s):\n\"Report\" (Numbers) at (0, 0), 100 by 50"
    );
}

fn streaming() -> Handler {
    FakeClient::answering(vec![
        (
            "stream.start",
            json!({ "encoding": "jpeg", "width": 1280, "height": 720 }),
        ),
        ("stream.stop", json!({})),
    ])
}

fn kinds(frames: &Mutex<Vec<ScreenFrame>>) -> Vec<&'static str> {
    frames
        .lock()
        .iter()
        .map(|frame| match frame {
            ScreenFrame::Start { .. } => "start",
            ScreenFrame::Jpeg { .. } => "jpeg",
            ScreenFrame::H264 { .. } => "h264",
        })
        .collect()
}

#[tokio::test]
async fn gets_the_stream_once_the_computer_can_stream() {
    let (computer, client, _) =
        connect(streaming(), hello(&["screen", "input"], laptop_display())).await;
    let (sink, _) = frames();
    computer.start_screen_stream(sink);
    assert!(client.requests("stream.start").is_empty());
    client.send(json!({
        "jsonrpc": "2.0",
        "method": "capabilities.changed",
        "params": { "capabilities": ["screen", "input", "stream"], "problems": [] },
    }));
    eventually(|| client.requests("stream.start").len() == 1).await;
}

#[tokio::test]
async fn passes_on_no_picture_once_the_computer_cannot_stream_and_streams_again_when_it_can() {
    let (computer, client, _) = connect(streaming(), all_capabilities()).await;
    let (sink, kept) = frames();
    computer.start_screen_stream(sink);
    eventually(|| kept.lock().len() == 1).await;
    let capabilities = |list: Value| {
        client.send(json!({
            "jsonrpc": "2.0",
            "method": "capabilities.changed",
            "params": { "capabilities": list, "problems": [] },
        }))
    };
    capabilities(json!(["screen", "input"]));
    // A frame that left the client after it lost the permission.
    client.send_binary(vec![0x01, 0, 0xaa]);
    capabilities(json!(["screen", "input", "stream"]));
    eventually(|| client.requests("stream.start").len() == 2).await;
    eventually(|| kept.lock().len() >= 2).await;
    assert_eq!(kinds(&kept), ["start", "start"]);
}

#[tokio::test]
async fn drops_the_old_streams_frames_when_the_stream_starts_over() {
    let starts = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&starts);
    // The client sends a frame of the stream being replaced just before the answer; the
    // handler runs on the client's reading task, ahead of the answer it returns.
    let early: Arc<Mutex<Option<FakeClient>>> = Arc::new(Mutex::new(None));
    let sender = Arc::clone(&early);
    let handler: Handler = Arc::new(move |method, _| match method {
        "stream.start" => {
            if counted.fetch_add(1, Ordering::SeqCst) == 1
                && let Some(client) = sender.lock().as_ref()
            {
                client.send_binary(vec![0x01, 0, 0xaa]);
            }
            Ok(json!({ "encoding": "jpeg", "width": 1280, "height": 720 }))
        }
        _ => Ok(json!({})),
    });
    let (computer, client, _) = connect(handler, all_capabilities()).await;
    let (sink, kept) = frames();
    computer.start_screen_stream(sink);
    eventually(|| kept.lock().len() == 1).await;
    // The handler sends through a second client handle on the same socket.
    *early.lock() = Some(client.clone());
    client.send(json!({
        "jsonrpc": "2.0",
        "method": "displays.changed",
        "params": { "displays": [{ "id": "side", "width": 1920, "height": 1080, "primary": true }] },
    }));
    eventually(|| kept.lock().len() == 2).await;
    client.send_binary(vec![0x01, 0, 0xbb]);
    eventually(|| kept.lock().len() == 3).await;
    assert_eq!(kinds(&kept), ["start", "start", "jpeg"]);
    assert_eq!(
        kept.lock()[2],
        ScreenFrame::Jpeg {
            data: base64::engine::general_purpose::STANDARD.encode([0xbb])
        }
    );
}

#[tokio::test]
async fn tells_the_list_when_what_the_computer_can_do_changes() {
    let (computer, client, changes) =
        connect(FakeClient::answering(vec![]), all_capabilities()).await;
    client.send(json!({
        "jsonrpc": "2.0",
        "method": "capabilities.changed",
        "params": {
            "capabilities": ["screen"],
            "problems": [{ "capability": "input", "message": "Accessibility is off." }],
        },
    }));
    eventually(|| changes.load(Ordering::SeqCst) == 1).await;
    assert_eq!(
        computer.info().problems,
        [CapabilityProblem {
            capability: "input".into(),
            message: "Accessibility is off.".into()
        }]
    );
    assert_eq!(computer.info().capabilities, [Capability::Screen]);
}

#[tokio::test]
async fn streams_the_new_primary_display_when_the_primary_display_changes() {
    let (computer, client, _) = connect(streaming(), all_capabilities()).await;
    let (sink, _) = frames();
    computer.start_screen_stream(sink);
    eventually(|| client.requests("stream.start").len() == 1).await;
    client.send(json!({
        "jsonrpc": "2.0",
        "method": "displays.changed",
        "params": { "displays": [{ "id": "side", "width": 1920, "height": 1080, "primary": true }] },
    }));
    eventually(|| client.requests("stream.start").len() == 2).await;
    assert_eq!(
        client.requests("stream.start")[1]["params"]["display"],
        json!("side")
    );
}

#[tokio::test]
async fn relays_a_viewers_pointer_in_display_pixels_and_its_command_key_as_super() {
    let (computer, client, _) = connect(
        FakeClient::answering(vec![
            (
                "stream.start",
                json!({ "encoding": "h264", "codec": "avc1.640028", "width": 1280, "height": 720 }),
            ),
            ("stream.stop", json!({})),
        ]),
        all_capabilities(),
    )
    .await;
    let (sink, kept) = frames();
    computer.start_screen_stream(sink);
    eventually(|| kept.lock().len() == 1).await;
    assert_eq!(
        kept.lock()[0],
        ScreenFrame::Start {
            encoding: StreamEncoding::H264,
            codec: Some("avc1.640028".into())
        }
    );
    client.send_binary(vec![LINK_VIDEO_FRAME, 1, 0, 0, 0, 1]);
    eventually(|| kept.lock().len() == 2).await;
    assert!(matches!(
        kept.lock()[1],
        ScreenFrame::H264 { keyframe: true, .. }
    ));

    // The stream is half the display's size, so a point on it is twice as far in.
    computer.handle_input(&json!({ "type": "pointer", "x": 100, "y": 50 }).to_string());
    computer.handle_input(
        &json!({ "type": "pointer_button", "button": "left", "down": true }).to_string(),
    );
    computer.handle_input(
        &json!({ "type": "key", "key": "c", "code": "KeyC", "ctrl": false, "alt": false, "shift": false, "meta": true })
            .to_string(),
    );
    eventually(|| client.requests("input.key").len() == 1).await;
    assert_eq!(
        client.requests("input.pointer")[0]["params"],
        json!({ "x": 200, "y": 100 })
    );
    assert_eq!(
        client.requests("input.key")[0]["params"],
        json!({ "keys": "super+c" })
    );

    // Handing back lets go of the button the viewer still held.
    computer.release_input();
    eventually(|| client.requests("input.button").len() == 2).await;
    assert_eq!(
        client.requests("input.button")[1]["params"],
        json!({ "button": "left", "down": false })
    );
}

#[tokio::test]
async fn offers_no_browser_and_no_shared_screen() {
    let (computer, _client, _) = connect(FakeClient::answering(vec![]), all_capabilities()).await;
    let browsed = computer
        .browse(serde_json::from_value(json!({ "action": "read" })).unwrap())
        .await
        .unwrap();
    assert_eq!(
        browsed.message,
        "Work laptop offers no browser control. Use its browser through the desktop tools: computer_screen, computer_click_text, computer_type and computer_key."
    );
    assert!(!computer.look_at_user_screen().await.unwrap().success);
}
