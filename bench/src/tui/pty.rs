//! A terminal UI under a real pseudo-terminal: its output as written and as text,
//! and its CPU time and memory as the system counts them.

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What the terminal answers to the device-attributes query every TUI build sends at start-up.
const DEVICE_ATTRIBUTES: &[u8] = b"\x1b[?62;22c";

#[derive(Default)]
struct Shared {
    raw: Vec<u8>,
    text: String,
    stripper: Stripper,
    answered: bool,
}

pub struct Tui {
    child: Child,
    master: File,
    shared: Arc<Mutex<Shared>>,
}

pub struct Usage {
    pub cpu_ms: f64,
    pub rss_kb: u64,
}

impl Tui {
    /// Start `cmd` (split on spaces) in a `cols` × `rows` terminal with `env` added.
    pub fn spawn(cmd: &str, cols: u16, rows: u16, env: &[(String, String)]) -> anyhow::Result<Tui> {
        let mut master_fd = 0;
        let mut slave_fd = 0;
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: openpty fills two descriptors it opened, and is given a valid winsize.
        let rc = unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &size as *const _ as *mut _,
            )
        };
        anyhow::ensure!(rc == 0, "openpty failed");
        // SAFETY: both descriptors are open and owned here from now on.
        let (master, slave) = unsafe {
            (
                OwnedFd::from_raw_fd(master_fd),
                OwnedFd::from_raw_fd(slave_fd),
            )
        };
        let mut parts = cmd.split_whitespace();
        let program = parts
            .next()
            .ok_or_else(|| anyhow::anyhow!("empty command"))?;
        let mut command = Command::new(program);
        command
            .args(parts)
            .env("TERM", "xterm-256color")
            .env_remove("COLORTERM")
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave));
        // SAFETY: setsid and TIOCSCTTY are async-signal-safe and make the PTY the controlling terminal.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn()?;
        let master = File::from(master);
        let shared = Arc::new(Mutex::new(Shared::default()));
        let mut reader = master.try_clone()?;
        let mut answer = master.try_clone()?;
        let sink = shared.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                let mut s = sink.lock().unwrap();
                s.raw.extend_from_slice(&buf[..n]);
                let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                let stripped = s.stripper.feed(&chunk);
                s.text.push_str(&stripped);
                if !s.answered && s.raw.windows(3).any(|w| w == b"\x1b[c") {
                    s.answered = true;
                    let _ = answer.write_all(DEVICE_ATTRIBUTES);
                }
            }
        });
        Ok(Tui {
            child,
            master,
            shared,
        })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn send(&mut self, input: &str) {
        let _ = self.master.write_all(input.as_bytes());
        let _ = self.master.flush();
    }

    /// Bytes the TUI has written so far.
    pub fn bytes(&self) -> usize {
        self.shared.lock().unwrap().raw.len()
    }

    /// Its output so far, without escape sequences.
    pub fn text_len(&self) -> usize {
        self.shared.lock().unwrap().text.len()
    }

    /// Wait until the output after byte `from` of the text holds `needle`. The elapsed time, or `None` at the deadline.
    pub fn wait_for(&self, needle: &str, from: usize, timeout: Duration) -> Option<Duration> {
        let start = Instant::now();
        loop {
            {
                let s = self.shared.lock().unwrap();
                // Look back far enough to catch a needle split across the boundary.
                let mut at = from.saturating_sub(needle.len()).min(s.text.len());
                while !s.text.is_char_boundary(at) {
                    at -= 1;
                }
                if s.text[at..].contains(needle) {
                    return Some(start.elapsed());
                }
            }
            if start.elapsed() > timeout {
                return None;
            }
            std::thread::sleep(Duration::from_micros(200));
        }
    }

    /// CPU time used so far and resident memory now.
    pub fn usage(&self) -> Usage {
        usage_of(self.pid())
    }

    pub fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = self.master.as_raw_fd();
    }
}

/// CPU time and resident memory of `pid`, as `ps` reports them.
pub fn usage_of(pid: u32) -> Usage {
    let out = Command::new("ps")
        .args(["-o", "rss=,time=", "-p", &pid.to_string()])
        .output();
    let Ok(out) = out else {
        return Usage {
            cpu_ms: 0.0,
            rss_kb: 0,
        };
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut fields = text.split_whitespace();
    let rss_kb = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0);
    let cpu_ms = fields.next().map(parse_cpu_time).unwrap_or(0.0);
    Usage { cpu_ms, rss_kb }
}

/// `ps` CPU time: `[[dd-]hh:]mm:ss[.cc]`.
fn parse_cpu_time(field: &str) -> f64 {
    let (days, rest) = match field.split_once('-') {
        Some((d, r)) => (d.parse::<f64>().unwrap_or(0.0), r),
        None => (0.0, field),
    };
    let parts: Vec<f64> = rest.split(':').map(|p| p.parse().unwrap_or(0.0)).collect();
    let seconds = parts.iter().fold(0.0, |acc, p| acc * 60.0 + p);
    (days * 86_400.0 + seconds) * 1000.0
}

/// Removes escape sequences from a stream that may split one across two chunks.
#[derive(Default)]
struct Stripper {
    state: State,
}

#[derive(Default, Clone, Copy, PartialEq)]
enum State {
    #[default]
    Text,
    Escape,
    Csi,
    /// OSC, APC or DCS: until BEL or ST.
    String,
    StringEscape,
}

impl Stripper {
    fn feed(&mut self, chunk: &str) -> String {
        let mut out = String::with_capacity(chunk.len());
        for c in chunk.chars() {
            self.state = match (self.state, c) {
                (State::Text, '\x1b') => State::Escape,
                (State::Text, c) => {
                    if c != '\r' {
                        out.push(c);
                    }
                    State::Text
                }
                (State::Escape, '[') => State::Csi,
                (State::Escape, ']' | '_' | 'P') => State::String,
                (State::Escape, _) => State::Text,
                (State::Csi, c) if ('\x40'..='\x7e').contains(&c) => State::Text,
                (State::Csi, _) => State::Csi,
                (State::String, '\x07') => State::Text,
                (State::String, '\x1b') => State::StringEscape,
                (State::String, _) => State::String,
                (State::StringEscape, '\\') => State::Text,
                (State::StringEscape, _) => State::String,
            };
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_split_sequences() {
        let mut s = Stripper::default();
        let a = s.feed("ab\x1b[3");
        let b = s.feed("1mcd\x1b]7501;x\x1b");
        let c = s.feed("\\e");
        assert_eq!(format!("{a}{b}{c}"), "abcde");
    }

    #[test]
    fn parses_ps_time() {
        assert_eq!(parse_cpu_time("0:01.50"), 1500.0);
        assert_eq!(parse_cpu_time("01:02:03"), 3_723_000.0);
    }
}
