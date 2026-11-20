//! Server-sent events, parsed as `EventSourceParserStream` parses a response body.

/// One dispatched event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventSourceMessage {
    pub id: Option<String>,
    /// `None` for an event without an `event` field.
    pub event: Option<String>,
    pub data: String,
}

/// Splits a byte stream into lines and lines into events. A line break is `\n`,
/// `\r` or `\r\n`, also across chunks; bytes decode as UTF-8 with replacement,
/// and a leading byte-order mark is dropped.
#[derive(Debug, Default)]
pub struct EventSourceParser {
    pending: Vec<u8>,
    /// The previous chunk ended on `\r`, so a leading `\n` belongs to it.
    after_cr: bool,
    started: bool,
    id: Option<String>,
    data: String,
    event_type: String,
}

impl EventSourceParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// The events the chunk completes.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<EventSourceMessage> {
        let mut events = Vec::new();
        let mut start = 0;
        let mut i = 0;
        if self.after_cr && chunk.first() == Some(&b'\n') {
            start = 1;
            i = 1;
        }
        self.after_cr = false;
        while i < chunk.len() {
            let byte = chunk[i];
            if byte == b'\n' || byte == b'\r' {
                self.pending.extend_from_slice(&chunk[start..i]);
                let line = std::mem::take(&mut self.pending);
                self.line(&line, &mut events);
                if byte == b'\r' {
                    if i + 1 < chunk.len() {
                        if chunk[i + 1] == b'\n' {
                            i += 1;
                        }
                    } else {
                        self.after_cr = true;
                    }
                }
                start = i + 1;
            }
            i += 1;
        }
        self.pending.extend_from_slice(&chunk[start..]);
        events
    }

    fn line(&mut self, raw: &[u8], events: &mut Vec<EventSourceMessage>) {
        let decoded = String::from_utf8_lossy(raw);
        let mut line: &str = &decoded;
        if !self.started {
            self.started = true;
            line = line.strip_prefix('\u{FEFF}').unwrap_or(line);
        }
        if line.is_empty() {
            self.dispatch(events);
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.find(':') {
            Some(at) => {
                let value = &line[at + 1..];
                (&line[..at], value.strip_prefix(' ').unwrap_or(value))
            }
            None => (line, ""),
        };
        match field {
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            "event" => self.event_type = value.to_string(),
            "id" => {
                self.id = if value.contains('\0') {
                    None
                } else {
                    Some(value.to_string())
                }
            }
            _ => {}
        }
    }

    fn dispatch(&mut self, events: &mut Vec<EventSourceMessage>) {
        if !self.data.is_empty() {
            let data = self
                .data
                .strip_suffix('\n')
                .unwrap_or(&self.data)
                .to_string();
            events.push(EventSourceMessage {
                id: self.id.clone(),
                event: (!self.event_type.is_empty()).then(|| self.event_type.clone()),
                data,
            });
        }
        self.id = None;
        self.data.clear();
        self.event_type.clear();
    }
}

/// `isMessageEvent`: an event with no type or the type `message`.
pub fn is_message_event(event: Option<&str>) -> bool {
    matches!(event, None | Some("message"))
}
