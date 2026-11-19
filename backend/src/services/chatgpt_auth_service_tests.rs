//! Sign in with ChatGPT against a local token endpoint that answers what each test scripts.

use std::collections::VecDeque;

use axum::Router;
use axum::extract::State as AxumState;
use axum::response::IntoResponse;
use axum::routing::post;

use super::*;
use crate::db::testing::test_db;

/// One scripted token response: the status and the JSON body.
type Scripted = (u16, Value);

#[derive(Clone, Default)]
struct TokenServer {
    responses: Arc<Mutex<VecDeque<Scripted>>>,
    forms: Arc<Mutex<Vec<IndexMap<String, String>>>>,
}

async fn token(
    AxumState(server): AxumState<TokenServer>,
    body: String,
) -> axum::response::Response {
    let form: IndexMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    server.forms.lock().push(form);
    let (status, body) = server
        .responses
        .lock()
        .pop_front()
        .unwrap_or((500, json!({})));
    (
        axum::http::StatusCode::from_u16(status).unwrap(),
        axum::Json(body),
    )
        .into_response()
}

async fn service(responses: Vec<Scripted>) -> (ChatGptAuthService, TokenServer) {
    let server = TokenServer {
        responses: Arc::new(Mutex::new(responses.into())),
        ..TokenServer::default()
    };
    let app = Router::new()
        .route("/token", post(token))
        .with_state(server.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        ChatGptAuthService::with_token_url(&format!("http://{address}/token")),
        server,
    )
}

fn id_token(email: &str) -> String {
    let payload = URL_SAFE_NO_PAD.encode(json!({ "email": email }).to_string());
    format!("header.{payload}.signature")
}

fn query(url: &str) -> IndexMap<String, String> {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

fn callback(state: &str) -> ChatGptCallbackParams {
    ChatGptCallbackParams {
        code: Some("code-1".into()),
        state: Some(state.into()),
        client_id: Some("oaiapp_issued".into()),
        ..ChatGptCallbackParams::default()
    }
}

fn status_of(err: &anyhow::Error) -> u16 {
    err.downcast_ref::<ChatGptAuthError>().unwrap().status_code
}

#[tokio::test]
#[serial_test::serial]
async fn signs_in_with_dynamic_registration_and_keeps_the_issued_client() {
    let _db = test_db();
    let (auth, server) = service(vec![(
        200,
        json!({
            "access_token": "at-1",
            "refresh_token": "rt-1",
            "expires_in": 3600,
            "scope": "openid chatgpt.tokens.use.direct",
            "id_token": id_token("person@example.com"),
            "client_id": "oaiapp_issued",
        }),
    )])
    .await;

    let url = auth
        .start_sign_in("http://127.0.0.1:3003/agents/chatgpt-auth/callback")
        .await
        .unwrap();
    let params = query(&url);
    assert!(url.starts_with(CHATGPT_AUTHORIZE_URL));
    assert_eq!(params["client_id"], CHATGPT_DYNAMIC_CLIENT_ID);
    assert_eq!(params["agent_name_hint"], "Prism");
    assert!(params["ext_agent_host_id"].starts_with("urn:uuid:"));
    assert_eq!(params["scope"], CHATGPT_OAUTH_SCOPES);
    assert_eq!(params["code_challenge_method"], "S256");

    let status = auth
        .handle_callback(callback(&params["state"]))
        .await
        .unwrap();
    assert!(status.signed_in);
    assert_eq!(status.email.as_deref(), Some("person@example.com"));

    let form = server.forms.lock()[0].clone();
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["client_id"], "oaiapp_issued");
    assert_eq!(
        code_challenge(&form["code_verifier"]),
        params["code_challenge"]
    );
    assert_eq!(
        RUNTIME_STATE_SERVICE
            .get(CHATGPT_AUTH_CLIENT_ID)
            .await
            .unwrap()
            .as_deref(),
        Some("oaiapp_issued")
    );
    assert_eq!(auth.get_access_token(false).await.unwrap(), "at-1");

    // The next sign-in uses the saved client and no registration hint.
    let next = query(&auth.start_sign_in("http://cb").await.unwrap());
    assert_eq!(next["client_id"], "oaiapp_issued");
    assert!(!next.contains_key("agent_name_hint"));
    assert_eq!(next["ext_agent_host_id"], params["ext_agent_host_id"]);
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_an_unknown_state_a_provider_error_and_a_missing_scope() {
    let _db = test_db();
    let (auth, _server) = service(vec![(
        200,
        json!({ "access_token": "at", "scope": "openid", "client_id": "oaiapp_x" }),
    )])
    .await;
    let err = auth.handle_callback(callback("nope")).await.unwrap_err();
    assert_eq!(status_of(&err), 400);

    let state = query(&auth.start_sign_in("http://cb").await.unwrap())["state"].clone();
    let err = auth
        .handle_callback(ChatGptCallbackParams {
            error: Some("access_denied".into()),
            ..callback(&state)
        })
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "Sign in with ChatGPT was not completed: access_denied"
    );
    // An attempt is used once.
    assert_eq!(
        status_of(&auth.handle_callback(callback(&state)).await.unwrap_err()),
        400
    );

    let state = query(&auth.start_sign_in("http://cb").await.unwrap())["state"].clone();
    let err = auth.handle_callback(callback(&state)).await.unwrap_err();
    assert_eq!(status_of(&err), 403);
    assert!(!auth.is_signed_in());
}

#[tokio::test]
#[serial_test::serial]
async fn a_sign_out_cancels_a_sign_in_in_progress() {
    let _db = test_db();
    let (auth, _server) = service(vec![]).await;
    let state = query(&auth.start_sign_in("http://cb").await.unwrap())["state"].clone();
    let status = auth.sign_out().await.unwrap();
    assert!(!status.signed_in);
    assert_eq!(
        status_of(&auth.handle_callback(callback(&state)).await.unwrap_err()),
        400
    );
}

#[tokio::test]
#[serial_test::serial]
async fn refreshes_an_expiring_token_once_for_concurrent_callers() {
    let _db = test_db();
    let (auth, server) = service(vec![(
        200,
        json!({ "access_token": "at-2", "expires_in": 3600 }),
    )])
    .await;
    RUNTIME_STATE_SERVICE
        .set(CHATGPT_AUTH_CLIENT_ID, "oaiapp_saved")
        .await
        .unwrap();
    let stored = json!({
        "accessToken": "at-1",
        "refreshToken": "rt-1",
        "expiresAt": now_ms() + 1_000,
        "scope": null,
        "email": "person@example.com",
    });
    RUNTIME_STATE_SERVICE
        .set(CHATGPT_AUTH_TOKENS, &stored.to_string())
        .await
        .unwrap();
    auth.load().await;
    assert!(auth.is_signed_in());

    let (a, b) = tokio::join!(auth.get_access_token(false), auth.get_access_token(false));
    assert_eq!(
        (a.unwrap(), b.unwrap()),
        ("at-2".to_string(), "at-2".to_string())
    );
    let forms = server.forms.lock().clone();
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0]["grant_type"], "refresh_token");
    assert_eq!(forms[0]["client_id"], "oaiapp_saved");
    assert_eq!(forms[0]["refresh_token"], "rt-1");

    let saved = parse_stored_tokens(
        RUNTIME_STATE_SERVICE
            .get(CHATGPT_AUTH_TOKENS)
            .await
            .unwrap()
            .as_deref(),
    )
    .unwrap();
    assert_eq!(saved.refresh_token.as_deref(), Some("rt-1"));
    assert_eq!(saved.email.as_deref(), Some("person@example.com"));
}

#[tokio::test]
#[serial_test::serial]
async fn a_refused_refresh_signs_out() {
    let _db = test_db();
    let (auth, _server) = service(vec![(400, json!({ "error": "invalid_grant" }))]).await;
    RUNTIME_STATE_SERVICE
        .set(CHATGPT_AUTH_CLIENT_ID, "oaiapp_saved")
        .await
        .unwrap();
    let stored =
        json!({ "accessToken": "at-1", "refreshToken": "rt-1", "expiresAt": now_ms() + 3_600_000 });
    RUNTIME_STATE_SERVICE
        .set(CHATGPT_AUTH_TOKENS, &stored.to_string())
        .await
        .unwrap();
    auth.load().await;

    assert_eq!(auth.get_access_token(false).await.unwrap(), "at-1");
    let err = auth.get_access_token(true).await.unwrap_err();
    assert_eq!(
        err.to_string(),
        "ChatGPT token refresh failed (invalid_grant). Please sign in again."
    );
    assert!(!auth.is_signed_in());
    assert!(
        RUNTIME_STATE_SERVICE
            .get(CHATGPT_AUTH_TOKENS)
            .await
            .unwrap()
            .is_none()
    );
}

#[test]
fn reads_the_email_from_an_id_token_and_ignores_a_malformed_one() {
    assert_eq!(
        email_from_id_token(Some(&id_token(" person@example.com "))).as_deref(),
        Some("person@example.com")
    );
    assert_eq!(email_from_id_token(Some("not-a-jwt")), None);
    assert_eq!(email_from_id_token(None), None);
}
