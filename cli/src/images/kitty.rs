//! The kitty graphics protocol, Unicode-placeholder form
//! (https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders).
//!
//! The terminal stores the picture once, under an id, with a virtual placement of
//! a fixed size in cells. The picture shows wherever the screen holds its
//! placeholder cells: U+10EEEE coloured with the id, a diacritic naming the row.

use std::io::Write;

use base64::Engine;
use flate2::Compression;
use flate2::write::ZlibEncoder;

use super::bitmap::Bitmap;
use crate::term::style::{Color, Style};
use crate::term::text::{Line, Span};

const PLACEHOLDER: char = '\u{10EEEE}';

/// The first entries of kitty's row/column diacritics table: index n means row or column n.
const DIACRITICS: [u32; 48] = [
    0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c,
    0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
    0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
    0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
];

/// The terminal accepts a chunk of at most 4096 bytes of base64.
const CHUNK: usize = 4096;

/// The sequences that store `bitmap` under `id` with a virtual placement of
/// `cols` × `rows` cells, zlib-compressed, with `q=2` so the terminal stays quiet.
pub fn transmit(bitmap: &Bitmap, id: u32, cols: u32, rows: u32) -> String {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    let _ = encoder.write_all(&bitmap.data);
    let compressed = encoder.finish().unwrap_or_default();
    let payload = base64::engine::general_purpose::STANDARD.encode(compressed);
    let keys = format!(
        "a=T,U=1,i={id},c={cols},r={rows},f=32,s={},v={},o=z,q=2",
        bitmap.width, bitmap.height
    );
    let mut out = String::new();
    let mut at = 0;
    while at < payload.len() {
        let end = (at + CHUNK).min(payload.len());
        let more = u8::from(end < payload.len());
        let control = if at == 0 {
            format!("{keys},m={more}")
        } else {
            format!("q=2,m={more}")
        };
        out.push_str(&format!("\x1b_G{control};{}\x1b\\", &payload[at..end]));
        at = end;
    }
    out
}

/// The placeholder text for the placement of image `id`: one line per row.
pub fn placeholder_lines(id: u32, cols: u32, rows: u32) -> Vec<Line> {
    let style = Style::new().fg(Color::Exact((id >> 16) as u8, (id >> 8) as u8, id as u8));
    (0..rows)
        .map(|row| {
            let mut text = String::new();
            text.push(PLACEHOLDER);
            text.push(char::from_u32(DIACRITICS[row as usize % DIACRITICS.len()]).unwrap());
            text.push(char::from_u32(DIACRITICS[0]).unwrap());
            for _ in 1..cols {
                text.push(PLACEHOLDER);
            }
            Line::from_spans(vec![Span::new(text, style)])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_the_payload() {
        let bitmap = Bitmap {
            width: 1,
            height: 1,
            data: vec![255, 0, 0, 255],
        };
        let out = transmit(&bitmap, 7, 2, 1);
        assert!(out.starts_with("\x1b_Ga=T,U=1,i=7,c=2,r=1,f=32,s=1,v=1,o=z,q=2,m=0;"));
        assert!(out.ends_with("\x1b\\"));
    }

    #[test]
    fn colours_placeholders_with_the_id() {
        let lines = placeholder_lines(0x010203, 3, 2);
        assert_eq!(lines.len(), 2);
        let encoded = lines[0].encoded();
        assert!(encoded.starts_with("\x1b[38;2;1;2;3m\u{10EEEE}"));
        assert_eq!(lines[0].width(), 3);
    }
}
