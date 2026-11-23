//! What the router service does with each envelope, against a recording
//! adapter and the real `pending_work` table.

use super::*;
use crate::services::slack_router_envelope::LinkOp;
use tokio::sync::Notify;

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<String>>,
    /// Answer of `ready` and `connect`.
    connected: AtomicBool,
    /// Holds `handle` until notified, when set.
    hold: Option<Arc<Notify>>,
    /// Holds `link` until notified, when set.
    hold_link: Option<Arc<Notify>>,
    fail_link: AtomicBool,
    /// Hand the event off from `handle`.
    hands_off: bool,
}

#[async_trait]
impl SlackRouterHandlers for Recorder {
    async fn connect(&self, team_id: &str) -> anyhow::Result<bool> {
        self.calls.lock().push(format!("connect:{team_id}"));
        Ok(self.connected.load(Ordering::SeqCst))
    }
    async fn disconnect(&self) -> anyhow::Result<()> {
        self.calls.lock().push("disconnect".into());
        Ok(())
    }
    async fn link(&self, team_id: &str, link: &RoutedLink) -> anyhow::Result<()> {
        if let Some(hold) = &self.hold_link {
            hold.notified().await;
        }
        if self.fail_link.swap(false, Ordering::SeqCst) {
            anyhow::bail!("database locked");
        }
        self.calls.lock().push(format!(
            "link:{team_id}:{}:{}",
            link.type_str(),
            link.op().as_str()
        ));
        Ok(())
    }
    async fn ready(&self, team_id: &str) -> anyhow::Result<bool> {
        self.calls.lock().push(format!("ready:{team_id}"));
        Ok(self.connected.load(Ordering::SeqCst))
    }
    async fn handle(&self, envelope: SlackEnvelope, hand_off: HandOff) -> anyhow::Result<()> {
        if let Some(hold) = &self.hold {
            hold.notified().await;
        }
        if self.hands_off {
            hand_off.hand_off();
        }
        self.calls
            .lock()
            .push(format!("handle:{}", envelope.event_id));
        Ok(())
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn event(id: &str) -> Value {
    json!({
        "version": 1, "eventId": id, "sentAt": now_iso(), "teamId": "T1",
        "kind": "slack", "person": null, "route": "mention", "payloadType": "event",
        "payload": { "type": "app_mention", "channel": "C1", "user": "U1", "text": "hi", "ts": "1.2" },
    })
}

fn link(id: &str) -> Value {
    json!({
        "version": 1, "eventId": id, "sentAt": now_iso(), "teamId": "T1", "kind": "link",
        "link": { "op": "add", "type": "channel", "channelId": "C1", "personId": "p1" },
    })
}

fn service(recorder: Arc<Recorder>) -> SlackRouterService {
    let service = SlackRouterService::new();
    service.set_handlers(Some(recorder));
    service
}

fn connected(mut recorder: Recorder) -> Arc<Recorder> {
    recorder.connected = AtomicBool::new(true);
    Arc::new(recorder)
}

async fn rows() -> Vec<String> {
    PENDING_WORK_SERVICE.flush().await;
    PENDING_WORK_SERVICE
        .rows(PendingWorkKind::RoutedEvent)
        .await
        .unwrap()
        .into_iter()
        .map(|item| item.key)
        .collect()
}

async fn settle(recorder: &Recorder, call: &str) {
    for _ in 0..200 {
        if recorder.calls.lock().iter().any(|c| c == call) {
            PENDING_WORK_SERVICE.flush().await;
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("{call} never happened: {:?}", recorder.calls.lock());
}

#[tokio::test]
#[serial_test::serial]
async fn accepts_a_slack_event_records_it_and_handles_it_after_the_answer() {
    let _db = crate::db::testing::test_db();
    let hold = Arc::new(Notify::new());
    let recorder = connected(Recorder {
        hold: Some(hold.clone()),
        ..Recorder::default()
    });
    let service = service(recorder.clone());

    assert_eq!(
        service.accept(event("Ev1")).await.unwrap(),
        RouterOutcome::Accepted
    );
    assert_eq!(rows().await, vec!["Ev1".to_string()]);
    hold.notify_one();
    settle(&recorder, "handle:Ev1").await;
    assert!(rows().await.is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn ends_the_record_at_the_hand_off() {
    let _db = crate::db::testing::test_db();
    let hold = Arc::new(Notify::new());
    let recorder = connected(Recorder {
        hold: Some(hold.clone()),
        hands_off: true,
        ..Recorder::default()
    });
    let service = service(recorder.clone());
    service.accept(event("Ev1")).await.unwrap();
    hold.notify_one();
    settle(&recorder, "handle:Ev1").await;
    assert!(rows().await.is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn answers_a_repeated_or_recorded_event_without_handling_it_again() {
    let _db = crate::db::testing::test_db();
    let recorder = connected(Recorder::default());
    let service = service(recorder.clone());
    assert_eq!(
        service.accept(event("Ev1")).await.unwrap(),
        RouterOutcome::Accepted
    );
    settle(&recorder, "handle:Ev1").await;
    assert_eq!(
        service.accept(event("Ev1")).await.unwrap(),
        RouterOutcome::Dropped
    );

    // A row left by a delivery before a restart.
    PENDING_WORK_SERVICE
        .begin(PendingWorkKind::RoutedEvent, "Ev2", json!({}))
        .await
        .unwrap();
    assert_eq!(
        service.accept(event("Ev2")).await.unwrap(),
        RouterOutcome::Dropped
    );
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let handled: Vec<String> = recorder
        .calls
        .lock()
        .iter()
        .filter(|c| c.starts_with("handle:"))
        .cloned()
        .collect();
    assert_eq!(handled, vec!["handle:Ev1".to_string()]);
}

#[tokio::test]
#[serial_test::serial]
async fn answers_a_retry_sent_during_an_attempt_with_that_attempts_outcome() {
    let _db = crate::db::testing::test_db();
    let hold = Arc::new(Notify::new());
    let recorder = Arc::new(Recorder {
        hold_link: Some(hold.clone()),
        fail_link: AtomicBool::new(true),
        ..Recorder::default()
    });
    let service = Arc::new(service(recorder.clone()));
    let first = tokio::spawn({
        let service = service.clone();
        async move { service.accept(link("Ev1")).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let retry = tokio::spawn({
        let service = service.clone();
        async move { service.accept(link("Ev1")).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    hold.notify_waiters();
    // Both get the failure, so the router retries.
    assert!(first.await.unwrap().is_err());
    assert!(retry.await.unwrap().is_err());

    // The next retry applies the link.
    hold.notify_one();
    let applied = service.accept(link("Ev1"));
    assert_eq!(applied.await.unwrap(), RouterOutcome::Accepted);
    assert_eq!(
        recorder.calls.lock().as_slice(),
        &["link:T1:channel:add".to_string()]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn drops_an_envelope_sent_more_than_five_minutes_from_this_clock() {
    let _db = crate::db::testing::test_db();
    let recorder = connected(Recorder::default());
    let service = service(recorder.clone());
    let mut old = link("Ev1");
    old["sentAt"] = json!((chrono::Utc::now() - chrono::Duration::minutes(6)).to_rfc3339());
    assert_eq!(service.accept(old).await.unwrap(), RouterOutcome::Dropped);
    assert!(recorder.calls.lock().is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_an_invalid_envelope_and_answers_unavailable_without_handlers() {
    let _db = crate::db::testing::test_db();
    let recorder = connected(Recorder::default());
    let service = service(recorder.clone());
    assert_eq!(
        service.accept(json!({ "kind": "slack" })).await.unwrap(),
        RouterOutcome::Invalid
    );
    service.set_handlers(None);
    assert_eq!(
        service.accept(event("Ev1")).await.unwrap(),
        RouterOutcome::Unavailable
    );
}

#[tokio::test]
#[serial_test::serial]
async fn asks_for_a_retry_while_no_app_runs_for_the_workspace() {
    let _db = crate::db::testing::test_db();
    let recorder = Arc::new(Recorder::default());
    let service = service(recorder.clone());
    assert_eq!(
        service.accept(event("Ev1")).await.unwrap(),
        RouterOutcome::Unavailable
    );
    assert!(rows().await.is_empty());
    let connect = json!({
        "version": 1, "eventId": "Ev2", "sentAt": now_iso(), "teamId": "T1", "kind": "connected",
        "workspace": { "teamId": "T1", "teamName": "Acme", "botUserId": "UBOT", "botId": "B1" },
    });
    assert_eq!(
        service.accept(connect.clone()).await.unwrap(),
        RouterOutcome::Unavailable
    );
    recorder.connected.store(true, Ordering::SeqCst);
    assert_eq!(
        service.accept(connect).await.unwrap(),
        RouterOutcome::Accepted
    );
    assert_eq!(
        service.accept(event("Ev1")).await.unwrap(),
        RouterOutcome::Accepted
    );
    let _ = LinkOp::Add;
}

#[tokio::test]
#[serial_test::serial]
async fn resumes_the_events_a_restart_interrupted_and_ends_the_ones_it_cannot_read() {
    let _db = crate::db::testing::test_db();
    let recorder = connected(Recorder::default());
    let service = service(recorder.clone());
    let RouterEnvelope::Slack(envelope) = parse_router_envelope(&event("Ev1")).unwrap() else {
        panic!("not a slack envelope");
    };
    PENDING_WORK_SERVICE
        .begin(PendingWorkKind::RoutedEvent, "Ev1", envelope.to_value())
        .await
        .unwrap();
    PENDING_WORK_SERVICE
        .begin(
            PendingWorkKind::RoutedEvent,
            "Ev2",
            json!({ "kind": "nonsense" }),
        )
        .await
        .unwrap();
    let items = PENDING_WORK_SERVICE
        .rows(PendingWorkKind::RoutedEvent)
        .await
        .unwrap();
    service.resume(items).await.unwrap();
    settle(&recorder, "handle:Ev1").await;
    assert!(rows().await.is_empty());
    // A resumed event is not handled again when the router sends it.
    assert_eq!(
        service.accept(event("Ev1")).await.unwrap(),
        RouterOutcome::Dropped
    );
}

#[tokio::test]
#[serial_test::serial]
async fn ends_every_event_when_the_runtime_is_not_routed_any_more() {
    let _db = crate::db::testing::test_db();
    let service = SlackRouterService::new();
    PENDING_WORK_SERVICE
        .begin(PendingWorkKind::RoutedEvent, "Ev1", event("Ev1"))
        .await
        .unwrap();
    let items = PENDING_WORK_SERVICE
        .rows(PendingWorkKind::RoutedEvent)
        .await
        .unwrap();
    service.resume(items).await.unwrap();
    assert!(rows().await.is_empty());
}
