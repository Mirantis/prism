//! The terminal itself: raw mode, its size, and a reader thread for stdin.
//!
//! The reader can be paused while a child process (an editor, a shell command)
//! owns the terminal, so the two never read the same keystrokes. `pause` returns
//! only once the reader has stopped reading.

use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};

use tokio::sync::mpsc;

pub enum TermInput {
    /// Text read from the terminal: keys, pastes and the terminal's own replies.
    Text(String),
    Resize,
}

#[derive(Default)]
struct PauseState {
    requested: bool,
    paused: bool,
}

#[derive(Clone)]
pub struct Reader {
    state: Arc<(Mutex<PauseState>, Condvar)>,
    /// Wakes the thread from its wait on stdin when a pause is asked for.
    #[cfg(unix)]
    wake: Arc<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)>,
}

impl Reader {
    /// Start reading stdin on a thread of its own.
    pub fn start(tx: mpsc::UnboundedSender<TermInput>) -> Reader {
        let reader = Reader {
            state: Arc::new((Mutex::new(PauseState::default()), Condvar::new())),
            #[cfg(unix)]
            wake: Arc::new(wake_pipe()),
        };
        let thread_reader = reader.clone();
        std::thread::spawn(move || thread_reader.run(tx));
        reader
    }

    /// Stop reading stdin, and wait until the thread has stopped.
    pub fn pause(&self) {
        let (lock, cond) = &*self.state;
        let mut state = lock.lock().unwrap();
        state.requested = true;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: one byte written to the pipe this reader owns.
            unsafe { libc::write(self.wake.1.as_raw_fd(), [1u8].as_ptr().cast(), 1) };
        }
        while !state.paused {
            state = cond.wait(state).unwrap();
        }
    }

    pub fn resume(&self) {
        let (lock, cond) = &*self.state;
        let mut state = lock.lock().unwrap();
        state.requested = false;
        cond.notify_all();
    }

    /// Block here while a pause is asked for.
    fn hold(&self) {
        let (lock, cond) = &*self.state;
        let mut state = lock.lock().unwrap();
        if !state.requested {
            return;
        }
        state.paused = true;
        cond.notify_all();
        while state.requested {
            state = cond.wait(state).unwrap();
        }
        state.paused = false;
    }

    #[cfg(unix)]
    fn run(self, tx: mpsc::UnboundedSender<TermInput>) {
        use std::os::fd::AsRawFd;
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        let wake = self.wake.0.as_raw_fd();
        loop {
            self.hold();
            let mut fds = [
                libc::pollfd {
                    fd: libc::STDIN_FILENO,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: wake,
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // SAFETY: two valid pollfds; the wait ends on input or on a pause.
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
            if ready <= 0 {
                continue;
            }
            if fds[1].revents != 0 {
                let mut drain = [0u8; 64];
                // SAFETY: reading the wake bytes into a stack buffer of its own length.
                unsafe { libc::read(wake, drain.as_mut_ptr().cast(), drain.len()) };
            }
            // A pause asked for while the poll waited wins over the bytes that woke it.
            {
                let (lock, _) = &*self.state;
                if lock.lock().unwrap().requested {
                    continue;
                }
            }
            if fds[0].revents == 0 {
                continue;
            }
            // SAFETY: reading into a stack buffer of its own length.
            let n = unsafe { libc::read(libc::STDIN_FILENO, buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                if n == 0 {
                    return;
                }
                continue;
            }
            pending.extend_from_slice(&buf[..n as usize]);
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            if !text.is_empty() && tx.send(TermInput::Text(text)).is_err() {
                return;
            }
        }
    }

    #[cfg(windows)]
    fn run(self, tx: mpsc::UnboundedSender<TermInput>) {
        use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
        loop {
            self.hold();
            if !event::poll(std::time::Duration::from_millis(50)).unwrap_or(false) {
                continue;
            }
            let Ok(ev) = event::read() else { continue };
            let text = match ev {
                Event::Resize(..) => {
                    let _ = tx.send(TermInput::Resize);
                    continue;
                }
                Event::Paste(s) => s,
                Event::Key(k) if k.kind != KeyEventKind::Release => {
                    let alt = k.modifiers.contains(KeyModifiers::ALT);
                    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
                    let base = match k.code {
                        KeyCode::Char(c) if ctrl && c.is_ascii_alphabetic() => {
                            char::from((c.to_ascii_lowercase() as u8) & 0x1f).to_string()
                        }
                        KeyCode::Char(c) => c.to_string(),
                        KeyCode::Enter => "\r".into(),
                        KeyCode::Esc => "\x1b".into(),
                        KeyCode::Backspace => "\x7f".into(),
                        KeyCode::Tab => "\t".into(),
                        KeyCode::BackTab => "\x1b[Z".into(),
                        KeyCode::Up => "\x1b[A".into(),
                        KeyCode::Down => "\x1b[B".into(),
                        KeyCode::Right => "\x1b[C".into(),
                        KeyCode::Left => "\x1b[D".into(),
                        KeyCode::Home => "\x1b[H".into(),
                        KeyCode::End => "\x1b[F".into(),
                        KeyCode::PageUp => "\x1b[5~".into(),
                        KeyCode::PageDown => "\x1b[6~".into(),
                        KeyCode::Delete => "\x1b[3~".into(),
                        _ => continue,
                    };
                    if alt { format!("\x1b{base}") } else { base }
                }
                _ => continue,
            };
            if tx.send(TermInput::Text(text)).is_err() {
                return;
            }
        }
    }
}

/// A pipe whose read end the reader waits on beside stdin.
#[cfg(unix)]
fn wake_pipe() -> (std::os::fd::OwnedFd, std::os::fd::OwnedFd) {
    use std::os::fd::FromRawFd;
    let mut fds = [0; 2];
    // SAFETY: pipe fills two descriptors, owned from here on.
    let rc = unsafe { libc::pipe(fds.as_mut_ptr()) };
    assert_eq!(rc, 0, "pipe failed");
    unsafe {
        (
            std::os::fd::OwnedFd::from_raw_fd(fds[0]),
            std::os::fd::OwnedFd::from_raw_fd(fds[1]),
        )
    }
}

pub fn is_tty() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

pub fn stdout_is_tty() -> bool {
    use std::io::IsTerminal;
    std::io::stdout().is_terminal()
}

pub fn enable_raw() {
    // A Windows console draws escape sequences once virtual terminal processing is on.
    #[cfg(windows)]
    let _ = crossterm::ansi_support::supports_ansi();
    let _ = crossterm::terminal::enable_raw_mode();
}

pub fn disable_raw() {
    let _ = crossterm::terminal::disable_raw_mode();
}

/// The terminal's size as `(columns, rows)`, or 80×24 when it cannot say.
pub fn size() -> (usize, usize) {
    match crossterm::terminal::size() {
        Ok((c, r)) if c > 0 && r > 0 => (c as usize, r as usize),
        _ => (80, 24),
    }
}

/// Write to the terminal now.
pub fn write(text: &str) {
    if text.is_empty() {
        return;
    }
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

pub const HIDE_CURSOR: &str = "\x1b[?25l";
pub const SHOW_CURSOR: &str = "\x1b[?25h";
