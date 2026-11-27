//! Decoding an inline image to pixels. PNG, JPEG, GIF and WebP are the types the
//! runtime shows inline; an animated GIF or WebP shows its first frame.

use super::bitmap::{Bitmap, resize};

/// The most pixels a decode may produce: about 6300 × 6300, 160 MB of RGBA.
pub const MAX_DECODED_PIXELS: u64 = 40_000_000;

/// The longest side a decoded picture keeps: more than any terminal shows of it.
const MAX_SIDE: u32 = 2048;

/// The size a PNG, GIF or WebP header declares, or `None` if the header cannot be read.
pub fn declared_size(bytes: &[u8], media_type: &str) -> Option<(u32, u32)> {
    let ascii = |at: usize, len: usize| {
        bytes
            .get(at..at + len)
            .map(|b| String::from_utf8_lossy(b).into_owned())
    };
    let u32_be = |at: usize| {
        bytes
            .get(at..at + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    let u16_le = |at: usize| {
        bytes
            .get(at..at + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]) as u32)
    };
    let u24_le = |at: usize| {
        bytes
            .get(at..at + 3)
            .map(|b| b[0] as u32 | (b[1] as u32) << 8 | (b[2] as u32) << 16)
    };
    match media_type {
        "image/png" => (ascii(12, 4)? == "IHDR").then(|| Some((u32_be(16)?, u32_be(20)?)))?,
        "image/gif" => (ascii(0, 3)? == "GIF").then(|| Some((u16_le(6)?, u16_le(8)?)))?,
        "image/webp" => {
            if ascii(0, 4)? != "RIFF" || ascii(8, 4)? != "WEBP" {
                return None;
            }
            match ascii(12, 4)?.as_str() {
                "VP8X" => Some((u24_le(24)? + 1, u24_le(27)? + 1)),
                "VP8 " => Some((u16_le(26)? & 0x3fff, u16_le(28)? & 0x3fff)),
                "VP8L" => {
                    let bits = bytes
                        .get(21..25)
                        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))?;
                    Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// Decode `bytes` of `media_type` to RGBA pixels, at most `MAX_SIDE` on the longer side.
pub fn decode_image(bytes: &[u8], media_type: &str) -> Result<Bitmap, String> {
    let format = match media_type {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/gif" => image::ImageFormat::Gif,
        "image/webp" => image::ImageFormat::WebP,
        other => return Err(format!("no decoder for {other}")),
    };
    if media_type != "image/jpeg" {
        let (w, h) = declared_size(bytes, media_type)
            .ok_or_else(|| format!("unreadable {media_type} header"))?;
        if w as u64 * h as u64 > MAX_DECODED_PIXELS {
            return Err(format!("{media_type} of {w}×{h} is too large to decode"));
        }
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODED_PIXELS * 4 + 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|e| e.to_string())?.to_rgba8();
    let bitmap = Bitmap {
        width: decoded.width(),
        height: decoded.height(),
        data: decoded.into_raw(),
    };
    Ok(shrink(bitmap))
}

fn shrink(bitmap: Bitmap) -> Bitmap {
    let longest = bitmap.width.max(bitmap.height);
    if longest <= MAX_SIDE {
        return bitmap;
    }
    let scale = MAX_SIDE as f64 / longest as f64;
    let w = ((bitmap.width as f64 * scale).round() as u32).max(1);
    let h = ((bitmap.height as f64 * scale).round() as u32).max(1);
    resize(&bitmap, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_1x1() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn reads_the_png_header() {
        assert_eq!(declared_size(&png_1x1(), "image/png"), Some((3, 2)));
    }

    #[test]
    fn decodes_a_png() {
        let bitmap = decode_image(&png_1x1(), "image/png").unwrap();
        assert_eq!((bitmap.width, bitmap.height), (3, 2));
        assert_eq!(&bitmap.data[..4], &[10, 20, 30, 255]);
    }

    #[test]
    fn refuses_unknown_types() {
        assert!(decode_image(b"x", "image/bmp").is_err());
    }
}
