//! Decoded pixels, and scaling them down to the cells a picture takes.

/// Four bytes per pixel in RGBA order, rows top to bottom.
#[derive(Clone, Debug, PartialEq)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// Scale to `width` × `height` by averaging every source pixel a target pixel
/// covers. Colour is weighted by alpha, so a transparent pixel adds no colour.
pub fn resize(source: &Bitmap, width: u32, height: u32) -> Bitmap {
    if source.width == width && source.height == height {
        return source.clone();
    }
    let (sw, sh) = (source.width as usize, source.height as usize);
    let (w, h) = (width as usize, height as usize);
    let mut data = vec![0u8; w * h * 4];
    let x_scale = sw as f64 / w as f64;
    let y_scale = sh as f64 / h as f64;
    for y in 0..h {
        let y0 = (y as f64 * y_scale).floor() as usize;
        let y1 = (y0 + 1)
            .max(((y + 1) as f64 * y_scale).floor() as usize)
            .min(sh);
        for x in 0..w {
            let x0 = (x as f64 * x_scale).floor() as usize;
            let x1 = (x0 + 1)
                .max(((x + 1) as f64 * x_scale).floor() as usize)
                .min(sw);
            let (mut r, mut g, mut b, mut a, mut count) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1 {
                let mut at = (sy * sw + x0) * 4;
                for _ in x0..x1 {
                    let alpha = source.data[at + 3] as u64;
                    r += source.data[at] as u64 * alpha;
                    g += source.data[at + 1] as u64 * alpha;
                    b += source.data[at + 2] as u64 * alpha;
                    a += alpha;
                    count += 1;
                    at += 4;
                }
            }
            let out = (y * w + x) * 4;
            if a > 0 {
                data[out] = (r as f64 / a as f64).round() as u8;
                data[out + 1] = (g as f64 / a as f64).round() as u8;
                data[out + 2] = (b as f64 / a as f64).round() as u8;
            }
            if count > 0 {
                data[out + 3] = (a as f64 / count as f64).round() as u8;
            }
        }
    }
    Bitmap {
        width,
        height,
        data,
    }
}

/// The tallest picture, in rows.
pub const MAX_IMAGE_ROWS: u32 = 24;

/// The widest picture, in columns: the chat column without the floor that keeps text readable.
pub fn image_columns(terminal_columns: usize) -> u32 {
    (terminal_columns.saturating_sub(6)).max(1) as u32
}

/// The cells a picture takes: its own size in cells, made smaller to fit
/// `max_cols` × `max_rows` with its proportions kept. A picture is never enlarged.
pub fn image_cells(
    width: u32,
    height: u32,
    cell: super::graphics::Cell,
    max_cols: u32,
    max_rows: u32,
) -> (u32, u32) {
    let natural_cols = width as f64 / cell.width as f64;
    let natural_rows = height as f64 / cell.height as f64;
    let scale = 1f64
        .min(max_cols as f64 / natural_cols)
        .min(max_rows as f64 / natural_rows);
    let cols = ((natural_cols * scale).round() as u32).clamp(1, max_cols.max(1));
    let rows = ((natural_rows * scale).round() as u32).clamp(1, max_rows.max(1));
    (cols, rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::graphics::Cell;

    #[test]
    fn averages_pixels() {
        let source = Bitmap {
            width: 2,
            height: 1,
            data: vec![0, 0, 0, 255, 255, 255, 255, 255],
        };
        let out = resize(&source, 1, 1);
        assert_eq!(out.data, vec![128, 128, 128, 255]);
    }

    #[test]
    fn fits_a_picture_in_cells() {
        let cell = Cell {
            width: 10,
            height: 20,
        };
        assert_eq!(image_cells(100, 100, cell, 80, 24), (10, 5));
        assert_eq!(image_cells(2000, 200, cell, 80, 24), (80, 4));
    }
}
