//! Mouse, keyboard and a camera for the virtual display: `xdotool` for the first two,
//! one `ffmpeg` grab for the third.
//!
//! The model works in the coordinates of the picture `capture()` returns: the screen, at
//! its own size or scaled down to the cap in `screen_size.rs`, and nothing drawn on it. A
//! labelled grid was tried as a ruler and measured against the truth; it made the model's
//! vertical estimates twenty to forty pixels worse, while on the plain picture they were
//! within six. `click()`, `move_to()`, `drag()` and `scroll()` take picture coordinates and
//! map them to the screen here, so the two never have to agree anywhere else.
//!
//! `mousemove` is never given `--sync`. That flag waits for the pointer to move, and when
//! the pointer is already where it is sent, which is the normal case after the model has
//! parked it there to check, the wait never ends and the command times out. The commands
//! in one call run in order without it.

use std::collections::HashMap;

use indexmap::IndexMap;
use std::sync::LazyLock;

use bytes::Bytes;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};

pub use super::screen_size::OCR_SCALE;
use super::screen_size::{ScreenSize, math_round, picture_for};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

impl MouseButton {
    pub fn as_str(self) -> &'static str {
        match self {
            MouseButton::Left => "left",
            MouseButton::Middle => "middle",
            MouseButton::Right => "right",
        }
    }

    /// The X11 button number: 1 left, 2 middle, 3 right.
    pub fn x11(self) -> &'static str {
        match self {
            MouseButton::Left => "1",
            MouseButton::Middle => "2",
            MouseButton::Right => "3",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
}

impl ScrollDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            ScrollDirection::Up => "up",
            ScrollDirection::Down => "down",
        }
    }

    /// The X11 wheel button: 4 up, 5 down.
    pub fn x11(self) -> &'static str {
        match self {
            ScrollDirection::Up => "4",
            ScrollDirection::Down => "5",
        }
    }
}

/// A key name or chord for `xdotool key`: `Return`, `ctrl+l`, `alt+F4`, `super`.
static KEY_CHORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$").expect("valid regex"));

/// Steps a drag is made of. Many programs only start a drag on motion after the press,
/// and a card or a window follows the pointer, so the path is walked rather than jumped.
const DRAG_STEPS: i64 = 8;

const COMMAND_TIMEOUT_MS: u64 = 10_000;
/// JPEG quality for the model's picture on ffmpeg's scale, where 2 is best and 31 worst.
const CAPTURE_QUALITY: i64 = 6;
const CAPTURE_MAX_BYTES: usize = 8 * 1024 * 1024;

/// A point in picture coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

struct Sizes {
    /// The screen's size in pixels, which the client changes as its own window changes.
    screen: ScreenSize,
    /// The model's picture, which its coordinates refer to.
    picture: ScreenSize,
}

pub struct DesktopControl {
    /// The display's: DISPLAY and XDG_RUNTIME_DIR.
    env: IndexMap<String, String>,
    sizes: Mutex<Sizes>,
}

impl DesktopControl {
    /// `env` is the display's: DISPLAY and XDG_RUNTIME_DIR. `screen` is its size in pixels.
    pub fn new(env: IndexMap<String, String>, screen: ScreenSize) -> Self {
        DesktopControl {
            env,
            sizes: Mutex::new(Sizes {
                screen,
                picture: picture_for(screen),
            }),
        }
    }

    pub fn width(&self) -> i64 {
        self.sizes.lock().screen.width
    }

    pub fn height(&self) -> i64 {
        self.sizes.lock().screen.height
    }

    pub fn picture_width(&self) -> i64 {
        self.sizes.lock().picture.width
    }

    pub fn picture_height(&self) -> i64 {
        self.sizes.lock().picture.height
    }

    /// Follow the screen to a new size.
    ///
    /// The display itself is resized by the computer that owns it; this is the record of it,
    /// and the coordinate mapping below is what has to agree with the pixels a grab returns.
    pub fn resize(&self, screen: ScreenSize) {
        *self.sizes.lock() = Sizes {
            screen,
            picture: picture_for(screen),
        };
    }

    /// Put the pointer on a point given in picture coordinates, without clicking.
    pub async fn move_to(&self, x: f64, y: f64) -> anyhow::Result<()> {
        todo!()
    }

    /// Click at a point given in picture coordinates, or where the pointer is when none is
    /// given. `button` defaults to left and `count` to 1 at the callers.
    pub async fn click(
        &self,
        at: Option<Point>,
        button: MouseButton,
        count: i64,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Press at one point, move to another, release, all in picture coordinates. One
    /// `xdotool` call holds the whole sequence, with `sleep`s between the steps.
    pub async fn drag(&self, from: Point, to: Point, button: MouseButton) -> anyhow::Result<()> {
        todo!()
    }

    pub async fn type_text(&self, text: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Fails with `"<chord>" is not a key name or chord` for anything `KEY_CHORD` refuses.
    pub async fn key(&self, chord: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Scroll the wheel over a point given in picture coordinates. `clicks` defaults to 3
    /// at the callers.
    pub async fn scroll(
        &self,
        x: f64,
        y: f64,
        direction: ScrollDirection,
        clicks: i64,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// The model's picture: the whole display at the picture size, as JPEG.
    pub async fn capture(&self) -> anyhow::Result<Bytes> {
        todo!()
    }

    /// A lossless PNG of the display enlarged `OCR_SCALE` times, for Tesseract.
    pub async fn capture_for_ocr(&self) -> anyhow::Result<Bytes> {
        todo!()
    }

    /// A screen pixel as a picture coordinate, the inverse of `to_screen`.
    pub fn to_picture(&self, x: f64, y: f64) -> (f64, f64) {
        let sizes = self.sizes.lock();
        (
            x * sizes.picture.width as f64 / sizes.screen.width as f64,
            y * sizes.picture.height as f64 / sizes.screen.height as f64,
        )
    }

    /// A picture coordinate as a screen pixel, kept on the screen.
    fn to_screen(&self, x: f64, y: f64) -> (i64, i64) {
        let sizes = self.sizes.lock();
        let sx = x * sizes.screen.width as f64 / sizes.picture.width as f64;
        let sy = y * sizes.screen.height as f64 / sizes.picture.height as f64;
        let px = ((sizes.screen.width - 1) as f64).min(math_round(sx).max(0.0));
        let py = ((sizes.screen.height - 1) as f64).min(math_round(sy).max(0.0));
        (px as i64, py as i64)
    }

    async fn xdotool(&self, args: &[String]) -> anyhow::Result<()> {
        todo!()
    }

    /// The process environment with the display's variables over it.
    fn process_env(&self) -> IndexMap<String, String> {
        let mut env: IndexMap<String, String> = std::env::vars().collect();
        env.extend(self.env.clone());
        env
    }
}
