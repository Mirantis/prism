//! A remote computer over a real link: a client on a WebSocket against the endpoint, the
//! registry and the sessions the tools use, on a test database.

use axum::Router;
use axum::routing::any;
use serde_json::Value;

use super::*;
use crate::services::computer::computer_access::ComputerCaller;
use crate::services::computer::computer_service::ComputerConnection;
use crate::services::computer::remote::computer_link::tests::{FakeClient, Handler, eventually};
use crate::services::computer::remote::remote_computer_service::AddComputerInput;
use crate::services::computer::remote::remote_computer_service::tests::agent_row;

/// A 1×1 JPEG, as base64: what the client answers a capture with.
const PIXEL: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

fn hello() -> Value {
    json!({
        "protocolVersion": 1,
        "client": { "name": "test-client", "version": "1.2.3" },
        "platform": "macos",
        "displays": [{ "id": "main", "width": 2560, "height": 1440, "scale": 2, "primary": true }],
        "capabilities": ["screen", "input", "windows", "stream", "teleport"],
    })
}

/// The endpoint on a server of its own, and the agent with one computer, "Work laptop".
struct Fixture {
    _db: crate::db::testing::TestDb,
    base: String,
    laptop: String,
}

async fn fixture() -> Fixture {
    let db = crate::db::testing::test_db();
    let agent = agent_row().await;
    CONFIG.set_agent_id(Some(agent.clone()));
    CONFIG.set_owner_user_id("user-1".to_string());
    REMOTE_COMPUTER_SERVICE.load(&agent).await.unwrap();
    COMPUTER_LINK_ENDPOINT.initialize();
    let app = Router::new().route(
        COMPUTER_LINK_PATH,
        any(|req: Request| COMPUTER_LINK_ENDPOINT.handle_upgrade(req)),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await });
    let (laptop, _) = REMOTE_COMPUTER_SERVICE
        .add(
            AddComputerInput {
                name: "Work laptop".into(),
                platform: Some(super::super::link_protocol::RemotePlatform::Macos),
                installation_id: None,
            },
            "user-1",
        )
        .await
        .unwrap();
    Fixture {
        _db: db,
        base: format!("ws://{address}{COMPUTER_LINK_PATH}"),
        laptop: laptop.id,
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        COMPUTER_LINK_ENDPOINT.close();
    }
}

/// A client of computer `id`, or the status its handshake was refused with.
async fn connect(fixture: &Fixture, id: &str, handler: Handler) -> Result<FakeClient, u16> {
    match tokio_tungstenite::connect_async(format!("{}?computer={id}", fixture.base)).await {
        Ok((socket, _)) => Ok(FakeClient::run(socket, handler)),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            Err(response.status().as_u16())
        }
        Err(other) => panic!("{other}"),
    }
}

/// Send `initialize` and wait for its answer.
async fn initialize(client: &FakeClient, params: Value) -> Value {
    client.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": params }));
    eventually(|| !client.answers().is_empty()).await;
    client.answers()[0].clone()
}

fn caller(thread_id: Option<&str>) -> ComputerCaller {
    ComputerCaller {
        user_id: "user-1".into(),
        agent_id: CONFIG.agent_id().unwrap_or_default(),
        thread_id: thread_id.map(str::to_string),
        mode: "chat".into(),
        origin_channel: None,
        origin_channel_id: None,
    }
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_computer_that_is_not_registered() {
    let fixture = fixture().await;
    let refused = connect(
        &fixture,
        "00000000-0000-4000-8000-0000000000ff",
        FakeClient::answering(vec![]),
    )
    .await;
    assert_eq!(refused.err(), Some(404));
}

#[tokio::test]
#[serial_test::serial]
async fn closes_a_link_whose_first_message_is_not_initialize() {
    let fixture = fixture().await;
    let client = connect(&fixture, &fixture.laptop, FakeClient::answering(vec![]))
        .await
        .unwrap();
    client.send(json!({ "jsonrpc": "2.0", "method": "local.hold" }));
    eventually(|| client.closed().is_some()).await;
    assert_eq!(client.closed(), Some(LINK_CLOSE.protocol_error));
}

#[tokio::test]
#[serial_test::serial]
async fn closes_a_link_that_speaks_another_protocol_version() {
    let fixture = fixture().await;
    let client = connect(&fixture, &fixture.laptop, FakeClient::answering(vec![]))
        .await
        .unwrap();
    let mut params = hello();
    params["protocolVersion"] = json!(2);
    let answer = initialize(&client, params).await;
    assert!(
        answer["error"]["message"]
            .as_str()
            .unwrap()
            .contains("version 1")
    );
    eventually(|| client.closed().is_some()).await;
    assert_eq!(client.closed(), Some(LINK_CLOSE.unsupported_version));
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_initialize_params_it_cannot_read_with_the_first_issue() {
    let fixture = fixture().await;
    let client = connect(&fixture, &fixture.laptop, FakeClient::answering(vec![]))
        .await
        .unwrap();
    let mut params = hello();
    params["platform"] = json!("beos");
    let answer = initialize(&client, params).await;
    assert_eq!(
        answer["error"],
        json!({
            "code": -32602,
            "message": "initialize: Invalid option: expected one of \"macos\"|\"windows\"|\"linux\"",
        })
    );
    eventually(|| client.closed().is_some()).await;
    assert_eq!(client.closed(), Some(LINK_CLOSE.protocol_error));
}

#[tokio::test]
#[serial_test::serial]
async fn answers_initialize_and_lists_the_computer_as_connected_until_the_link_ends() {
    let fixture = fixture().await;
    let client = connect(&fixture, &fixture.laptop, FakeClient::answering(vec![]))
        .await
        .unwrap();
    let answer = initialize(&client, hello()).await;
    assert_eq!(
        answer["result"],
        json!({
            "protocolVersion": 1,
            "computer": { "id": fixture.laptop, "name": "Work laptop" },
            "pingIntervalSeconds": 30,
        })
    );
    let listed = COMPUTER_SERVICE
        .summaries()
        .into_iter()
        .find(|item| item.id == fixture.laptop)
        .unwrap();
    assert_eq!(listed.connection, ComputerConnection::Connected);
    assert_eq!(listed.platform.as_deref(), Some("macos"));
    assert_eq!(listed.client_version.as_deref(), Some("1.2.3"));
    // A capability this runtime does not know is left out.
    assert_eq!(
        listed.capabilities,
        ["screen", "input", "windows", "stream"]
    );

    client.close();
    let laptop = fixture.laptop.clone();
    eventually(move || {
        COMPUTER_SERVICE
            .summaries()
            .into_iter()
            .find(|item| item.id == laptop)
            .is_some_and(|item| item.connection == ComputerConnection::Disconnected)
    })
    .await;
    COMPUTER_SERVICE
        .remove(&fixture.laptop, "user-1")
        .await
        .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn replaces_an_older_link_of_the_same_computer() {
    let fixture = fixture().await;
    let first = connect(&fixture, &fixture.laptop, FakeClient::answering(vec![]))
        .await
        .unwrap();
    initialize(&first, hello()).await;
    let second = connect(&fixture, &fixture.laptop, FakeClient::answering(vec![]))
        .await
        .unwrap();
    initialize(&second, hello()).await;
    eventually(|| first.closed().is_some()).await;
    assert_eq!(first.closed(), Some(LINK_CLOSE.replaced));
    let listed = COMPUTER_SERVICE
        .summaries()
        .into_iter()
        .find(|item| item.id == fixture.laptop)
        .unwrap();
    assert_eq!(listed.connection, ComputerConnection::Connected);
    COMPUTER_SERVICE
        .remove(&fixture.laptop, "user-1")
        .await
        .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn closes_the_link_of_a_computer_that_is_removed_and_refuses_it_after() {
    let fixture = fixture().await;
    let client = connect(&fixture, &fixture.laptop, FakeClient::answering(vec![]))
        .await
        .unwrap();
    initialize(&client, hello()).await;
    COMPUTER_SERVICE
        .remove(&fixture.laptop, "user-1")
        .await
        .unwrap();
    eventually(|| client.closed().is_some()).await;
    assert_eq!(client.closed(), Some(LINK_CLOSE.removed));
    let again = connect(&fixture, &fixture.laptop, FakeClient::answering(vec![])).await;
    assert_eq!(again.err(), Some(404));
}

#[tokio::test]
#[serial_test::serial]
async fn tells_the_client_who_uses_the_computer() {
    let fixture = fixture().await;
    let agent = CONFIG.agent_id().unwrap();
    let thread_id = crate::db::run(move |conn| {
        let mut thread = crate::db::models::NewConversationThread::new(agent, "user-1".to_string());
        thread.title = Some("Billing report".into());
        let id = thread.id.clone();
        diesel::insert_into(conversation_threads::table)
            .values(&thread)
            .execute(conn)?;
        Ok(id)
    })
    .await
    .unwrap();
    let client = connect(
        &fixture,
        &fixture.laptop,
        FakeClient::answering(vec![(
            "screen.capture",
            json!({ "mediaType": "image/jpeg", "width": 1280, "height": 720, "data": PIXEL }),
        )]),
    )
    .await
    .unwrap();
    initialize(&client, hello()).await;
    eventually(|| client.requests("computer.state").len() == 1).await;
    assert_eq!(
        client.requests("computer.state")[0]["params"],
        json!({ "agentActive": false, "watched": false, "controller": null, "owner": null, "help": null })
    );

    let used = COMPUTER_SERVICE.create_use(caller(Some(&thread_id)), None);
    let session = COMPUTER_SERVICE.resolve(&used, None).unwrap();
    struct Ignore;
    impl crate::services::computer::agent_computer::ModelChannel for Ignore {
        fn show_image(&self, _: &str, _: &str) -> bool {
            true
        }
        fn notify(&self, _: &str) {}
    }
    COMPUTER_SERVICE
        .act(
            &used,
            &session,
            |computer| async move { computer.look_at_screen().await },
            Arc::new(Ignore),
            false,
        )
        .await
        .unwrap();
    let expected_thread = thread_id.clone();
    eventually(move || {
        client
            .requests("computer.state")
            .last()
            .is_some_and(|state| {
                state["params"]["agentActive"] == json!(true)
                    && state["params"]["owner"]
                        == json!({ "threadId": expected_thread, "mode": "chat", "title": "Billing report" })
            })
    })
    .await;
    COMPUTER_SERVICE.finish(&used);
    COMPUTER_SERVICE
        .remove(&fixture.laptop, "user-1")
        .await
        .unwrap();
}
