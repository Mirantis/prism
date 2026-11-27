//! The pictures this process has decoded and stored in the terminal, and the
//! rendered markdown of each message.
//!
//! A stored attachment never changes, so a decoded picture is kept for the next
//! frame, most recently used last, until the cache passes its byte budget. Each
//! attachment shown at one size is one kitty image, stored once and kept: its
//! placeholders in the scrollback still show it after a redraw. A picture already
//! stored at the size a frame draws it needs only its dimensions, which are kept
//! after the decoded pixels are evicted, so a picture on screen is never loaded again.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::Arc;

use crate::images::bitmap::{Bitmap, image_cells, resize};
use crate::images::graphics::Cell;
use crate::images::kitty::{placeholder_lines, transmit};
use crate::markdown::{MessagePart, render_markdown, render_message_parts};
use crate::protocol::AttachmentMeta;
use crate::term::text::Line;

/// Four pictures at the largest decoded size.
const CACHE_BYTES: usize = 4 * 2048 * 2048 * 4;

#[derive(Default)]
struct ImageState {
    bitmaps: HashMap<String, Arc<Bitmap>>,
    /// Each loaded picture's pixel size, kept after its pixels are evicted.
    sizes: HashMap<String, (u32, u32)>,
    order: VecDeque<String>,
    bytes: usize,
    loading: HashSet<String>,
    failed: HashSet<String>,
    ids: HashMap<(String, u32, u32), u32>,
    sent: HashSet<u32>,
    next_id: u32,
    /// Attachments a frame wanted and that are not loading yet.
    wanted: Vec<AttachmentMeta>,
    /// Pictures to store in the terminal before the next frame is written.
    transmit: Vec<String>,
}

pub struct ImageStore {
    state: RefCell<ImageState>,
}

impl ImageStore {
    pub fn new() -> ImageStore {
        // Placeholder colours hold 24 bits. A random start keeps two clients in one
        // terminal from taking the same ids.
        let next_id = 0x100000 + rand::random::<u32>() % 0xe00000;
        ImageStore {
            state: RefCell::new(ImageState {
                next_id,
                ..ImageState::default()
            }),
        }
    }

    /// The attachments the last frame wanted, now marked as loading.
    pub fn take_wanted(&self) -> Vec<AttachmentMeta> {
        let mut s = self.state.borrow_mut();
        let wanted = std::mem::take(&mut s.wanted);
        for a in &wanted {
            s.loading.insert(a.id.clone());
        }
        wanted
    }

    pub fn take_transmissions(&self) -> String {
        std::mem::take(&mut self.state.borrow_mut().transmit).concat()
    }

    pub fn loaded(&self, id: String, bitmap: Option<Arc<Bitmap>>) {
        let mut s = self.state.borrow_mut();
        s.loading.remove(&id);
        let Some(bitmap) = bitmap else {
            s.failed.insert(id);
            return;
        };
        s.bytes += bitmap.data.len();
        s.sizes.insert(id.clone(), (bitmap.width, bitmap.height));
        s.order.push_back(id.clone());
        s.bitmaps.insert(id.clone(), bitmap);
        while s.bytes > CACHE_BYTES && s.order.len() > 1 {
            let Some(old) = s.order.pop_front() else {
                break;
            };
            if old == id {
                s.order.push_back(old);
                continue;
            }
            if let Some(b) = s.bitmaps.remove(&old) {
                s.bytes -= b.data.len();
            }
        }
    }
}

impl ImageStore {
    /// The placeholder lines of `attachment` drawn in at most `max_cols` × `max_rows`
    /// cells, or `None` until its picture is ready.
    pub fn placeholder(
        &self,
        attachment: &AttachmentMeta,
        cell: Cell,
        max_cols: u32,
        max_rows: u32,
    ) -> Option<Vec<Line>> {
        let mut s = self.state.borrow_mut();
        let want = |s: &mut ImageState| {
            let id = &attachment.id;
            if !s.loading.contains(id)
                && !s.failed.contains(id)
                && !s.wanted.iter().any(|a| &a.id == id)
            {
                s.wanted.push(attachment.clone());
            }
        };
        let Some((width, height)) = s.sizes.get(&attachment.id).copied() else {
            want(&mut s);
            return None;
        };
        let (cols, rows) = image_cells(width, height, cell, max_cols, max_rows);
        let key = (attachment.id.clone(), cols, rows);
        if let Some(id) = s.ids.get(&key).copied()
            && s.sent.contains(&id)
        {
            return Some(placeholder_lines(id, cols, rows));
        }
        // A new size needs the pixels again.
        let Some(bitmap) = s.bitmaps.get(&attachment.id).cloned() else {
            want(&mut s);
            return None;
        };
        let id = match s.ids.get(&key) {
            Some(id) => *id,
            None => {
                let id = s.next_id;
                s.next_id += 1;
                s.ids.insert(key, id);
                id
            }
        };
        if s.sent.insert(id) {
            // At no more pixels than its cells show.
            let scale = 1f64
                .min((cols * cell.width) as f64 / bitmap.width as f64)
                .min((rows * cell.height) as f64 / bitmap.height as f64);
            let w = ((bitmap.width as f64 * scale).round() as u32).max(1);
            let h = ((bitmap.height as f64 * scale).round() as u32).max(1);
            let pixels = resize(&bitmap, w, h);
            s.transmit.push(transmit(&pixels, id, cols, rows));
        }
        Some(placeholder_lines(id, cols, rows))
    }
}

/// One message's rendered markdown per message id, with the content and width it was rendered from.
type Rendered<T> = RefCell<HashMap<String, (String, usize, Rc<T>)>>;

/// Rendered markdown, kept per message while its content and the width stay the same.
#[derive(Default)]
pub struct MarkdownCache {
    lines: Rendered<Vec<Line>>,
    parts: Rendered<Vec<MessagePart>>,
}

/// The cached rendering of `content` at `width`, or a new one.
fn cached<T>(
    map: &Rendered<T>,
    id: &str,
    content: &str,
    width: usize,
    render: impl FnOnce() -> T,
) -> Rc<T> {
    let mut map = map.borrow_mut();
    if let Some((c, w, rendered)) = map.get(id)
        && c == content
        && *w == width
    {
        return rendered.clone();
    }
    let rendered = Rc::new(render());
    map.insert(
        id.to_string(),
        (content.to_string(), width, rendered.clone()),
    );
    rendered
}

impl MarkdownCache {
    pub fn lines(&self, id: &str, content: &str, width: usize) -> Rc<Vec<Line>> {
        cached(&self.lines, id, content, width, || {
            render_markdown(content, width)
        })
    }

    pub fn parts(&self, id: &str, content: &str, width: usize) -> Rc<Vec<MessagePart>> {
        cached(&self.parts, id, content, width, || {
            render_message_parts(content, width)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(id: &str) -> AttachmentMeta {
        AttachmentMeta {
            id: id.into(),
            filename: format!("{id}.png"),
            media_type: "image/png".into(),
            size_bytes: 0.0,
            category: "image".into(),
            expired: false,
            inline: true,
        }
    }

    #[test]
    fn a_picture_on_screen_is_not_loaded_again_after_eviction() {
        let store = ImageStore::new();
        let cell = Cell {
            width: 10,
            height: 20,
        };
        let side = 2048u32;
        let big = |_: usize| {
            Arc::new(Bitmap {
                width: side,
                height: side,
                data: vec![0; (side * side * 4) as usize],
            })
        };
        let ids: Vec<String> = (0..5).map(|i| format!("a{i}")).collect();
        for (i, id) in ids.iter().enumerate() {
            assert!(store.placeholder(&attachment(id), cell, 4, 2).is_none());
            store.take_wanted();
            store.loaded(id.clone(), Some(big(i)));
            assert!(store.placeholder(&attachment(id), cell, 4, 2).is_some());
        }
        // The first picture's pixels were evicted, and it still draws at the size it was stored at.
        assert!(!store.state.borrow().bitmaps.contains_key("a0"));
        for id in &ids {
            assert!(store.placeholder(&attachment(id), cell, 4, 2).is_some());
        }
        assert!(store.take_wanted().is_empty());
    }
}
