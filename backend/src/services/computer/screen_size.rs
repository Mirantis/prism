//! Screen and picture sizes: the bounds a desktop is held to, and the picture the model
//! is shown of a screen.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ScreenSize {
    pub width: i64,
    pub height: i64,
}

/// Bounds for desktop dimensions supplied internally.
pub const MAX_SCREEN: ScreenSize = ScreenSize {
    width: 1920,
    height: 1080,
};

/// Below this a desktop has no room for a window, and a client this small is a mistake.
pub const MIN_SCREEN: ScreenSize = ScreenSize {
    width: 640,
    height: 360,
};

/// The persistent desktop size.
pub const DEFAULT_SCREEN: ScreenSize = ScreenSize {
    width: 1920,
    height: 1080,
};

/// The widest picture the model is given, whatever the screen is.
///
/// Its coordinates are in this picture and `DesktopControl` maps them back, so a bigger
/// screen costs the model nothing and loses it nothing it was reading anyway.
pub const PICTURE_MAX_WIDTH: i64 = 1280;

/// How much the grab is enlarged for OCR; see `screen_text.rs`.
pub const OCR_SCALE: i64 = 2;

/// The most pixels a picture of a remote display has; a vision model shrinks a larger one.
const PICTURE_MAX_PIXELS: f64 = 1280.0 * 900.0;

/// `Math.round`: halves round toward positive infinity.
pub(crate) fn math_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// Even numbers, since a JPEG's chroma is stored for each pair of pixels.
fn even(n: f64) -> i64 {
    (math_round(n / 2.0) * 2.0).max(2.0) as i64
}

/// A size a client asked for, brought inside the bounds the display can serve.
pub fn clamp_screen(width: f64, height: f64) -> ScreenSize {
    let w = if width.is_finite() {
        width
    } else {
        DEFAULT_SCREEN.width as f64
    };
    let h = if height.is_finite() {
        height
    } else {
        DEFAULT_SCREEN.height as f64
    };
    ScreenSize {
        width: even((MAX_SCREEN.width as f64).min((MIN_SCREEN.width as f64).max(w))),
        height: even((MAX_SCREEN.height as f64).min((MIN_SCREEN.height as f64).max(h))),
    }
}

/// The model's picture of a screen this size: the screen itself while it is small enough,
/// and otherwise scaled down to the cap with its shape kept.
///
/// The shape is kept so that what the model sees is what is there. Coordinates would map
/// back correctly from a stretched picture too, since each axis is scaled on its own, but
/// a stretched screen is a worse thing to read.
pub fn picture_for(screen: ScreenSize) -> ScreenSize {
    if screen.width <= PICTURE_MAX_WIDTH {
        return screen;
    }
    let scale = PICTURE_MAX_WIDTH as f64 / screen.width as f64;
    ScreenSize {
        width: PICTURE_MAX_WIDTH,
        height: even(screen.height as f64 * scale),
    }
}

/// The model's picture of a remote display, which can be any shape: its long edge at most
/// `PICTURE_MAX_WIDTH` and its area at most `PICTURE_MAX_PIXELS`, with its shape kept.
pub fn bounded_picture_for(screen: ScreenSize) -> ScreenSize {
    let width = screen.width as f64;
    let height = screen.height as f64;
    let scale = 1.0_f64
        .min(PICTURE_MAX_WIDTH as f64 / width.max(height))
        .min((PICTURE_MAX_PIXELS / (width * height)).sqrt());
    ScreenSize {
        width: even(width * scale),
        height: even(height * scale),
    }
}

pub fn size_text(size: ScreenSize) -> String {
    format!("{}x{}", size.width, size.height)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(width: i64, height: i64) -> ScreenSize {
        ScreenSize { width, height }
    }

    #[test]
    fn takes_a_size_the_display_can_serve_as_it_is() {
        assert_eq!(clamp_screen(1600.0, 900.0), size(1600, 900));
    }

    #[test]
    fn holds_a_client_to_what_the_x_server_reserved() {
        // The framebuffer is allocated once, so anything past it is a size the display
        // cannot become however the client asks.
        assert_eq!(clamp_screen(5000.0, 3000.0), MAX_SCREEN);
    }

    #[test]
    fn holds_a_client_up_to_a_screen_with_room_for_a_window() {
        assert_eq!(clamp_screen(10.0, 10.0), MIN_SCREEN);
    }

    #[test]
    fn rounds_to_whole_pairs_of_pixels() {
        assert_eq!(clamp_screen(1001.0, 563.0), size(1002, 564));
    }

    #[test]
    fn falls_back_on_a_size_that_is_not_a_number() {
        assert_eq!(clamp_screen(f64::NAN, 720.0), size(1920, 720));
    }

    #[test]
    fn gives_the_model_the_screen_itself_while_it_is_small_enough() {
        assert_eq!(picture_for(size(1280, 720)), size(1280, 720));
        assert_eq!(picture_for(size(1024, 640)), size(1024, 640));
    }

    #[test]
    fn caps_a_larger_screen_without_changing_its_shape() {
        let picture = picture_for(size(1920, 1080));
        assert_eq!(picture.width, PICTURE_MAX_WIDTH);
        assert_eq!(picture.height, 720);
    }

    #[test]
    fn keeps_the_shape_of_a_screen_that_is_not_sixteen_by_nine() {
        let picture = picture_for(size(1920, 1200));
        assert_eq!(picture.width, PICTURE_MAX_WIDTH);
        assert_eq!(picture.height, 800);
    }

    #[test]
    fn formats_dimensions_for_ffmpeg() {
        assert_eq!(size_text(size(1280, 720)), "1280x720");
    }
}
