use std::sync::atomic::AtomicUsize;
use std::time::Duration;

use tokio::sync::oneshot;

use super::*;
use crate::lib::agent_processes::AGENT_PROCESSES;
use crate::lib::inference_gate::INFERENCE_GATE;

fn caller() -> ComputerCaller {
    ComputerCaller {
        user_id: "user".into(),
        agent_id: "agent".into(),
        thread_id: Some("thread".into()),
        mode: "chat".into(),
        origin_channel: None,
        origin_channel_id: None,
    }
}

fn access() -> Arc<ComputerAccess> {
    ComputerAccess::new(None, ComputerKind::Local)
}

/// Let the spawned tasks run until they wait again.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

fn ids(uses: &[Arc<ComputerUse>]) -> Vec<String> {
    uses.iter().map(|item| item.id.clone()).collect()
}

/// Wait up to a second for `done` to hold.
async fn eventually(done: impl Fn() -> bool) {
    for _ in 0..100 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(done(), "the condition never held");
}

#[tokio::test]
async fn retains_ownership_between_tools_and_admits_waiting_invocations_in_order() {
    let access = access();
    let (first, second, third) = (
        access.create(caller(), None),
        access.create(caller(), None),
        access.create(caller(), None),
    );
    let order = Arc::new(Mutex::new(Vec::<i32>::new()));
    let push = |n: i32| {
        let order = order.clone();
        move || async move {
            order.lock().push(n);
            Ok(())
        }
    };
    access.run(&first, push(1), false).await.unwrap();
    let two = tokio::spawn({
        let (access, second, push) = (access.clone(), second.clone(), push(2));
        async move { access.run(&second, push, false).await }
    });
    settle().await;
    let three = tokio::spawn({
        let (access, third, push) = (access.clone(), third.clone(), push(3));
        async move { access.run(&third, push, false).await }
    });
    settle().await;
    access.run(&first, push(1), false).await.unwrap();
    assert_eq!(*order.lock(), vec![1, 1]);
    assert_eq!(
        ids(&access.waiting()),
        ids(&[second.clone(), third.clone()])
    );
    access.finish(&first);
    two.await.unwrap().unwrap();
    assert_eq!(*order.lock(), vec![1, 1, 2]);
    access.finish(&second);
    three.await.unwrap().unwrap();
    access.finish(&third);
    assert_eq!(*order.lock(), vec![1, 1, 2, 3]);
}

#[tokio::test]
async fn fails_a_waiting_call_whose_invocation_moved_to_another_computer() {
    let access = access();
    let (holder, mover) = (access.create(caller(), None), access.create(caller(), None));
    access.acquire(&holder).await.unwrap();
    let waiting = tokio::spawn({
        let (access, mover) = (access.clone(), mover.clone());
        async move { access.run(&mover, || async { Ok("ran") }, false).await }
    });
    settle().await;
    // Another call of the same invocation took it to another computer.
    access.yield_use(&mover);
    let err = waiting.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("moved to another computer"));
    access.finish(&holder);
    access.finish(&mover);
}

#[tokio::test]
async fn cancels_a_queued_invocation_without_affecting_the_active_one() {
    let access = access();
    let (first, second) = (access.create(caller(), None), access.create(caller(), None));
    access.acquire(&first).await.unwrap();
    let ran = Arc::new(AtomicBool::new(false));
    let pending = tokio::spawn({
        let (access, second, ran) = (access.clone(), second.clone(), ran.clone());
        async move {
            access
                .run(
                    &second,
                    || async move {
                        ran.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                    false,
                )
                .await
        }
    });
    settle().await;
    second.controller.cancel();
    assert!(pending.await.unwrap().is_err());
    assert!(!ran.load(Ordering::SeqCst));
    assert_eq!(access.owner().map(|o| o.id.clone()), Some(first.id.clone()));
    assert!(access.waiting().is_empty());
    access.finish(&first);
    access.finish(&second);
}

#[tokio::test]
async fn settles_the_current_action_before_enabling_human_input_and_resumes_after_hand_back() {
    let access = access();
    let use_ = access.create(caller(), None);
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (finish_tx, finish_rx) = oneshot::channel::<()>();
    let action = tokio::spawn({
        let (access, use_) = (access.clone(), use_.clone());
        async move {
            access
                .run(
                    &use_,
                    || async move {
                        let _ = started_tx.send(());
                        let _ = finish_rx.await;
                        Ok(())
                    },
                    false,
                )
                .await
        }
    });
    started_rx.await.unwrap();
    let takeover = tokio::spawn({
        let access = access.clone();
        async move { access.take_control("viewer", None).await }
    });
    settle().await;
    assert!(access.paused());
    assert_eq!(access.human(), None);
    finish_tx.send(()).unwrap();
    action.await.unwrap().unwrap();
    takeover.await.unwrap().unwrap();
    assert_eq!(access.human().as_deref(), Some("viewer"));
    let next = Arc::new(AtomicUsize::new(0));
    let pending = tokio::spawn({
        let (access, use_, next) = (access.clone(), use_.clone(), next.clone());
        async move {
            access
                .run(
                    &use_,
                    || async move {
                        next.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    false,
                )
                .await
        }
    });
    settle().await;
    assert_eq!(next.load(Ordering::SeqCst), 0);
    access.disconnected("viewer");
    assert!(access.paused());
    access.hand_back("new-viewer").await.unwrap();
    pending.await.unwrap().unwrap();
    assert_eq!(next.load(Ordering::SeqCst), 1);
    access.finish(&use_);
}

#[tokio::test]
async fn allows_requested_inspection_during_takeover_while_actions_wait() {
    let access = access();
    let use_ = access.create(caller(), None);
    access.take_control("viewer", None).await.unwrap();
    let screen = access
        .run(&use_, || async { Ok("screen") }, true)
        .await
        .unwrap();
    assert_eq!(screen, "screen");
    assert!(access.owner().is_none());
    access.hand_back("viewer").await.unwrap();
    access.finish(&use_);
}

#[tokio::test]
async fn releases_the_desktop_for_independent_work_when_an_invocation_requests_help() {
    let access = access();
    let (first, second) = (access.create(caller(), None), access.create(caller(), None));
    access.acquire(&first).await.unwrap();
    let waiting = tokio::spawn({
        let (access, second) = (access.clone(), second.clone());
        async move { access.acquire(&second).await }
    });
    settle().await;
    access.yield_use(&first);
    waiting.await.unwrap().unwrap();
    assert_eq!(
        access.owner().map(|o| o.id.clone()),
        Some(second.id.clone())
    );
    assert!(!first.signal.is_cancelled());
    access.finish(&second);
    access.finish(&first);
}

#[tokio::test]
async fn serializes_tools_from_the_same_invocation_even_when_they_waited_for_another_owner() {
    let access = access();
    let (first, second) = (access.create(caller(), None), access.create(caller(), None));
    access.acquire(&first).await.unwrap();
    let in_flight = Arc::new(AtomicUsize::new(0));
    let action = |in_flight: Arc<AtomicUsize>| {
        move || async move {
            assert_eq!(in_flight.fetch_add(1, Ordering::SeqCst), 0);
            tokio::task::yield_now().await;
            in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        }
    };
    let actions: Vec<_> = (0..2)
        .map(|_| {
            let (access, second, run) = (access.clone(), second.clone(), action(in_flight.clone()));
            tokio::spawn(async move { access.run(&second, run, false).await })
        })
        .collect();
    settle().await;
    access.finish(&first);
    for action in actions {
        action.await.unwrap().unwrap();
    }
    access.finish(&second);
}

#[tokio::test]
async fn propagates_caller_cancellation_while_human_control_keeps_an_action_waiting() {
    let access = access();
    let outer = CancellationToken::new();
    let use_ = access.create(caller(), Some(&outer));
    access.take_control("viewer", None).await.unwrap();
    let ran = Arc::new(AtomicBool::new(false));
    let pending = tokio::spawn({
        let (access, use_, ran) = (access.clone(), use_.clone(), ran.clone());
        async move {
            access
                .run(
                    &use_,
                    || async move {
                        ran.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                    false,
                )
                .await
        }
    });
    settle().await;
    outer.cancel();
    assert!(pending.await.unwrap().is_err());
    assert!(!ran.load(Ordering::SeqCst));
    assert!(access.paused());
    assert!(access.waiting().is_empty());
    access.finish(&use_);
}

#[tokio::test]
async fn rejects_hand_back_by_another_viewer_while_takeover_waits_for_an_action() {
    let access = access();
    let use_ = access.create(caller(), None);
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (finish_tx, finish_rx) = oneshot::channel::<()>();
    let action = tokio::spawn({
        let (access, use_) = (access.clone(), use_.clone());
        async move {
            access
                .run(
                    &use_,
                    || async move {
                        let _ = started_tx.send(());
                        let _ = finish_rx.await;
                        Ok(())
                    },
                    false,
                )
                .await
        }
    });
    started_rx.await.unwrap();
    let takeover = tokio::spawn({
        let access = access.clone();
        async move { access.take_control("first", None).await }
    });
    settle().await;
    let err = access.hand_back("second").await.unwrap_err();
    assert!(err.to_string().contains("Another viewer has control"));
    assert!(access.paused());
    finish_tx.send(()).unwrap();
    action.await.unwrap().unwrap();
    takeover.await.unwrap().unwrap();
    assert_eq!(access.human().as_deref(), Some("first"));
    access.hand_back("first").await.unwrap();
    access.finish(&use_);
}

fn reset_guard() {
    INFERENCE_GATE.free();
    AGENT_PROCESSES.resume();
}

#[tokio::test]
#[serial_test::serial(secure_guard)]
async fn stops_the_runtime_for_the_help_request_and_cleans_up_before_it_runs_again() {
    reset_guard();
    let cleared_while_stopped = Arc::new(Mutex::new(None::<bool>));
    let seen = cleared_while_stopped.clone();
    let access = ComputerAccess::new(
        Some(Arc::new(move || {
            let seen = seen.clone();
            Box::pin(async move {
                *seen.lock() = Some(INFERENCE_GATE.held());
                Ok(())
            })
        })),
        ComputerKind::Local,
    );
    access.take_control("viewer", Some("help-1")).await.unwrap();
    assert!(access.secure());
    assert!(INFERENCE_GATE.held());
    assert!(AGENT_PROCESSES.is_suspended());

    access.hand_back("viewer").await.unwrap();
    assert_eq!(*cleared_while_stopped.lock(), Some(true));
    assert!(!access.secure());
    assert!(!INFERENCE_GATE.held());
    assert!(!AGENT_PROCESSES.is_suspended());
    reset_guard();
}

#[tokio::test]
#[serial_test::serial(secure_guard)]
async fn runs_the_runtime_again_when_the_viewer_goes_away_and_keeps_the_desktop_paused() {
    reset_guard();
    let access = access();
    access.take_control("viewer", Some("help-1")).await.unwrap();
    access.disconnected("viewer");
    eventually(|| !INFERENCE_GATE.held()).await;
    assert!(!access.secure());
    assert!(access.paused());
    assert!(!AGENT_PROCESSES.is_suspended());
    reset_guard();
}

#[tokio::test]
#[serial_test::serial(secure_guard)]
async fn leaves_the_runtime_alone_for_a_takeover_that_answers_no_help_request() {
    reset_guard();
    let access = access();
    access.take_control("viewer", None).await.unwrap();
    assert!(!access.secure());
    assert!(!INFERENCE_GATE.held());
    assert!(!AGENT_PROCESSES.is_suspended());
    access.hand_back("viewer").await.unwrap();
    reset_guard();
}

#[tokio::test]
#[serial_test::serial(secure_guard)]
async fn keeps_the_desktop_paused_for_a_viewer_who_takes_control_while_it_is_cleared() {
    reset_guard();
    let (clearing_tx, clearing_rx) = oneshot::channel::<()>();
    let clearing = Arc::new(Mutex::new(Some(clearing_rx)));
    let access = ComputerAccess::new(
        Some(Arc::new(move || {
            let waiting = clearing.lock().take();
            Box::pin(async move {
                if let Some(waiting) = waiting {
                    let _ = waiting.await;
                }
                Ok(())
            })
        })),
        ComputerKind::Local,
    );
    access.take_control("first", Some("help-1")).await.unwrap();

    let hand_back = tokio::spawn({
        let access = access.clone();
        async move { access.hand_back("first").await }
    });
    settle().await;
    access.take_control("second", Some("help-1")).await.unwrap();
    clearing_tx.send(()).unwrap();
    hand_back.await.unwrap().unwrap();

    assert_eq!(access.human().as_deref(), Some("second"));
    assert!(access.paused());
    assert!(access.secure());
    assert!(INFERENCE_GATE.held());
    // The guard is the runtime's, so a window left open here would hold it for the next
    // test.
    access.hand_back("second").await.unwrap();
    reset_guard();
}

#[tokio::test]
#[serial_test::serial(secure_guard)]
async fn stops_the_runtime_for_the_typing_and_gives_everything_back_afterwards() {
    reset_guard();
    let cleared = Arc::new(AtomicBool::new(false));
    let flag = cleared.clone();
    let access = ComputerAccess::new(
        Some(Arc::new(move || {
            let flag = flag.clone();
            Box::pin(async move {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            })
        })),
        ComputerKind::Local,
    );
    let inside = access.clone();
    let answer = access
        .run_secure("help-1", async move {
            Ok((
                "filled",
                vec![inside.secure(), INFERENCE_GATE.held(), inside.paused()],
            ))
        })
        .await
        .unwrap();

    assert_eq!(answer, ("filled", vec![true, true, true]));
    assert!(cleared.load(Ordering::SeqCst));
    assert!(!access.secure());
    assert!(!access.paused());
    assert!(!INFERENCE_GATE.held());
    assert!(!AGENT_PROCESSES.is_suspended());
    reset_guard();
}

#[tokio::test]
#[serial_test::serial(secure_guard)]
async fn waits_for_the_action_the_agent_already_started() {
    reset_guard();
    let access = access();
    let use_ = access.create(caller(), None);
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (go_tx, go_rx) = oneshot::channel::<()>();
    let order = Arc::new(Mutex::new(Vec::<&str>::new()));
    let agent_action = tokio::spawn({
        let (access, use_, order) = (access.clone(), use_.clone(), order.clone());
        async move {
            access
                .run(
                    &use_,
                    || async move {
                        let _ = started_tx.send(());
                        let _ = go_rx.await;
                        order.lock().push("agent");
                        Ok(())
                    },
                    false,
                )
                .await
        }
    });
    started_rx.await.unwrap();

    let sign_in = tokio::spawn({
        let (access, order) = (access.clone(), order.clone());
        async move {
            access
                .run_secure("help-1", async move {
                    order.lock().push("sign-in");
                    Ok(())
                })
                .await
        }
    });
    settle().await;
    go_tx.send(()).unwrap();
    agent_action.await.unwrap().unwrap();
    sign_in.await.unwrap().unwrap();

    assert_eq!(*order.lock(), vec!["agent", "sign-in"]);
    access.finish(&use_);
    reset_guard();
}

#[tokio::test]
#[serial_test::serial(secure_guard)]
async fn refuses_while_somebody_is_at_the_keyboard_and_leaves_their_takeover_alone() {
    reset_guard();
    let access = access();
    access.take_control("viewer", Some("help-1")).await.unwrap();

    let err = access
        .run_secure("help-1", async { Ok("filled") })
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "Another viewer has control.");
    assert_eq!(access.human().as_deref(), Some("viewer"));
    assert!(access.secure());
    access.hand_back("viewer").await.unwrap();
    reset_guard();
}

#[tokio::test]
#[serial_test::serial(secure_guard)]
async fn gives_the_desktop_back_when_the_typing_fails() {
    reset_guard();
    let access = access();

    let err = access
        .run_secure("help-1", async {
            Err::<(), _>(anyhow::anyhow!("the tab went away"))
        })
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "the tab went away");
    assert!(!access.paused());
    assert!(!access.secure());
    assert!(!INFERENCE_GATE.held());
    reset_guard();
}
