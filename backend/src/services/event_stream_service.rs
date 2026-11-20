//! Event Stream Service
//!
//! Owns the numbered stream of chat events that every connected client reads,
//! and the window of recent events a reconnecting client can have again.
//!
//! A client on a phone loses its socket every time the screen locks, and a reply
//! published in that gap used to reach nobody. So every event gets the next
//! `seq`, is kept for a while, and a client that comes back names the last `seq`
//! it saw and is sent the rest. When the gap is no longer covered the client is
//! told so, and reads history over REST instead — it is never silently behind.
//!
//! `stream_id` names this process. Numbers from a previous process mean nothing
//! here, so a client that brings one after a restart is told to reload.
//!
//! The window is memory, bounded by a count and a byte budget. The runtime is one
//! process per agent, so memory is where the rest of its coordination lives too.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use parking_lot::{Mutex, ReentrantMutex};

use crate::protocol::chat_protocol::{SequencedEvent, StreamEvent};

/// One event, numbered and serialized once for every socket that sends it.
#[derive(Debug, Clone)]
pub struct StreamEntry {
    pub seq: i64,
    pub event: SequencedEvent,
    /// The frame as sent on the wire.
    pub frame: String,
    /// Its size in bytes, which is what the replay budgets count.
    pub bytes: usize,
}

/// Receives every event published after it subscribed.
pub type StreamSubscriber = Arc<dyn Fn(&StreamEntry) + Send + Sync>;

/// Stops a subscription. Calling it again does nothing.
pub type Unsubscribe = Arc<dyn Fn() + Send + Sync>;

/// How many recent events are kept for replay.
pub const REPLAY_MAX_EVENTS: usize = 2_000;

/// How many bytes of recent events are kept for replay.
pub const REPLAY_MAX_BYTES: usize = 16 * 1024 * 1024;

/// The most a single resume replays. A slow client past this is told to reload
/// instead: feeding it a replay it cannot drain only gets it closed for falling
/// behind, and it would reconnect and ask for the same replay again.
pub const REPLAY_MAX_GAP_BYTES: usize = 2 * 1024 * 1024;

/// The bounds of the replay window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayLimits {
    pub max_events: usize,
    pub max_bytes: usize,
    pub max_gap_bytes: usize,
}

impl Default for ReplayLimits {
    fn default() -> Self {
        Self {
            max_events: REPLAY_MAX_EVENTS,
            max_bytes: REPLAY_MAX_BYTES,
            max_gap_bytes: REPLAY_MAX_GAP_BYTES,
        }
    }
}

/// The numbered stream: this process's id, the newest `seq`, and the window.
struct StreamState {
    stream_id: String,
    last_seq: i64,
    entries: VecDeque<StreamEntry>,
    bytes: usize,
}

impl StreamState {
    fn fresh() -> Self {
        Self {
            stream_id: uuid::Uuid::new_v4().to_string(),
            last_seq: 0,
            entries: VecDeque::new(),
            bytes: 0,
        }
    }
}

pub struct EventStreamService {
    limits: ReplayLimits,
    state: Mutex<StreamState>,
    /// The subscribers in subscription order, each under the id its `Unsubscribe` removes.
    subscribers: Arc<Mutex<Vec<(u64, StreamSubscriber)>>>,
    next_subscriber: AtomicU64,
    /// Held from taking a number until every subscriber has the event, so no
    /// subscriber sees a later event before an earlier one. Reentrant, so a
    /// subscriber may publish.
    publishing: ReentrantMutex<()>,
}

impl EventStreamService {
    pub fn new() -> Self {
        Self::with_limits(ReplayLimits::default())
    }

    pub fn with_limits(limits: ReplayLimits) -> Self {
        Self {
            limits,
            state: Mutex::new(StreamState::fresh()),
            subscribers: Arc::new(Mutex::new(Vec::new())),
            next_subscriber: AtomicU64::new(0),
            publishing: ReentrantMutex::new(()),
        }
    }

    pub fn stream_id(&self) -> String {
        self.state.lock().stream_id.clone()
    }

    /// The `seq` of the newest event, 0 before the first.
    pub fn seq(&self) -> i64 {
        self.state.lock().last_seq
    }

    /// Number an event, keep it, and hand it to every subscriber.
    ///
    /// **Synchronous on purpose.** Nothing may run between taking a number and
    /// handing the event out, or a socket registering in that gap would see a later
    /// event before an earlier one. Call it only once whatever the event describes
    /// is committed, so a client that reads history on the back of it finds it.
    pub fn publish(&self, event: StreamEvent) -> StreamEntry {
        let _publishing = self.publishing.lock();
        let entry = {
            let mut state = self.state.lock();
            state.last_seq += 1;
            let seq = state.last_seq;
            let sequenced = SequencedEvent { event, seq };
            let frame = serde_json::to_string(&sequenced).expect("a stream event serializes");
            let bytes = frame.len();
            let entry = StreamEntry {
                seq,
                event: sequenced,
                frame,
                bytes,
            };
            self.keep(&mut state, entry.clone());
            entry
        };
        let subscribers: Vec<StreamSubscriber> = self
            .subscribers
            .lock()
            .iter()
            .map(|(_, subscriber)| Arc::clone(subscriber))
            .collect();
        for subscriber in subscribers {
            subscriber(&entry);
        }
        entry
    }

    /// Run `f` with no event published meanwhile, so what it reads of the stream
    /// and what it subscribes to meet without a gap: an event published by another
    /// thread waits until `f` returns. `f` may publish itself.
    pub fn exclusive<T>(&self, f: impl FnOnce() -> T) -> T {
        let _publishing = self.publishing.lock();
        f()
    }

    /// The events after `seq`, when this process still has every one of them and
    /// they fit one replay. `None` means the client has to reload from history.
    pub fn replay_after(&self, stream_id: &str, seq: i64) -> Option<Vec<StreamEntry>> {
        let state = self.state.lock();
        if stream_id != state.stream_id {
            return None;
        }
        if seq > state.last_seq {
            return None;
        }
        if seq == state.last_seq {
            return Some(Vec::new());
        }

        // The next event the client needs has been evicted.
        let oldest = state.entries.front()?.seq;
        if seq + 1 < oldest {
            return None;
        }

        let skip = usize::try_from(seq + 1 - oldest).unwrap_or(0);
        let mut size = 0usize;
        let mut missed = Vec::new();
        for entry in state.entries.iter().skip(skip) {
            size += entry.bytes;
            if size > self.limits.max_gap_bytes {
                return None;
            }
            missed.push(entry.clone());
        }
        Some(missed)
    }

    /// Receive every event from now on. The returned function stops that.
    pub fn subscribe(&self, subscriber: StreamSubscriber) -> Unsubscribe {
        let id = self.next_subscriber.fetch_add(1, Ordering::Relaxed);
        self.subscribers.lock().push((id, subscriber));
        let subscribers = Arc::clone(&self.subscribers);
        Arc::new(move || subscribers.lock().retain(|(entry_id, _)| *entry_id != id))
    }

    fn keep(&self, state: &mut StreamState, entry: StreamEntry) {
        state.bytes += entry.bytes;
        state.entries.push_back(entry);
        while state.entries.len() > self.limits.max_events
            || (state.bytes > self.limits.max_bytes && state.entries.len() > 1)
        {
            if let Some(evicted) = state.entries.pop_front() {
                state.bytes -= evicted.bytes;
            }
        }
    }

    /// Start a new stream, as a restart would. For tests.
    pub fn reset_for_tests(&self) {
        *self.state.lock() = StreamState::fresh();
        self.subscribers.lock().clear();
    }
}

impl Default for EventStreamService {
    fn default() -> Self {
        Self::new()
    }
}

pub static EVENT_STREAM_SERVICE: LazyLock<EventStreamService> =
    LazyLock::new(EventStreamService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::chat_protocol::{ThreadEventPayload, TurnEventPayload, TurnState};

    fn turn() -> StreamEvent {
        StreamEvent::Turn(TurnEventPayload {
            thread_id: "t".into(),
            state: TurnState::Running,
            outcome: None,
            error: None,
        })
    }

    #[test]
    fn numbers_each_event_and_writes_its_frame_once() {
        let stream = EventStreamService::new();
        assert_eq!(stream.seq(), 0);
        let first = stream.publish(turn());
        let second = stream.publish(StreamEvent::Thread(ThreadEventPayload {
            thread_id: "t".into(),
            title: None,
            created_at: None,
        }));
        assert_eq!((first.seq, second.seq, stream.seq()), (1, 2, 2));
        assert_eq!(
            first.frame,
            r#"{"type":"turn","payload":{"threadId":"t","state":"running"},"seq":1}"#
        );
        assert_eq!(first.bytes, first.frame.len());
    }

    #[test]
    fn hands_every_event_to_every_subscriber_until_it_unsubscribes() {
        let stream = EventStreamService::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let unsubscribe = stream.subscribe(Arc::new(move |entry: &StreamEntry| {
            sink.lock().push(entry.seq);
        }));
        stream.publish(turn());
        unsubscribe();
        unsubscribe();
        stream.publish(turn());
        assert_eq!(*seen.lock(), vec![1]);
    }

    #[test]
    fn replays_what_a_client_missed_and_nothing_it_cannot_have() {
        let stream = EventStreamService::new();
        let id = stream.stream_id();
        for _ in 0..3 {
            stream.publish(turn());
        }
        let missed: Vec<i64> = stream
            .replay_after(&id, 1)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(missed, vec![2, 3]);
        assert_eq!(stream.replay_after(&id, 3).unwrap().len(), 0);
        assert!(stream.replay_after(&id, 4).is_none());
        assert!(stream.replay_after("a-previous-process", 1).is_none());
    }

    #[test]
    fn tells_a_client_to_reload_once_its_gap_is_evicted_or_too_large() {
        let stream = EventStreamService::with_limits(ReplayLimits {
            max_events: 2,
            max_bytes: 1024 * 1024,
            max_gap_bytes: 1024 * 1024,
        });
        let id = stream.stream_id();
        for _ in 0..3 {
            stream.publish(turn());
        }
        assert!(stream.replay_after(&id, 0).is_none());
        assert_eq!(stream.replay_after(&id, 1).unwrap().len(), 2);

        let small = EventStreamService::with_limits(ReplayLimits {
            max_events: 10,
            max_bytes: 1024 * 1024,
            max_gap_bytes: 100,
        });
        let id = small.stream_id();
        for _ in 0..3 {
            small.publish(turn());
        }
        assert!(small.replay_after(&id, 0).is_none());
        assert_eq!(small.replay_after(&id, 2).unwrap().len(), 1);
    }

    #[test]
    fn keeps_the_newest_event_past_the_byte_budget() {
        let stream = EventStreamService::with_limits(ReplayLimits {
            max_events: 10,
            max_bytes: 10,
            max_gap_bytes: 1024,
        });
        let id = stream.stream_id();
        stream.publish(turn());
        stream.publish(turn());
        assert_eq!(stream.replay_after(&id, 1).unwrap().len(), 1);
        assert!(stream.replay_after(&id, 0).is_none());
    }
}
