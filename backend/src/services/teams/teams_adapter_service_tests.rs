//! Tests of the Teams adapter, against a local stand-in for the Bot Framework
//! connector, the identity platform's token endpoint and the signing keys.

use std::collections::VecDeque;

use axum::extract::Request;
use chrono::Duration as ChronoDuration;
use diesel::prelude::*;
use pretty_assertions::assert_eq;

use super::*;
use crate::db::models::{NewConversationThread, NewTeamsVerificationCode};
use crate::db::schema::conversation_messages as cm;
use crate::db::testing::test_db;
use crate::services::attachment_service::{AttachmentCategory, WithAttachments};
use crate::services::teams::teams_mapping_service::tests::{
    insert_agent, insert_channel, insert_dm,
};

/// A throwaway RSA key made for these tests; it signs nothing else.
const TEST_KEY_PEM: &str = "-----BEGIN RSA PRIVATE KEY-----
MIIEoQIBAAKCAQEAg9NsF+lYC0+KFZT2K4PAsRUmEWlV/L+/u/O3eVPM+bLHzwmx
+9bhoWkLIGI0iT/y22/jl3wIowDfeotwd9DW4JNksyKNo70aHlen+eTjgUlszzMe
fMT3SOXXapYSWlfx6wbNDpyzvXmHNubpJfeznp99cbc6O6QaE74zvipJN4jj9XS9
NaTfdOCvi/9jdwFTgoe8syPFgSh0DODbwUz0VZYlOiCR+NccTKXnsGtQZ3/jIA5l
PBlUQvh8a1IpSVxlHAVQvYwjSpnjhnIF3n5Ws5jMxuCrwuhNMA6wDMiTD8G8AZ0X
Mh7VXy9H2cxipsBuYszvyrP/8UJ8aiY1igOwEQIDAQABAoH/SFlAed8W8x40KqQW
dstYddeljOjCyHR0RjL7/xp+5Iu6HWa0yAKm0m9UK/G545m1L7m4rurj0pIoFJly
oE99nsNGAQp1seeW7hAtoHh+Y/ZoQU9M7C0tilSaZWT3rZ2Wp+aTo/FctCB+lSMl
0jCf4+6kakSlMRZfOXap7zRF+rPcwtFOdAS4VuAx4XD9cezV1Y5krFLs0jh4lhP3
qCpFvflNdLxU5j62uF3lH+cR7eTxY9IIv5ak+xR9pfxcxto1VUtzAsQxUts2r+gm
BoFTacADXegtntJcAm211hIa9uCWh6fyeZ5ba3M9a4X3EDTMJIK/S4OOqbeWzcab
hXMBAoGBALiFlM+giQ5E7/KVQkuw0py2xlLsRNYofQnlEBZoOpNAQJsHFJko0vMk
NWzKwybnuK+RMn6Zb1ZvLKe4DhK5/vHFleDneQNXl8eZwzvChOdSw7AwnELyVSNN
YbV5LE7+e7tRY4jaUpCjnj2vDNPBE25F90qvUp0hxDZ6QJJX4/uhAoGBALbkKLAM
xd1KL4l6lxCxYiHTPc9k/qRgmnvRLZkwvrFsWDELzX9mMmrQ1WUMSficFchzDFLs
O/OuCOv4jAo8+xYTA2uiqfxBRIvm/0J9LLlSHiDt3zPs0SaMg5T4ORHlk1hRCGbt
/5eRGWdULRdk6Hik7YhO1VszNO5wmUW6rN5xAoGASo+fzC5Ac4Wjt9BcU52F3VF1
3jgesLL3o7HtyEAhuzKxaHN5/VGjvCAbfnSIWwYzeK4hS0rQ1Ipj7vnOpf6GaEfB
AnpGSfVxHXSikVlOvvKQpHdgDSVDBdrU6rGmF915Pf3rTHd7+XpEDQTZGA/ivCKF
hKZHqbrlQGYyBXCCbUECgYAyK6ClurtEmyczNXffUmmzEbmw/OmFuiJmuNkjXuXQ
0gHXYn965VQLTUJct+RK2LZ5CGZnEPrZO/KimMoBvPy773dOvY6X7meZYULAwInW
RJqTOe2y1tIBGya1ZOpy6GFlJsWBRuSIdXtchxDfjATho4yticKphACPMEA7ipwF
YQKBgQCx9KvUjuCeH5yAY4VVi/T4CuQKdkc1AM4rPguOfiJNBqZOftWgL4qU4lSN
CZhop1cR8J4Gf2xA926adW24sAnm2P1GzeFQR2n8gL2/AAs70fH9elUw4zmX+z7w
O/lC/EcDrOtSGEKVhi5ZksgT1hy9j6Vg60l0BIkfEtOg0v+hTw==
-----END RSA PRIVATE KEY-----
";

/// The modulus of `TEST_KEY_PEM`, as a JWK's `n`.
const TEST_KEY_N: &str = "g9NsF-lYC0-KFZT2K4PAsRUmEWlV_L-_u_O3eVPM-bLHzwmx-9bhoWkLIGI0iT_y22_jl3wIowDfeotwd9DW4JNksyKNo70aHlen-eTjgUlszzMefMT3SOXXapYSWlfx6wbNDpyzvXmHNubpJfeznp99cbc6O6QaE74zvipJN4jj9XS9NaTfdOCvi_9jdwFTgoe8syPFgSh0DODbwUz0VZYlOiCR-NccTKXnsGtQZ3_jIA5lPBlUQvh8a1IpSVxlHAVQvYwjSpnjhnIF3n5Ws5jMxuCrwuhNMA6wDMiTD8G8AZ0XMh7VXy9H2cxipsBuYszvyrP_8UJ8aiY1igOwEQ";

const CLIENT_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TENANT_ID: &str = "11111111-2222-4333-8444-555555555555";
const ALICE: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const BOB: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// ============================================================================
// A stand-in for Microsoft's services
// ============================================================================

#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Value,
}

#[derive(Default)]
struct MockState {
    requests: Vec<Recorded>,
    /// Status and Retry-After of the next activity posts to fail.
    send_failures: VecDeque<(u16, Option<String>)>,
    members: HashMap<String, Value>,
    member_status: Option<u16>,
    /// `None` answers the team's channel list with 403.
    team_conversations: Option<Value>,
    next_id: u64,
}

struct MockBotFramework {
    base: String,
    state: Arc<Mutex<MockState>>,
    shutdown: CancellationToken,
}

impl Drop for MockBotFramework {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

async fn mock_answer(state: Arc<Mutex<MockState>>, req: Request) -> Response {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let authorization = req
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let mut state = state.lock();
    state.requests.push(Recorded {
        method: method.clone(),
        path: path.clone(),
        authorization,
        body,
    });

    if path.ends_with("/oauth2/v2.0/token") {
        return json(
            200,
            json!({ "token_type": "Bearer", "expires_in": 3600, "access_token": "bot-token" }),
        );
    }
    if path == "/v1/.well-known/keys" {
        return json(
            200,
            json!({ "keys": [
                { "kty": "RSA", "use": "sig", "kid": "other-key", "n": "AQAB", "e": "AQAB" },
                { "kty": "RSA", "use": "sig", "kid": "test-key", "n": TEST_KEY_N, "e": "AQAB" },
            ] }),
        );
    }
    if method == "POST" && path.starts_with("/v3/conversations/") && path.ends_with("/activities") {
        if let Some((status, retry_after)) = state.send_failures.pop_front() {
            let mut response = json(status, json!({ "error": { "code": "Throttled" } }));
            if let Some(retry_after) = retry_after {
                response
                    .headers_mut()
                    .insert("retry-after", retry_after.parse().unwrap());
            }
            return response;
        }
        state.next_id += 1;
        return json(
            200,
            json!({ "id": format!("17123456789{:02}", state.next_id) }),
        );
    }
    if method == "GET" && path.starts_with("/v3/conversations/") && path.contains("/members/") {
        if let Some(status) = state.member_status {
            return json(status, json!({}));
        }
        let member_id = path.rsplit('/').next().unwrap_or("").to_string();
        return match state.members.get(&member_id) {
            Some(member) => json(200, member.clone()),
            None => json(
                404,
                json!({ "error": { "code": "MemberNotFoundInConversation" } }),
            ),
        };
    }
    if method == "GET" && path.starts_with("/v3/teams/") {
        return match &state.team_conversations {
            Some(conversations) => json(200, json!({ "conversations": conversations })),
            None => json(403, json!({})),
        };
    }
    json(404, json!({}))
}

impl MockBotFramework {
    async fn start() -> Self {
        let state = Arc::new(Mutex::new(MockState::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let shared = Arc::clone(&state);
        let app = Router::new().fallback(move |req: Request| {
            let shared = Arc::clone(&shared);
            async move { mock_answer(shared, req).await }
        });
        let shutdown = CancellationToken::new();
        let token = shutdown.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(token.cancelled_owned())
                .await;
        });
        MockBotFramework {
            base,
            state,
            shutdown,
        }
    }

    fn cloud(&self) -> TeamsCloud {
        TeamsCloud::new(
            &self.base,
            "botframework.com",
            "https://api.botframework.com/.default",
            &format!("{}/v1/.well-known/openidconfiguration", self.base),
            "https://api.botframework.com",
            "https://graph.microsoft.com/.default",
        )
    }

    fn app(&self) -> Arc<TeamsApp> {
        Arc::new(TeamsApp::new(
            CLIENT_ID,
            "invented-secret",
            TENANT_ID,
            self.cloud(),
            &self.base,
            DIRECT_HTTP.clone(),
            DIRECT_HTTP.clone(),
        ))
    }

    /// The activities posted, as `(conversation id, body)`.
    fn posted(&self) -> Vec<(String, Value)> {
        self.state
            .lock()
            .requests
            .iter()
            .filter(|r| r.method == "POST" && r.path.ends_with("/activities"))
            .map(|r| {
                let conversation = r
                    .path
                    .trim_start_matches("/v3/conversations/")
                    .trim_end_matches("/activities")
                    .to_string();
                (conversation, r.body.clone())
            })
            .collect()
    }

    /// The posted messages, as `(conversation id, text)`; typing activities left out.
    fn messages(&self) -> Vec<(String, String)> {
        self.posted()
            .into_iter()
            .filter(|(_, body)| body["type"] == "message")
            .map(|(conversation, body)| {
                (
                    conversation,
                    body["text"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect()
    }

    fn typing_count(&self) -> usize {
        self.posted()
            .iter()
            .filter(|(_, body)| body["type"] == "typing")
            .count()
    }

    fn requests_to(&self, prefix: &str) -> usize {
        self.state
            .lock()
            .requests
            .iter()
            .filter(|r| r.path.starts_with(prefix))
            .count()
    }

    /// Waits up to five seconds for `count` posted activities.
    async fn wait_for_posts(&self, count: usize) {
        for _ in 0..250 {
            if self.posted().len() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!(
            "expected {count} posted activities, got {:?}",
            self.posted()
        );
    }
}

fn connection() -> TeamsConnectionRecord {
    TeamsConnectionRecord {
        id: "tenant-1".to_string(),
        tenant_id: "tenant-1".to_string(),
        client_id: CLIENT_ID.to_string(),
        name: "Microsoft Teams".to_string(),
    }
}

/// The adapter, started against `mock` on an ephemeral port.
async fn connected(mock: &MockBotFramework) -> Arc<TeamsApp> {
    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
    TEAMS_ADAPTER_SERVICE.reset_for_tests();
    let app = mock.app();
    TEAMS_ADAPTER_SERVICE
        .start(connection(), Ok(Arc::clone(&app)), "127.0.0.1", 0)
        .await;
    assert!(TEAMS_ADAPTER_SERVICE.current_app().is_some());
    app
}

/// Runs an inbound activity's work as the message handler hands it over, and
/// waits for it to finish.
async fn receive(mock: &MockBotFramework, app: &Arc<TeamsApp>, activity: Value) {
    let parsed: TeamsActivity = serde_json::from_value(activity.clone()).unwrap();
    *TEAMS_ADAPTER_SERVICE.bot_account_id.write() = Some(parsed.recipient.id.clone());
    let cue = TypingCue {
        app: Arc::clone(app),
        service_url: mock.base.clone(),
        conversation: activity["conversation"].clone(),
        recipient: activity["recipient"].clone(),
    };
    TEAMS_ADAPTER_SERVICE
        .process_message(parsed, cue)
        .await
        .unwrap();
}

fn merge(mut base: Value, overrides: Value) -> Value {
    if let (Value::Object(base), Value::Object(overrides)) = (&mut base, overrides) {
        for (key, value) in overrides {
            base.insert(key, value);
        }
    }
    base
}

fn dm_activity(overrides: Value) -> Value {
    merge(
        json!({
            "id": "act-1",
            "type": "message",
            "text": "hello agent",
            "from": { "id": "29:bf-user", "aadObjectId": "aad-user-1", "name": "Jane Doe" },
            "recipient": { "id": "28:bot" },
            "conversation": { "id": "a:dm-conversation", "conversationType": "personal" },
        }),
        overrides,
    )
}

fn bot_mention() -> Value {
    json!({ "type": "mention", "mentioned": { "id": "28:bot", "name": "Agent" }, "text": "<at>Agent</at>" })
}

/// A reply in the reply chain rooted at 1755000000000 that mentions the bot.
fn channel_activity(overrides: Value) -> Value {
    merge(
        json!({
            "id": "act-42",
            "type": "message",
            "text": "<at>Agent</at> hello there",
            "entities": [bot_mention()],
            "from": { "id": "29:bf-user", "aadObjectId": "aad-user-1", "name": "Jane Doe" },
            "recipient": { "id": "28:bot" },
            "conversation": {
                "id": "19:chan@thread.tacv2;messageid=1755000000000",
                "conversationType": "channel",
            },
            "channelData": {
                "team": { "id": "19:team@thread.tacv2" },
                "channel": { "id": "19:chan@thread.tacv2" },
            },
        }),
        overrides,
    )
}

async fn insert_code(
    code: &str,
    kind: TeamsVerificationType,
    agent_id: &str,
    expires_in_secs: i64,
) {
    let mut row = NewTeamsVerificationCode::new(
        code,
        kind,
        "lens-1",
        "tenant-1",
        agent_id,
        Utc::now() + ChronoDuration::seconds(expires_in_secs),
    );
    row.agent_name = Some("Prism".to_string());
    crate::db::run(move |conn| {
        diesel::insert_into(tvc::table).values(&row).execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
}

async fn mappings() -> Vec<TeamsMapping> {
    crate::db::run(|conn| {
        Ok(tm::table
            .order(tm::created_at.asc())
            .select(TeamsMapping::as_select())
            .load(conn)?)
    })
    .await
    .unwrap()
}

async fn code_count() -> i64 {
    crate::db::run(|conn| Ok(tvc::table.count().get_result(conn)?))
        .await
        .unwrap()
}

async fn insert_thread(user_id: &str, agent_id: &str, external: Option<&str>) -> String {
    let mut row = NewConversationThread::new(agent_id, user_id);
    row.external_thread_id = external.map(str::to_string);
    let id = row.id.clone();
    crate::db::run(move |conn| {
        diesel::insert_into(ct::table).values(&row).execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
    id
}

fn signed(claims: Value) -> String {
    let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
    header.kid = Some("test-key".to_string());
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(TEST_KEY_PEM.as_bytes()).unwrap();
    jsonwebtoken::encode(&header, &claims, &key).unwrap()
}

fn claims(service_url: &str) -> Value {
    let now = Utc::now().timestamp();
    json!({
        "iss": "https://api.botframework.com",
        "aud": CLIENT_ID,
        "nbf": now - 10,
        "exp": now + 600,
        "serviceurl": service_url,
    })
}

// ============================================================================
// Inbound JWT validation
// ============================================================================

#[tokio::test]
async fn accepts_a_bot_framework_token_signed_by_a_published_key() {
    let mock = MockBotFramework::start().await;
    let app = mock.app();
    let token = signed(claims("https://smba.trafficmanager.net/emea/"));

    let service_url = app
        .validate_request(
            &format!("Bearer {token}"),
            &json!({ "serviceUrl": "https://smba.trafficmanager.net/emea" }),
        )
        .await
        .unwrap();

    assert_eq!(service_url, "https://smba.trafficmanager.net/emea");
}

#[tokio::test]
async fn answers_the_tokens_service_url_when_the_activity_names_none() {
    let mock = MockBotFramework::start().await;
    let app = mock.app();
    let token = signed(claims("https://smba.trafficmanager.net/emea/"));

    let service_url = app
        .validate_request(&format!("Bearer {token}"), &json!({}))
        .await
        .unwrap();

    assert_eq!(service_url, "https://smba.trafficmanager.net/emea/");
}

#[tokio::test]
async fn refuses_a_token_for_another_audience_issuer_or_service_url() {
    let mock = MockBotFramework::start().await;
    let app = mock.app();
    let activity = json!({ "serviceUrl": "https://smba.trafficmanager.net/emea/" });
    let now = Utc::now().timestamp();
    let cases = [
        merge(
            claims("https://smba.trafficmanager.net/emea/"),
            json!({ "aud": "another-app" }),
        ),
        merge(
            claims("https://smba.trafficmanager.net/emea/"),
            json!({ "iss": "https://attacker.example" }),
        ),
        merge(claims("https://attacker.example/"), json!({})),
        merge(
            claims("https://smba.trafficmanager.net/emea/"),
            json!({ "exp": now - 400 }),
        ),
        json!({ "iss": "https://api.botframework.com", "aud": CLIENT_ID, "exp": now + 600 }),
    ];
    for claims in cases {
        let token = signed(claims.clone());
        assert!(
            app.validate_request(&format!("Bearer {token}"), &activity)
                .await
                .is_err(),
            "accepted {claims}"
        );
    }
}

#[tokio::test]
async fn accepts_the_api_audiences_of_the_app_and_a_token_within_the_clock_tolerance() {
    let mock = MockBotFramework::start().await;
    let app = mock.app();
    let now = Utc::now().timestamp();
    for claims in [
        merge(
            claims(""),
            json!({ "aud": format!("api://botid-{CLIENT_ID}") }),
        ),
        merge(claims(""), json!({ "aud": format!("api://{CLIENT_ID}") })),
        merge(claims(""), json!({ "exp": now - 200 })),
    ] {
        let token = signed(claims.clone());
        assert!(
            app.validate_request(&format!("Bearer {token}"), &json!({}))
                .await
                .is_ok(),
            "refused {claims}"
        );
    }
}

#[tokio::test]
async fn refuses_a_token_signed_by_an_unpublished_key() {
    let mock = MockBotFramework::start().await;
    let app = mock.app();
    let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
    header.kid = Some("unknown-key".to_string());
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(TEST_KEY_PEM.as_bytes()).unwrap();
    let token = jsonwebtoken::encode(&header, &claims(""), &key).unwrap();

    assert!(
        app.validate_request(&format!("Bearer {token}"), &json!({}))
            .await
            .is_err()
    );
    assert!(app.validate_request("Bearer ", &json!({})).await.is_err());
}

// ============================================================================
// The bot's own port
// ============================================================================

async fn post_activity(base: &str, authorization: Option<&str>, body: &Value) -> reqwest::Response {
    let mut request = DIRECT_HTTP
        .post(format!("{base}{TEAMS_MESSAGING_PATH}"))
        .json(body);
    if let Some(authorization) = authorization {
        request = request.header("authorization", authorization);
    }
    request.send().await.unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn rejects_a_message_without_a_bot_framework_token_and_answers_404_elsewhere() {
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let base = format!("http://{}", TEAMS_ADAPTER_SERVICE.bound_addr().unwrap());

    let res = post_activity(&base, None, &json!({ "type": "message", "text": "hello" })).await;
    assert_eq!(res.status().as_u16(), 401);
    assert_eq!(
        res.json::<Value>().await.unwrap(),
        json!({ "error": "Missing authorization header" })
    );

    let res = post_activity(
        &base,
        Some("Bearer not-a-jwt"),
        &json!({ "type": "message" }),
    )
    .await;
    assert_eq!(res.status().as_u16(), 401);
    assert_eq!(
        res.json::<Value>().await.unwrap(),
        json!({ "error": "JWT validation failed" })
    );

    for (method, path) in [
        ("GET", "/"),
        ("GET", "/agents/teams/messages"),
        ("GET", "/agents/me"),
        ("POST", "/agents/chat"),
        ("GET", "/health"),
    ] {
        let res = DIRECT_HTTP
            .request(method.parse().unwrap(), format!("{base}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 404, "{method} {path}");
    }

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn acknowledges_a_valid_activity_and_ignores_group_chats_and_echoes_without_signaling_work() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let base = format!("http://{}", TEAMS_ADAPTER_SERVICE.bound_addr().unwrap());
    let token = format!("Bearer {}", signed(claims(&mock.base)));

    let group = dm_activity(json!({
        "serviceUrl": mock.base,
        "conversation": { "id": "19:group", "conversationType": "groupChat" },
    }));
    let res = post_activity(&base, Some(&token), &group).await;
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.text().await.unwrap(), "");

    let echo = dm_activity(json!({
        "serviceUrl": mock.base,
        "from": { "id": "28:bot" },
        "recipient": { "id": "28:bot" },
    }));
    let res = post_activity(&base, Some(&token), &echo).await;
    assert_eq!(res.status().as_u16(), 200);

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(mock.posted().is_empty());

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn answers_an_unlinked_personal_chat_with_a_typing_cue_and_link_guidance() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let base = format!("http://{}", TEAMS_ADAPTER_SERVICE.bound_addr().unwrap());
    let token = format!("Bearer {}", signed(claims(&mock.base)));

    let res = post_activity(
        &base,
        Some(&token),
        &dm_activity(json!({ "serviceUrl": mock.base })),
    )
    .await;
    assert_eq!(res.status().as_u16(), 200);
    mock.wait_for_posts(2).await;

    let posted = mock.posted();
    assert_eq!(posted[0].0, "a:dm-conversation");
    assert_eq!(posted[0].1["type"], "typing");
    // The typing cue goes out in the activity's own context, from its recipient.
    assert_eq!(posted[0].1["from"], json!({ "id": "28:bot" }));
    assert_eq!(
        mock.messages()[0].1,
        "Hi! I don't recognize this Microsoft Teams account yet. Open the Mirantis Agent Platform web app → \
         Channels → Microsoft Teams, generate a link code, and send the 6-character code to me here."
    );
    // A proactive send names the app as its sender and carries the bot's token.
    assert_eq!(
        posted[1].1["from"],
        json!({ "id": CLIENT_ID, "role": "bot" })
    );
    assert!(
        mock.state
            .lock()
            .requests
            .iter()
            .filter(|r| r.path.ends_with("/activities"))
            .all(|r| r.authorization.as_deref() == Some("Bearer bot-token"))
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn drops_activities_after_shutdown() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();

    let activity: TeamsActivity = serde_json::from_value(dm_activity(json!({}))).unwrap();
    TEAMS_ADAPTER_SERVICE.on_message(
        activity,
        TypingCue {
            app,
            service_url: mock.base.clone(),
            conversation: json!({ "id": "a:dm-conversation" }),
            recipient: json!({ "id": "28:bot" }),
        },
    );

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(mock.posted().is_empty());
}

// ============================================================================
// Starting and stopping
// ============================================================================

#[tokio::test]
#[serial_test::serial]
async fn idles_when_teams_env_is_not_configured() {
    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
    TEAMS_ADAPTER_SERVICE.reset_for_tests();
    crate::lib::teams_config::__reset_teams_config_for_tests();

    TEAMS_ADAPTER_SERVICE.initialize().await.unwrap();

    assert!(TEAMS_ADAPTER_SERVICE.current_app().is_none());
    assert!(
        !TEAMS_ADAPTER_SERVICE
            .is_user_connected("lens-1")
            .await
            .unwrap()
    );
}

#[tokio::test]
#[serial_test::serial]
async fn idles_when_the_bot_port_is_taken() {
    let mock = MockBotFramework::start().await;
    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
    TEAMS_ADAPTER_SERVICE.reset_for_tests();
    let squatter = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = squatter.local_addr().unwrap().port();

    TEAMS_ADAPTER_SERVICE
        .start(connection(), Ok(mock.app()), "127.0.0.1", port)
        .await;

    assert!(TEAMS_ADAPTER_SERVICE.current_app().is_none());
    assert!(TEAMS_ADAPTER_SERVICE.connection.read().is_none());
    assert!(
        !TEAMS_ADAPTER_SERVICE
            .is_user_connected("lens-1")
            .await
            .unwrap()
    );
}

#[tokio::test]
#[serial_test::serial]
async fn closes_the_bot_listener_and_a_later_start_opens_a_fresh_one() {
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let first = TEAMS_ADAPTER_SERVICE.bound_addr().unwrap();

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
    assert!(TEAMS_ADAPTER_SERVICE.bound_addr().is_none());
    assert!(
        DIRECT_HTTP
            .post(format!("http://{first}{TEAMS_MESSAGING_PATH}"))
            .send()
            .await
            .is_err()
    );

    connected(&mock).await;
    let second = TEAMS_ADAPTER_SERVICE.bound_addr().unwrap();
    let res = post_activity(&format!("http://{second}"), None, &json!({})).await;
    assert_eq!(res.status().as_u16(), 401);

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

// ============================================================================
// Personal chats
// ============================================================================

#[tokio::test]
#[serial_test::serial]
async fn links_a_dm_via_verification_code_and_captures_the_conversation_id_atomically() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_code("A1B2C3", TeamsVerificationType::Dm, &agent, 60).await;

    receive(&mock, &app, dm_activity(json!({ "text": "a1b2c3" }))).await;

    let linked = mappings().await;
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].teams_user_id.as_deref(), Some("aad-user-1"));
    assert_eq!(linked[0].lens_user_id.as_deref(), Some("lens-1"));
    assert_eq!(
        linked[0].dm_conversation_id.as_deref(),
        Some("a:dm-conversation")
    );
    assert_eq!(linked[0].tenant_id.as_deref(), Some("tenant-1"));
    assert_eq!(code_count().await, 0);
    assert_eq!(mock.typing_count(), 1);
    assert_eq!(
        mock.messages(),
        vec![(
            "a:dm-conversation".to_string(),
            "✅ Your Teams account is now linked to Lens Platform! You can now chat with your agent here."
                .to_string()
        )]
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn links_a_dm_via_a_verification_code_pasted_as_an_html_attachment() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_code("A1B2C3", TeamsVerificationType::Dm, &agent, 60).await;

    // Teams delivers a pasted message with empty `text` and the body only in a
    // text/html attachment, so the code has to be read from there.
    receive(
        &mock,
        &app,
        dm_activity(json!({
            "text": "",
            "attachments": [{ "contentType": "text/html", "content": "<p>a1b2c3</p>" }],
        })),
    )
    .await;

    assert_eq!(mappings().await.len(), 1);
    assert!(mock.messages()[0].1.starts_with("✅"));

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_dm_link_when_the_agent_already_has_a_channel_link() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_channel(
        &agent,
        "19:chan@thread.tacv2",
        None,
        Some("lens-1"),
        false,
        0,
    )
    .await;
    insert_code("A1B2C3", TeamsVerificationType::Dm, &agent, 60).await;

    receive(&mock, &app, dm_activity(json!({ "text": "a1b2c3" }))).await;

    assert_eq!(mappings().await.len(), 1);
    assert_eq!(code_count().await, 1);
    assert_eq!(
        mock.messages()[0].1,
        "❌ This agent is linked to one or more channels. Unlink those channels before linking a personal chat."
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_teams_account_that_is_already_linked() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_dm(&agent, "aad-user-1", "lens-2", "a:old", 0).await;
    insert_code("A1B2C3", TeamsVerificationType::Dm, &agent, 60).await;

    receive(&mock, &app, dm_activity(json!({ "text": "a1b2c3" }))).await;

    assert_eq!(
        mock.messages()[0].1,
        "❌ This Teams account is already linked to another Lens Platform user."
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn rejects_an_expired_dm_code_and_deletes_it() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_code("A1B2C3", TeamsVerificationType::Dm, &agent, -1).await;

    receive(&mock, &app, dm_activity(json!({ "text": "A1B2C3" }))).await;

    assert!(mock.messages()[0].1.contains("expired"));
    assert!(mappings().await.is_empty());
    assert_eq!(code_count().await, 0);

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn answers_an_unknown_code_as_invalid() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;

    receive(&mock, &app, dm_activity(json!({ "text": "A1B2C3" }))).await;

    assert_eq!(
        mock.messages()[0].1,
        "❌ Invalid code. Please generate a new code from the Mirantis Agent Platform web app."
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn ignores_a_personal_message_with_no_text_and_no_files() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;

    receive(&mock, &app, dm_activity(json!({ "text": "  " }))).await;

    assert!(mock.posted().is_empty());

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

// ============================================================================
// Inbound text
// ============================================================================

fn activity(value: Value) -> TeamsActivity {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn reads_inbound_text_without_the_bots_own_mention() {
    TEAMS_ADAPTER_SERVICE.reset_for_tests();
    *TEAMS_ADAPTER_SERVICE.bot_account_id.write() = Some("28:bot".to_string());

    let text = TEAMS_ADAPTER_SERVICE.extract_text(&activity(channel_activity(json!({
        "text": "<at>Agent</at> ask <at>Casey</at> for an update",
    }))));

    assert_eq!(text, "ask Casey for an update");
    TEAMS_ADAPTER_SERVICE.reset_for_tests();
}

#[tokio::test]
#[serial_test::serial]
async fn reads_a_pasted_code_that_inline_formatting_split_and_drops_the_bot_mention() {
    TEAMS_ADAPTER_SERVICE.reset_for_tests();
    *TEAMS_ADAPTER_SERVICE.bot_account_id.write() = Some("28:bot".to_string());

    // A bot mention precedes the code and bold splits it mid-token; both must
    // fall away so the six-hex code survives.
    let text = TEAMS_ADAPTER_SERVICE.extract_text(&activity(dm_activity(json!({
        "text": "",
        "entities": [{ "type": "mention", "mentioned": { "id": "28:bot", "name": "Prism" } }],
        "attachments": [{
            "contentType": "text/html",
            "content": "<p><at id=\"0\">Prism</at>&nbsp;a1<strong>b2</strong>c3</p>",
        }],
    }))));

    assert_eq!(text, "a1b2c3");
    assert!(TEAMS_ADAPTER_SERVICE.is_verification_code(&text));
    TEAMS_ADAPTER_SERVICE.reset_for_tests();
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_the_line_breaks_of_a_pasted_multi_line_message() {
    TEAMS_ADAPTER_SERVICE.reset_for_tests();

    let text = TEAMS_ADAPTER_SERVICE.extract_text(&activity(dm_activity(json!({
        "text": "",
        "attachments": [{ "contentType": "text/html", "content": "<p>line one</p><p>line two</p>" }],
    }))));

    assert_eq!(text, "line one\nline two");
}

#[tokio::test]
#[serial_test::serial]
async fn drops_the_bot_mention_but_keeps_other_participants_names_in_a_paste() {
    TEAMS_ADAPTER_SERVICE.reset_for_tests();
    *TEAMS_ADAPTER_SERVICE.bot_account_id.write() = Some("28:bot".to_string());

    let text = TEAMS_ADAPTER_SERVICE.extract_text(&activity(dm_activity(json!({
        "text": "",
        "entities": [{ "type": "mention", "mentioned": { "id": "28:bot", "name": "Prism" } }],
        "attachments": [{
            "contentType": "text/html",
            "content": "<p><at id=\"0\">Prism</at> ask <at id=\"1\">Casey</at> for an update</p>",
        }],
    }))));

    assert_eq!(text, "ask Casey for an update");
    TEAMS_ADAPTER_SERVICE.reset_for_tests();
}

#[test]
fn decodes_character_references_in_a_paste() {
    let service = TeamsAdapterService::new();
    let text = service.html_attachment_text(&activity(dm_activity(json!({
        "attachments": [{
            "contentType": "text/html",
            "content": "<div>a &lt;b&gt; &quot;c&quot; &#65;&#x42; &amp;amp;  \t d<br/>e</div>",
        }],
    }))));

    assert_eq!(text, "a <b> \"c\" AB &amp; d\ne");
}

#[test]
fn tags_a_channel_message_with_its_sender() {
    let service = TeamsAdapterService::new();
    assert_eq!(
        service.build_sender_tagged_content("aad-1", Some("Jane <Doe>: x"), "hi"),
        "<@aad-1:Jane Doe x>: hi"
    );
    assert_eq!(
        service.build_sender_tagged_content("aad-1", Some("<>"), "hi"),
        "<@aad-1>: hi"
    );
    assert_eq!(
        service.build_sender_tagged_content("aad-1", None, "hi"),
        "hi"
    );
    assert_eq!(service.strip_sender_tag("<@aad-1:Jane Doe>: hi"), "hi");
}

#[test]
fn marks_a_bot_framework_account_as_a_bot() {
    let service = TeamsAdapterService::new();
    assert_eq!(
        service.author_of("28:app-9", Some("Triage Bot")).kind,
        ThreadAuthorKind::Bot
    );
    assert_eq!(
        service.author_of("aad-user-1", None),
        ThreadAuthor {
            kind: ThreadAuthorKind::Person,
            name: "aad-user-1".to_string()
        }
    );
}

// ============================================================================
// Channels
// ============================================================================

#[tokio::test]
#[serial_test::serial]
async fn answers_an_unlinked_channel_with_threaded_link_guidance() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;

    receive(&mock, &app, channel_activity(json!({}))).await;

    assert_eq!(
        mock.messages(),
        vec![(
            "19:chan@thread.tacv2;messageid=1755000000000".to_string(),
            "This channel isn't linked to an agent yet. Open the Mirantis Agent Platform web app → Channels → \
             Microsoft Teams, generate a channel link code, and @mention me with the 6-character code."
                .to_string()
        )]
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn links_a_channel_via_verification_code_named_from_the_team_channel_list() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_code("D4E5F6", TeamsVerificationType::Channel, &agent, 60).await;
    mock.state.lock().team_conversations = Some(json!([
        { "id": "19:team@thread.tacv2" },
        { "id": "19:chan@thread.tacv2", "name": "Incidents" },
    ]));

    receive(
        &mock,
        &app,
        channel_activity(json!({ "text": "<at>Agent</at> D4E5F6" })),
    )
    .await;

    assert_eq!(
        mock.requests_to("/v3/teams/19:team@thread.tacv2/conversations"),
        1
    );
    let linked = mappings().await;
    assert_eq!(linked.len(), 1);
    assert_eq!(
        linked[0].channel_conversation_id.as_deref(),
        Some("19:chan@thread.tacv2")
    );
    assert_eq!(linked[0].channel_name.as_deref(), Some("Incidents"));
    assert_eq!(linked[0].lens_user_id.as_deref(), Some("lens-1"));
    assert_eq!(linked[0].teams_user_id, None);
    assert_eq!(
        mock.messages(),
        vec![(
            "19:chan@thread.tacv2;messageid=1755000000000".to_string(),
            "✅ Channel linked to Prism! Mention me anytime you need help.".to_string()
        )]
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_channel_link_when_the_agent_already_has_a_personal_link() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_dm(&agent, "aad-user-9", "lens-1", "a:dm", 0).await;
    insert_code("D4E5F6", TeamsVerificationType::Channel, &agent, 60).await;

    receive(
        &mock,
        &app,
        channel_activity(json!({ "text": "<at>Agent</at> D4E5F6" })),
    )
    .await;

    assert_eq!(mappings().await.len(), 1);
    assert_eq!(
        mock.messages()[0].1,
        "❌ This agent is linked to a personal chat. Unlink that personal chat before linking a channel."
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn names_the_general_channel_which_the_channel_list_shows_unnamed() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_code("D4E5F6", TeamsVerificationType::Channel, &agent, 60).await;
    mock.state.lock().team_conversations = Some(json!([{ "id": "19:team@thread.tacv2" }]));

    receive(
        &mock,
        &app,
        channel_activity(json!({
            "text": "<at>Agent</at> D4E5F6",
            "conversation": {
                "id": "19:team@thread.tacv2;messageid=1755000000000",
                "conversationType": "channel",
            },
            "channelData": {
                "team": { "id": "19:team@thread.tacv2" },
                "channel": { "id": "19:team@thread.tacv2" },
            },
        })),
    )
    .await;

    let linked = mappings().await;
    assert_eq!(
        linked[0].channel_conversation_id.as_deref(),
        Some("19:team@thread.tacv2")
    );
    assert_eq!(linked[0].channel_name.as_deref(), Some("General"));

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn links_the_channel_unnamed_when_the_channel_list_lookup_fails() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_code("D4E5F6", TeamsVerificationType::Channel, &agent, 60).await;

    receive(
        &mock,
        &app,
        channel_activity(json!({ "text": "<at>Agent</at> D4E5F6" })),
    )
    .await;

    let linked = mappings().await;
    assert_eq!(
        linked[0].channel_conversation_id.as_deref(),
        Some("19:chan@thread.tacv2")
    );
    assert_eq!(linked[0].channel_name, None);
    assert!(mock.messages()[0].1.contains("Channel linked"));

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

async fn messages_of(thread_id: &str) -> Vec<ConversationMessage> {
    let thread_id = thread_id.to_string();
    crate::db::run(move |conn| {
        Ok(cm::table
            .filter(cm::thread_id.eq(&thread_id))
            .select(ConversationMessage::as_select())
            .load(conn)?)
    })
    .await
    .unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn ignores_unmentioned_messages_outside_a_chain_the_bot_answered_in() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    let app = connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_channel(
        &agent,
        "19:chan@thread.tacv2",
        Some("Incidents"),
        Some("lens-1"),
        false,
        0,
    )
    .await;
    let reply = json!({ "text": "what time is it?", "entities": [] });

    // A reply in a chain with no thread.
    receive(&mock, &app, channel_activity(reply.clone())).await;
    // A top-level post.
    receive(
        &mock,
        &app,
        channel_activity(merge(reply.clone(), json!({ "id": "1755000000000" }))),
    )
    .await;
    // A link code that does not mention the bot.
    insert_code("D4E5F6", TeamsVerificationType::Channel, &agent, 60).await;
    receive(
        &mock,
        &app,
        channel_activity(json!({ "text": "D4E5F6", "entities": [] })),
    )
    .await;

    assert!(mock.posted().is_empty());
    assert_eq!(code_count().await, 1);
    let messages: i64 = crate::db::run(|conn| Ok(cm::table.count().get_result(conn)?))
        .await
        .unwrap();
    assert_eq!(messages, 0);

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

// ============================================================================
// Delivery
// ============================================================================

fn message(thread_id: &str, content: &str, triggered_by: MessageTrigger) -> DeliverableMessage {
    WithAttachments::bare(ConversationMessage {
        id: "msg-1".to_string(),
        thread_id: thread_id.to_string(),
        role: MessageRole::Agent,
        content: content.to_string(),
        triggered_by,
        trigger_name: None,
        tool_calls: None,
        blocks: None,
        sender_external_id: None,
        sender_name: None,
        external_message_id: None,
        is_compacted: false,
        internal_step: false,
        created_at: Utc::now(),
    })
}

fn teams_context(channel_id: Option<&str>, channel_thread_id: Option<&str>) -> ChannelContext {
    ChannelContext {
        channel: ChannelName::Teams,
        channel_id: channel_id.map(str::to_string),
        channel_thread_id: channel_thread_id.map(str::to_string),
        thread_id: "thread-1".to_string(),
        include_feedback: None,
    }
}

#[tokio::test]
#[serial_test::serial]
async fn delivers_nothing_before_start() {
    let mock = MockBotFramework::start().await;
    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
    TEAMS_ADAPTER_SERVICE.reset_for_tests();

    TEAMS_ADAPTER_SERVICE
        .deliver(
            "lens-1",
            &message("thread-1", "hi", MessageTrigger::UserInput),
            None,
        )
        .await
        .unwrap();

    assert!(mock.posted().is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn delivers_channel_scoped_as_a_threaded_reply() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    connected(&mock).await;

    TEAMS_ADAPTER_SERVICE
        .deliver(
            "lens-1",
            &message("thread-1", "the answer", MessageTrigger::UserInput),
            Some(&teams_context(
                Some("19:chan@thread.tacv2"),
                Some("1755000000000"),
            )),
        )
        .await
        .unwrap();

    assert_eq!(
        mock.messages(),
        vec![(
            "19:chan@thread.tacv2;messageid=1755000000000".to_string(),
            "the answer".to_string()
        )]
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn scopes_a_dm_turn_to_personal_conversations_only() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let agent = insert_agent("Prism").await;
    let thread = insert_thread("lens-1", &agent, Some("a:dm-1")).await;
    insert_dm(&agent, "aad-1", "lens-1", "a:dm-1", 20).await;
    insert_channel(
        &agent,
        "19:main@thread.tacv2",
        None,
        Some("lens-1"),
        true,
        10,
    )
    .await;

    TEAMS_ADAPTER_SERVICE
        .deliver(
            "lens-1",
            &message(&thread, "the answer", MessageTrigger::UserInput),
            Some(&teams_context(None, None)),
        )
        .await
        .unwrap();

    assert_eq!(
        mock.messages(),
        vec![("a:dm-1".to_string(), "the answer".to_string())]
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn broadcasts_autonomous_output_to_dm_mappings_plus_only_the_main_channel() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let agent = insert_agent("Prism").await;
    let thread = insert_thread("lens-1", &agent, None).await;
    insert_dm(&agent, "aad-1", "lens-1", "a:dm-1", 30).await;
    insert_channel(
        &agent,
        "19:old@thread.tacv2",
        None,
        Some("lens-1"),
        false,
        20,
    )
    .await;
    insert_channel(
        &agent,
        "19:main@thread.tacv2",
        None,
        Some("lens-1"),
        true,
        10,
    )
    .await;

    TEAMS_ADAPTER_SERVICE
        .deliver(
            "lens-1",
            &message(&thread, "the answer", MessageTrigger::Heartbeat),
            None,
        )
        .await
        .unwrap();

    let targets: Vec<String> = mock.messages().into_iter().map(|(c, _)| c).collect();
    assert_eq!(targets, vec!["a:dm-1", "19:main@thread.tacv2"]);
    assert_eq!(mock.messages()[0].1, "💓 **Heartbeat Alert**\n\nthe answer");

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn falls_back_to_the_oldest_channel_when_none_is_flagged_main() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_channel(
        &agent,
        "19:oldest@thread.tacv2",
        None,
        Some("lens-1"),
        false,
        20,
    )
    .await;
    insert_channel(
        &agent,
        "19:newer@thread.tacv2",
        None,
        Some("lens-1"),
        false,
        10,
    )
    .await;

    TEAMS_ADAPTER_SERVICE
        .deliver(
            "lens-1",
            &message("thread-1", "the answer", MessageTrigger::CronTask),
            None,
        )
        .await
        .unwrap();

    let targets: Vec<String> = mock.messages().into_iter().map(|(c, _)| c).collect();
    assert_eq!(targets, vec!["19:oldest@thread.tacv2"]);

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn retries_a_429_send_honoring_retry_after() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_dm(&agent, "aad-1", "lens-1", "a:dm-1", 0).await;
    mock.state
        .lock()
        .send_failures
        .push_back((429, Some("0".to_string())));

    TEAMS_ADAPTER_SERVICE
        .deliver(
            "lens-1",
            &message("thread-1", "the answer", MessageTrigger::UserInput),
            None,
        )
        .await
        .unwrap();

    assert_eq!(mock.posted().len(), 2);
    assert_eq!(mock.messages().len(), 2);

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn logs_instead_of_failing_when_a_send_fails_outright() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let agent = insert_agent("Prism").await;
    insert_dm(&agent, "aad-1", "lens-1", "a:dm-1", 0).await;
    mock.state.lock().send_failures.push_back((500, None));

    TEAMS_ADAPTER_SERVICE
        .deliver(
            "lens-1",
            &message("thread-1", "the answer", MessageTrigger::UserInput),
            None,
        )
        .await
        .unwrap();

    assert_eq!(mock.posted().len(), 1);

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[test]
fn describes_a_failed_send_by_its_name_and_status() {
    let shape = error_shape(&TeamsHttpError::sdk(429, None).into());
    assert_eq!(
        shape.get("error.name").map(String::as_str),
        Some("AxiosError")
    );
    assert_eq!(shape.get("error.status").map(String::as_str), Some("429"));

    let shape = error_shape(&anyhow::anyhow!("boom"));
    assert_eq!(shape.get("error.name").map(String::as_str), Some("Error"));
    assert_eq!(shape.get("error.status"), None);
}

#[test]
fn links_each_shared_file_to_the_download_route() {
    let service = TeamsAdapterService::new();
    let attachments = vec![AttachmentMeta {
        id: "att-1".to_string(),
        filename: "report [final].pdf".to_string(),
        media_type: "application/pdf".to_string(),
        size_bytes: 3,
        category: AttachmentCategory::Pdf,
        expired: false,
        inline: None,
    }];

    let text = service.with_attachment_notice("Here it is", Some(&attachments));

    let origin = CONFIG
        .public_url
        .clone()
        .unwrap_or_else(|| format!("http://localhost:{}", CONFIG.port));
    assert_eq!(
        text,
        format!(
            "Here it is\n\n📎 Shared file: [report final.pdf]({origin}/agents/attachments/att-1)"
        )
    );
    assert_eq!(
        service.with_attachment_notice("Here it is", Some(&[])),
        "Here it is"
    );
}

// ============================================================================
// Where a continuation goes
// ============================================================================

#[tokio::test]
#[serial_test::serial]
async fn continues_a_channel_thread_in_its_reply_chain_labelled_by_its_id() {
    let _db = test_db();
    let agent = insert_agent("Prism").await;
    let thread = insert_thread(
        "lens-1",
        &agent,
        Some("19:chan@thread.tacv2;messageid=1755000000000"),
    )
    .await;

    let destination = TEAMS_ADAPTER_SERVICE
        .thread_destination(&thread, None)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        destination,
        ChannelDestination {
            channel_id: Some("19:chan@thread.tacv2".to_string()),
            channel_thread_id: Some("1755000000000".to_string()),
            channel_label: Some(teams_channel_label("19:chan@thread.tacv2")),
        }
    );
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_a_dm_threads_continuation_in_the_personal_conversation() {
    let _db = test_db();
    let agent = insert_agent("Prism").await;
    let thread = insert_thread("lens-1", &agent, Some("a:dm-1")).await;
    insert_dm(&agent, "aad-1", "lens-1", "a:dm-1", 0).await;

    let destination = TEAMS_ADAPTER_SERVICE
        .thread_destination(&thread, None)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        destination,
        ChannelDestination {
            channel_id: Some("a:dm-1".to_string()),
            channel_thread_id: None,
            channel_label: Some(teams_channel_label("a:dm-1")),
        }
    );

    let unresolved = TEAMS_ADAPTER_SERVICE
        .thread_destination("missing-thread", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unresolved, ChannelDestination::default());
}

#[tokio::test]
#[serial_test::serial]
async fn picks_the_personal_conversation_then_the_main_channel_by_default() {
    let _db = test_db();
    let agent = insert_agent("Prism").await;

    assert_eq!(
        TEAMS_ADAPTER_SERVICE
            .default_destination(&agent, "lens-1")
            .await
            .unwrap()
            .unwrap(),
        None
    );

    insert_channel(
        &agent,
        "19:main@thread.tacv2",
        None,
        Some("lens-1"),
        false,
        10,
    )
    .await;
    // A Teams context without a channel id is DM-scoped and delivers nothing in
    // Team Mode, so the main channel names its id.
    assert_eq!(
        TEAMS_ADAPTER_SERVICE
            .default_destination(&agent, "lens-1")
            .await
            .unwrap()
            .unwrap(),
        Some(DefaultDestination {
            destination: ChannelDestination {
                channel_id: Some("19:main@thread.tacv2".to_string()),
                ..Default::default()
            },
            thread_key: "19:main@thread.tacv2".to_string(),
        })
    );

    insert_dm(&agent, "aad-1", "lens-1", "a:dm-1", 0).await;
    assert_eq!(
        TEAMS_ADAPTER_SERVICE
            .default_destination(&agent, "lens-1")
            .await
            .unwrap()
            .unwrap(),
        Some(DefaultDestination {
            destination: ChannelDestination::default(),
            thread_key: "a:dm-1".to_string(),
        })
    );
}

// ============================================================================
// Posting to a linked target
// ============================================================================

fn release() -> LinkedTarget {
    LinkedTarget {
        key: "teams:19:release@thread.tacv2".to_string(),
        platform: ChatPlatform::Teams,
        kind: LinkedTargetKind::Channel,
        conversation_id: "19:release@thread.tacv2".to_string(),
        name: Some("Release".to_string()),
        is_main: false,
        dm_user_id: None,
    }
}

fn personal_chat(dm_user_id: Option<&str>) -> LinkedTarget {
    LinkedTarget {
        key: "teams:a:personal-chat".to_string(),
        kind: LinkedTargetKind::Dm,
        conversation_id: "a:personal-chat".to_string(),
        dm_user_id: dm_user_id.map(str::to_string),
        ..release()
    }
}

/// The adapter connected to a mock that knows Alice, with `#Release` linked for user-1.
async fn posting_setup() -> MockBotFramework {
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    mock.state.lock().members.insert(
        ALICE.to_string(),
        json!({ "id": "29:alice", "name": "Alice <Example>", "aadObjectId": ALICE }),
    );
    let agent = insert_agent("Prism").await;
    insert_channel(
        &agent,
        "19:release@thread.tacv2",
        Some("Release"),
        Some("user-1"),
        false,
        0,
    )
    .await;
    mock
}

async fn post(
    target: &LinkedTarget,
    text: &str,
    thread: Option<&str>,
) -> anyhow::Result<PostedMessage> {
    TEAMS_ADAPTER_SERVICE
        .post_to_target(target, text, thread)
        .await
        .unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn lists_each_linked_channel_and_dm_of_the_agent_and_marks_the_main_channel() {
    let _db = test_db();
    let agent = insert_agent("Prism").await;
    insert_channel(
        &agent,
        "19:general@thread.tacv2",
        Some("General"),
        None,
        false,
        30,
    )
    .await;
    insert_channel(
        &agent,
        "19:release@thread.tacv2",
        Some("Release"),
        None,
        true,
        20,
    )
    .await;
    insert_dm(&agent, ALICE, "user-1", "a:personal-chat", 10).await;

    let targets = TEAMS_ADAPTER_SERVICE
        .list_linked_targets(&agent)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        serde_json::to_value(&targets).unwrap(),
        json!([
            { "key": "teams:19:general@thread.tacv2", "platform": "teams", "kind": "channel", "conversationId": "19:general@thread.tacv2", "name": "General", "isMain": false },
            { "key": "teams:19:release@thread.tacv2", "platform": "teams", "kind": "channel", "conversationId": "19:release@thread.tacv2", "name": "Release", "isMain": true },
            { "key": "teams:a:personal-chat", "platform": "teams", "kind": "dm", "conversationId": "a:personal-chat", "name": format!("<@{ALICE}>"), "isMain": false, "dmUserId": "user-1" },
        ])
    );
}

#[tokio::test]
#[serial_test::serial]
async fn sends_a_mention_as_an_at_tag_with_a_matching_entity_and_returns_the_message_id() {
    let _db = test_db();
    let mock = posting_setup().await;

    let result = post(
        &release(),
        &format!("Release v2 is out. <@{ALICE}:Alice> please announce it, <@{ALICE}>."),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result,
        PostedMessage {
            message_id: "1712345678901".to_string(),
            history: Some(PostedHistory {
                user_id: "user-1".to_string(),
                thread_key: "19:release@thread.tacv2;messageid=1712345678901".to_string(),
                ..PostedHistory::default()
            }),
        }
    );
    assert_eq!(
        mock.requests_to(&format!(
            "/v3/conversations/19:release@thread.tacv2/members/{ALICE}"
        )),
        1
    );
    let posted = mock.posted();
    assert_eq!(posted[0].0, "19:release@thread.tacv2");
    assert_eq!(
        posted[0].1["text"],
        "Release v2 is out. <at>Alice Example</at> please announce it, <at>Alice Example</at>."
    );
    assert_eq!(
        posted[0].1["entities"],
        json!([{
            "type": "mention",
            "mentioned": { "id": "29:alice", "name": "Alice Example", "role": "user" },
            "text": "<at>Alice Example</at>",
        }])
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn replies_into_a_reply_chain_keyed_by_its_root() {
    let _db = test_db();
    let mock = posting_setup().await;

    let result = post(&release(), "Follow-up", Some("1712345678000"))
        .await
        .unwrap();

    assert_eq!(
        mock.posted()[0].0,
        "19:release@thread.tacv2;messageid=1712345678000"
    );
    assert_eq!(
        result.history,
        Some(PostedHistory {
            user_id: "user-1".to_string(),
            thread_key: "19:release@thread.tacv2;messageid=1712345678000".to_string(),
            ..PostedHistory::default()
        })
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn names_the_personal_chats_thread_for_a_dm_post_and_no_thread_for_an_unowned_channel() {
    let _db = test_db();
    let _mock = posting_setup().await;

    let result = post(&personal_chat(Some("user-2")), "The deploy failed.", None)
        .await
        .unwrap();
    assert_eq!(
        result.history,
        Some(PostedHistory {
            user_id: "user-2".to_string(),
            thread_key: "a:personal-chat".to_string(),
            ..PostedHistory::default()
        })
    );

    let unlinked = LinkedTarget {
        conversation_id: "19:other@thread.tacv2".to_string(),
        ..release()
    };
    let result = post(&unlinked, "Hi", None).await.unwrap();
    assert_eq!(result.history, None);

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn removes_an_at_tag_the_agent_wrote() {
    let _db = test_db();
    let mock = posting_setup().await;

    post(&release(), "Hello <at>General</at> team", None)
        .await
        .unwrap();

    let posted = mock.posted();
    assert_eq!(posted[0].1["text"], "Hello General team");
    assert_eq!(posted[0].1.get("entities"), None);

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

fn refusal(result: anyhow::Result<PostedMessage>) -> SendRefusedError {
    result
        .unwrap_err()
        .downcast::<SendRefusedError>()
        .expect("a refusal")
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_mention_of_a_person_outside_the_conversation_and_names_the_person() {
    let _db = test_db();
    let mock = posting_setup().await;

    let refused = refusal(post(&release(), &format!("Ping <@{BOB}:Bob Example>"), None).await);

    assert_eq!(refused.code, "not_member");
    assert!(refused.message.starts_with(&format!(
        "Bob Example (<@{BOB}>) is not a member of #Release"
    )));
    assert!(mock.posted().is_empty());

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_mention_that_is_not_a_teams_user_mention() {
    let _db = test_db();
    let mock = posting_setup().await;

    for token in ["<@29:1abc:Bob>", "<@U0ALICE>", "<@>"] {
        let refused = refusal(post(&release(), &format!("Ping {token}"), None).await);
        assert_eq!(refused.code, "bad_mention");
        assert!(
            refused.message.contains("is not a Teams user mention"),
            "{token}"
        );
    }
    assert!(mock.posted().is_empty());

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn passes_a_member_lookup_or_send_that_fails_for_another_reason_on_to_the_caller() {
    let _db = test_db();
    let mock = posting_setup().await;

    mock.state.lock().member_status = Some(500);
    let err = post(&release(), &format!("Ping <@{ALICE}>"), None)
        .await
        .unwrap_err();
    assert_eq!(error_status(&err), Some(500));

    mock.state.lock().send_failures.push_back((403, None));
    let err = post(&release(), "Hi", None).await.unwrap_err();
    assert_eq!(error_status(&err), Some(403));

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_bad_thread_id_and_a_thread_in_a_personal_chat() {
    let _db = test_db();
    let mock = posting_setup().await;

    let refused = refusal(post(&release(), "Hi", Some("1712345678.000100")).await);
    assert_eq!(refused.code, "bad_thread");
    assert!(refused.message.contains("is not a Teams thread id"));

    let refused = refusal(post(&personal_chat(None), "Hi", Some("1712345678901")).await);
    assert_eq!(refused.code, "bad_thread");
    assert!(refused.message.contains("has no threads"));
    assert!(mock.posted().is_empty());

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_when_teams_is_not_connected() {
    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
    TEAMS_ADAPTER_SERVICE.reset_for_tests();

    let refused = refusal(post(&release(), "Hi", None).await);

    assert_eq!(refused.code, "not_connected");
    assert!(refused.message.contains("Microsoft Teams is not connected"));
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_user_connected_while_any_mapping_exists() {
    let _db = test_db();
    let mock = MockBotFramework::start().await;
    connected(&mock).await;
    let agent = insert_agent("Prism").await;

    assert!(
        !TEAMS_ADAPTER_SERVICE
            .is_user_connected("lens-1")
            .await
            .unwrap()
    );
    insert_dm(&agent, "aad-1", "lens-1", "a:dm-1", 0).await;
    assert!(
        TEAMS_ADAPTER_SERVICE
            .is_user_connected("lens-1")
            .await
            .unwrap()
    );

    TEAMS_ADAPTER_SERVICE.shutdown().await.unwrap();
    assert!(
        !TEAMS_ADAPTER_SERVICE
            .is_user_connected("lens-1")
            .await
            .unwrap()
    );
}

#[test]
fn reads_the_cloud_names_and_refuses_an_unknown_one() {
    assert_eq!(
        TeamsCloud::from_name("Public").unwrap(),
        TeamsCloud::public()
    );
    assert_eq!(
        TeamsCloud::from_name("USGov").unwrap().token_issuer,
        "https://api.botframework.us"
    );
    assert_eq!(
        TeamsCloud::from_name("mars").unwrap_err().to_string(),
        "Unknown cloud environment: 'mars'. Valid values are: Public, USGov, USGovDoD, China."
    );
    assert_eq!(
        TeamsCloud::public().keys_url(),
        "https://login.botframework.com/v1/.well-known/keys"
    );
}

#[tokio::test]
async fn rejects_a_reply_root_that_is_not_a_message_id() {
    let mock = MockBotFramework::start().await;
    let app = mock.app();

    let err = app
        .reply(
            "19:chan@thread.tacv2",
            "abc",
            &TeamsOutboundActivity::message("hi"),
        )
        .await
        .unwrap_err();

    assert_eq!(
        err.to_string(),
        "Invalid messageId \"abc\": must be a non-zero numeric value"
    );
    assert!(mock.posted().is_empty());
}
