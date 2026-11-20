//! The monitor manager against real shell commands, with the notifications it
//! would store captured instead.

use super::*;

type Delivered = Arc<Mutex<Vec<(String, String)>>>;

fn manager() -> (Arc<MonitorManager>, Delivered) {
    let delivered: Delivered = Arc::default();
    let sink = delivered.clone();
    let deliver: DeliverMonitorNotification = Arc::new(move |_target, id, text| {
        sink.lock().push((id, text));
        Box::pin(async { Ok(()) })
    });
    (Arc::new(MonitorManager::with_deliver(deliver)), delivered)
}

fn params(command: &str) -> MonitorParams {
    MonitorParams {
        command: command.to_string(),
        description: "the log".to_string(),
        timeout_ms: None,
        workdir: std::env::temp_dir().to_string_lossy().to_string(),
        notify: TaskNotificationTarget {
            thread_id: "thread-1".into(),
            agent_id: "agent-1".into(),
            user_id: "user-1".into(),
            ..TaskNotificationTarget::default()
        },
    }
}

async fn wait_for_end(manager: &MonitorManager, id: &str) {
    for _ in 0..200 {
        if manager.running_count() == 0
            && PENDING_WORK_SERVICE
                .rows(PendingWorkKind::Monitor)
                .await
                .unwrap()
                .iter()
                .all(|row| row.key != id)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the monitor did not end");
}

#[tokio::test]
#[serial_test::serial]
async fn sends_the_lines_as_one_event_then_the_exit() {
    let _db = crate::db::testing::test_db();
    let (manager, delivered) = manager();
    let id = manager
        .start(params("printf 'ERROR one\\n\\nERROR <two>\\n'; exit 3"))
        .await
        .unwrap();
    wait_for_end(&manager, &id).await;

    let delivered = delivered.lock().clone();
    assert_eq!(delivered.len(), 2, "{delivered:?}");
    assert_eq!(delivered[0].0, format!("{id}:1"));
    assert!(
        delivered[0]
            .1
            .contains("\nERROR one\nERROR &lt;two&gt;\n</task-notification>")
    );
    assert_eq!(delivered[1].0, id);
    assert!(
        delivered[1]
            .1
            .contains("reason=\"exit\" events=\"1\" exit-code=\"3\"")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn a_stop_by_the_agent_sends_no_notice() {
    let _db = crate::db::testing::test_db();
    let (manager, delivered) = manager();
    let id = manager.start(params("sleep 30")).await.unwrap();
    assert_eq!(manager.running_count(), 1);
    assert!(manager.stop(&id));
    wait_for_end(&manager, &id).await;
    assert!(!manager.stop(&id));
    assert!(delivered.lock().is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn the_deadline_stops_the_command_and_says_so() {
    let _db = crate::db::testing::test_db();
    let (manager, delivered) = manager();
    let id = manager
        .start(MonitorParams {
            timeout_ms: Some(300),
            ..params("echo started; sleep 30")
        })
        .await
        .unwrap();
    wait_for_end(&manager, &id).await;
    let delivered = delivered.lock().clone();
    assert_eq!(delivered.len(), 2, "{delivered:?}");
    assert!(delivered[1].1.contains("reason=\"timeout\" events=\"1\">"));
    assert!(!delivered[1].1.contains("exit-code"));
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_monitor_past_the_cap() {
    let _db = crate::db::testing::test_db();
    let (manager, _delivered) = manager();
    let mut ids = Vec::new();
    for _ in 0..MAX_MONITORS {
        ids.push(manager.start(params("sleep 30")).await.unwrap());
    }
    let err = manager.start(params("sleep 30")).await.unwrap_err();
    assert!(
        err.to_string()
            .starts_with("At most 5 monitors run at once.")
    );
    for id in &ids {
        manager.stop(id);
    }
    for id in &ids {
        wait_for_end(&manager, id).await;
    }
}

#[tokio::test]
#[serial_test::serial]
async fn a_restart_reports_the_unsent_events_and_the_end() {
    let _db = crate::db::testing::test_db();
    let (manager, delivered) = manager();
    let work = MonitorWork {
        description: "the log".into(),
        notify: params("").notify,
        process: None,
        events: Some(2),
        unsent: Some(vec![MonitorEvent {
            id: "m-1:2".into(),
            text: "lines".into(),
        }]),
    };
    PENDING_WORK_SERVICE
        .begin(
            PendingWorkKind::Monitor,
            "m-1",
            serde_json::to_value(&work).unwrap(),
        )
        .await
        .unwrap();
    let items = PENDING_WORK_SERVICE
        .rows(PendingWorkKind::Monitor)
        .await
        .unwrap();
    manager.resume(items, vec![]).await;
    PENDING_WORK_SERVICE.flush().await;

    let delivered = delivered.lock().clone();
    assert_eq!(delivered[0], ("m-1:2".to_string(), "lines".to_string()));
    assert_eq!(delivered[1].0, "m-1");
    assert!(delivered[1].1.contains("reason=\"restart\" events=\"2\">"));
    assert!(
        PENDING_WORK_SERVICE
            .rows(PendingWorkKind::Monitor)
            .await
            .unwrap()
            .is_empty()
    );
}
