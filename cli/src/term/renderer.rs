//! Draws frames in place at the bottom of the terminal.
//!
//! The frame stays in the normal screen, under the shell's own history, as Ink's
//! frame does. A frame of the same height rewrites only the lines that changed, so
//! a spinner tick or a keystroke rewrites a line or two, not the whole
//! conversation. A frame that grew or shrank rewrites the screen from its first
//! changed line. A change above the visible rows clears the screen and writes the
//! frame again, because those rows are in the scrollback where no cursor reaches.
//!
//! The cursor rests at the end of the frame's last line, so a frame that fills
//! the screen does not scroll it by one row.

use super::text::Line;

#[derive(Default)]
pub struct Renderer {
    /// The encoded lines of the frame on screen.
    previous: Vec<String>,
    /// Lines of the previous frame were written to the terminal.
    drawn: bool,
}

impl Renderer {
    pub fn new() -> Renderer {
        Renderer::default()
    }

    /// The bytes that turn the frame on screen into `lines`, in a terminal of `rows` rows.
    pub fn render(&mut self, lines: &[Line], rows: usize, out: &mut String) {
        let next: Vec<String> = lines.iter().map(Line::encoded).collect();
        if !self.drawn {
            out.push_str(&next.join("\r\n"));
            self.drawn = !next.is_empty();
            self.previous = next;
            return;
        }
        let old = &self.previous;
        let common = old.iter().zip(&next).take_while(|(a, b)| a == b).count();
        if common == old.len() && common == next.len() {
            return;
        }
        // The first line to write. A frame that only lost lines rewrites its new last line,
        // so the cursor ends at the end of a line it wrote.
        let first = if common == next.len() {
            common.saturating_sub(1)
        } else {
            common
        };
        let top_visible = old.len().saturating_sub(rows);
        // A frame that overflowed the screen and then shrank is written whole, from the top,
        // so the part of it that fits is not left in the scrollback.
        let shrank_from_overflow = old.len() > rows && next.len() < old.len();
        if old.len() == next.len() && first >= top_visible {
            self.rewrite_changed(&next, out);
        } else if first < top_visible || shrank_from_overflow {
            // The change is in rows the terminal has scrolled away: clear the screen and write it all.
            out.push_str("\x1b[H\x1b[J");
            out.push_str(&next.join("\r\n"));
        } else if first == old.len() {
            // Only new lines after the last one.
            out.push_str("\r\n");
            out.push_str(&next[first..].join("\r\n"));
        } else {
            let up = old.len() - 1 - first;
            out.push('\r');
            if up > 0 {
                out.push_str(&format!("\x1b[{up}A"));
            }
            out.push_str("\x1b[J");
            out.push_str(&next[first..].join("\r\n"));
        }
        self.drawn = !next.is_empty();
        self.previous = next;
    }

    /// Rewrite each line that changed in a frame of the same height, then the last line, so
    /// the cursor ends where it rests. A spinner tick rewrites its own line and the last.
    fn rewrite_changed(&self, next: &[String], out: &mut String) {
        let last = next.len() - 1;
        let mut at = last;
        for (i, line) in next.iter().enumerate() {
            if i != last && *line == self.previous[i] {
                continue;
            }
            if i < at {
                out.push_str(&format!("\x1b[{}A", at - i));
            } else if i > at {
                out.push_str(&format!("\x1b[{}B", i - at));
            }
            out.push_str("\r\x1b[2K");
            out.push_str(line);
            at = i;
        }
    }

    /// The bytes that erase the frame on screen, leaving the cursor where it began.
    pub fn clear(&mut self, out: &mut String) {
        if self.drawn {
            let up = self.previous.len().saturating_sub(1);
            out.push('\r');
            if up > 0 {
                out.push_str(&format!("\x1b[{up}A"));
            }
            out.push_str("\x1b[J");
        }
        self.previous.clear();
        self.drawn = false;
    }

    /// Forget the frame on screen without erasing it: the next frame is written below.
    pub fn release(&mut self, out: &mut String) {
        if self.drawn {
            out.push_str("\r\n");
        }
        self.previous.clear();
        self.drawn = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<Line> {
        v.iter().map(|s| Line::plain(*s)).collect()
    }

    #[test]
    fn first_frame_is_written_whole() {
        let mut r = Renderer::new();
        let mut out = String::new();
        r.render(&lines(&["a", "b"]), 10, &mut out);
        assert_eq!(out, "a\r\nb");
    }

    #[test]
    fn rewrites_only_the_changed_lines_of_a_frame_of_the_same_height() {
        let mut r = Renderer::new();
        let mut out = String::new();
        r.render(&lines(&["a", "b", "c", "d"]), 10, &mut out);
        out.clear();
        r.render(&lines(&["a", "B", "c", "d"]), 10, &mut out);
        assert_eq!(out, "\x1b[2A\r\x1b[2KB\x1b[2B\r\x1b[2Kd");
    }

    #[test]
    fn rewrites_from_the_first_changed_line_when_the_height_changes() {
        let mut r = Renderer::new();
        let mut out = String::new();
        r.render(&lines(&["a", "b", "c"]), 10, &mut out);
        out.clear();
        r.render(&lines(&["a", "B", "c", "d"]), 10, &mut out);
        assert_eq!(out, "\r\x1b[1A\x1b[JB\r\nc\r\nd");
    }

    #[test]
    fn appends_new_lines() {
        let mut r = Renderer::new();
        let mut out = String::new();
        r.render(&lines(&["a"]), 10, &mut out);
        out.clear();
        r.render(&lines(&["a", "b"]), 10, &mut out);
        assert_eq!(out, "\r\nb");
    }

    #[test]
    fn clears_the_screen_for_a_change_above_the_visible_rows() {
        let mut r = Renderer::new();
        let mut out = String::new();
        r.render(&lines(&["a", "b", "c", "d"]), 2, &mut out);
        out.clear();
        r.render(&lines(&["A", "b", "c", "d"]), 2, &mut out);
        assert_eq!(out, "\x1b[H\x1b[JA\r\nb\r\nc\r\nd");
    }

    #[test]
    fn a_frame_that_shrinks_from_overflowing_is_written_whole() {
        let mut r = Renderer::new();
        let mut out = String::new();
        r.render(&lines(&["a", "b", "c", "d"]), 3, &mut out);
        out.clear();
        r.render(&lines(&["a", "b", "x"]), 3, &mut out);
        assert_eq!(out, "\x1b[H\x1b[Ja\r\nb\r\nx");
    }

    #[test]
    fn a_shorter_frame_rewrites_its_last_line() {
        let mut r = Renderer::new();
        let mut out = String::new();
        r.render(&lines(&["a", "b", "c"]), 10, &mut out);
        out.clear();
        r.render(&lines(&["a", "b"]), 10, &mut out);
        assert_eq!(out, "\r\x1b[1A\x1b[Jb");
    }
}
