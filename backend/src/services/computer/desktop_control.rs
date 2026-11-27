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

use std::sync::LazyLock;

use bytes::Bytes;
use indexmap::IndexMap;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::child_process::{
    COMMAND_TIMEOUT_MS, DEFAULT_MAX_BUFFER, ExecFileOptions, exec_file, process_env,
};
pub use super::screen_size::OCR_SCALE;
use super::screen_size::{ScreenSize, picture_for, size_text};
use crate::support::js::round as js_round;

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
        let (px, py) = self.to_screen(x, y);
        self.xdotool(vec!["mousemove".into(), px.to_string(), py.to_string()])
            .await
    }

    /// Click at a point given in picture coordinates, or where the pointer is when none is
    /// given. `button` defaults to left and `count` to 1 at the callers.
    pub async fn click(
        &self,
        at: Option<Point>,
        button: MouseButton,
        count: i64,
    ) -> anyhow::Result<()> {
        let mut args: Vec<String> = Vec::new();
        if let Some(at) = at {
            let (px, py) = self.to_screen(at.x, at.y);
            args.extend(["mousemove".to_string(), px.to_string(), py.to_string()]);
        }
        args.extend([
            "click".to_string(),
            "--repeat".to_string(),
            count.to_string(),
            "--delay".to_string(),
            "80".to_string(),
            button.x11().to_string(),
        ]);
        self.xdotool(args).await
    }

    /// Press at one point, move to another, release, all in picture coordinates. One
    /// `xdotool` call holds the whole sequence, with `sleep`s between the steps.
    pub async fn drag(&self, from: Point, to: Point, button: MouseButton) -> anyhow::Result<()> {
        let (x0, y0) = self.to_screen(from.x, from.y);
        let (x1, y1) = self.to_screen(to.x, to.y);
        let mut args: Vec<String> = vec![
            "mousemove".into(),
            x0.to_string(),
            y0.to_string(),
            "mousedown".into(),
            button.x11().into(),
            "sleep".into(),
            "0.1".into(),
        ];
        for step in 1..=DRAG_STEPS {
            let x = js_round(x0 as f64 + ((x1 - x0) * step) as f64 / DRAG_STEPS as f64) as i64;
            let y = js_round(y0 as f64 + ((y1 - y0) * step) as f64 / DRAG_STEPS as f64) as i64;
            args.extend([
                "mousemove".to_string(),
                x.to_string(),
                y.to_string(),
                "sleep".to_string(),
                "0.03".to_string(),
            ]);
        }
        args.extend([
            "sleep".to_string(),
            "0.1".to_string(),
            "mouseup".to_string(),
            button.x11().to_string(),
        ]);
        self.xdotool(args).await
    }

    pub async fn type_text(&self, text: &str) -> anyhow::Result<()> {
        self.xdotool(vec![
            "type".into(),
            "--clearmodifiers".into(),
            "--delay".into(),
            "15".into(),
            "--".into(),
            text.to_string(),
        ])
        .await
    }

    /// Fails with `"<chord>" is not a key name or chord` for anything `KEY_CHORD` refuses.
    pub async fn key(&self, chord: &str) -> anyhow::Result<()> {
        if !KEY_CHORD.is_match(chord) {
            anyhow::bail!("\"{chord}\" is not a key name or chord");
        }
        self.xdotool(vec![
            "key".into(),
            "--clearmodifiers".into(),
            "--".into(),
            chord.to_string(),
        ])
        .await
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
        let (px, py) = self.to_screen(x, y);
        self.xdotool(vec![
            "mousemove".into(),
            px.to_string(),
            py.to_string(),
            "click".into(),
            "--repeat".into(),
            clicks.to_string(),
            "--delay".into(),
            "40".into(),
            direction.x11().into(),
        ])
        .await
    }

    /// The model's picture: the whole display at the picture size, as JPEG.
    pub async fn capture(&self) -> anyhow::Result<Bytes> {
        let (screen, picture) = {
            let sizes = self.sizes.lock();
            (sizes.screen, sizes.picture)
        };
        let args: Vec<String> = [
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-video_size",
            &size_text(screen),
            "-i",
            &self.display(),
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={}:{}", picture.width, picture.height),
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-q:v",
            &CAPTURE_QUALITY.to_string(),
            "-",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
        let env = self.process_env();
        let stdout = exec_file(
            "ffmpeg",
            &args,
            ExecFileOptions {
                env: &env,
                timeout_ms: COMMAND_TIMEOUT_MS,
                max_buffer: CAPTURE_MAX_BYTES,
            },
        )
        .await?;
        Ok(Bytes::from(stdout))
    }

    /// A lossless PNG of the display enlarged `OCR_SCALE` times, for Tesseract.
    pub async fn capture_for_ocr(&self) -> anyhow::Result<Bytes> {
        let screen = self.sizes.lock().screen;
        let args: Vec<String> = [
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-video_size",
            &size_text(screen),
            "-i",
            &self.display(),
            "-frames:v",
            "1",
            "-vf",
            &format!("scale=iw*{OCR_SCALE}:ih*{OCR_SCALE}"),
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "-",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
        let env = self.process_env();
        let stdout = exec_file(
            "ffmpeg",
            &args,
            ExecFileOptions {
                env: &env,
                timeout_ms: COMMAND_TIMEOUT_MS,
                max_buffer: CAPTURE_MAX_BYTES * 4,
            },
        )
        .await?;
        Ok(Bytes::from(stdout))
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
        let px = ((sizes.screen.width - 1) as f64).min(js_round(sx).max(0.0));
        let py = ((sizes.screen.height - 1) as f64).min(js_round(sy).max(0.0));
        (px as i64, py as i64)
    }

    /// The X display, e.g. `:99`.
    fn display(&self) -> String {
        self.env.get("DISPLAY").cloned().unwrap_or_default()
    }

    async fn xdotool(&self, args: Vec<String>) -> anyhow::Result<()> {
        let env = self.process_env();
        exec_file(
            "xdotool",
            &args,
            ExecFileOptions {
                env: &env,
                timeout_ms: COMMAND_TIMEOUT_MS,
                max_buffer: DEFAULT_MAX_BUFFER,
            },
        )
        .await?;
        Ok(())
    }

    /// The process environment with the display's variables over it.
    fn process_env(&self) -> IndexMap<String, String> {
        process_env(&self.env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> IndexMap<String, String> {
        IndexMap::from([("DISPLAY".to_string(), ":99".to_string())])
    }

    #[test]
    fn gives_the_model_the_screen_itself_while_it_is_small_enough() {
        let control = DesktopControl::new(
            env(),
            ScreenSize {
                width: 1280,
                height: 720,
            },
        );
        assert_eq!(control.picture_width(), 1280);
        assert_eq!(control.picture_height(), 720);
        assert_eq!(control.to_picture(640.0, 360.0), (640.0, 360.0));
    }

    #[test]
    fn maps_a_point_on_a_screen_larger_than_the_picture() {
        let control = DesktopControl::new(
            env(),
            ScreenSize {
                width: 1920,
                height: 1080,
            },
        );
        assert_eq!(control.picture_width(), 1280);
        assert_eq!(control.picture_height(), 720);
        // The middle of the screen is the middle of the picture, whatever the scale.
        assert_eq!(control.to_picture(960.0, 540.0), (640.0, 360.0));
    }

    #[test]
    fn follows_the_screen_when_the_client_resizes_it() {
        let control = DesktopControl::new(
            env(),
            ScreenSize {
                width: 1280,
                height: 720,
            },
        );
        control.resize(ScreenSize {
            width: 1920,
            height: 1200,
        });
        assert_eq!(control.width(), 1920);
        assert_eq!(control.height(), 1200);
        // The cap holds, and the shape follows the new screen rather than the old one.
        assert_eq!(control.picture_width(), 1280);
        assert_eq!(control.picture_height(), 800);
        assert_eq!(control.to_picture(960.0, 600.0), (640.0, 400.0));
    }

    #[tokio::test]
    async fn refuses_a_key_that_is_not_a_name_or_chord() {
        let control = DesktopControl::new(
            env(),
            ScreenSize {
                width: 1280,
                height: 720,
            },
        );
        let err = control.key("ctrl+;rm").await.unwrap_err();
        assert_eq!(err.to_string(), "\"ctrl+;rm\" is not a key name or chord");
    }
}
