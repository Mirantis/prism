//! Split the encoder's H.264 output into whole pictures, and read the two things the page
//! needs to know about each one: whether it is a keyframe, and which codec to decode it
//! with.
//!
//! The agent's screen is sent as H.264 because the alternative costs too much. A JPEG of
//! every frame sends the whole screen thirty times a second whether or not it changed: a
//! moving desktop measured 1,869 KB a second at 1280x720, and a still one still paid for
//! every pixel. H.264 sends the difference between one frame and the next, so the same
//! moving desktop costs 80 KB a second and a still one costs 4. Every browser that plays
//! video decodes it, and the runtime spends less processor time on it than on encoding
//! those JPEGs.
//!
//! Sending it needs the stream cut at picture boundaries, which is what this file does.
//! The encoder writes one long run of NAL units, each behind a start code of three or four
//! bytes. A picture is an access unit, which is several NALs together, and the encoder is
//! asked to put a delimiter NAL in front of each one, so a delimiter is where a picture
//! begins. Nothing here decodes anything: the runtime forwards whole pictures and the
//! browser decodes them.

use bytes::Bytes;

/// The five bits of a NAL's header byte that say what it is.
const NAL_DELIMITER: u8 = 9;
const NAL_IDR: u8 = 5;
const NAL_SPS: u8 = 7;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessUnits {
    /// Whole pictures, in order.
    pub units: Vec<Bytes>,
    /// The bytes after the last whole picture, to be read with what comes next.
    pub rest: Bytes,
}

/// Where each NAL's header byte is, and what kind it is.
fn nals(data: &[u8]) -> Vec<(usize, u8)> {
    // A start code is 00 00 01, with an extra 00 allowed in front of it.
    let mut found = Vec::new();
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] != 0 || data[i + 1] != 0 {
            i += 1;
            continue;
        }
        let header = if data[i + 2] == 1 {
            Some(i + 3)
        } else if data[i + 2] == 0 && data[i + 3] == 1 {
            Some(i + 4)
        } else {
            None
        };
        match header {
            Some(at) if at < data.len() => {
                found.push((at, data[at] & 0x1f));
                i = at + 1;
            }
            _ => i += 1,
        }
    }
    found
}

/// Split what has arrived into whole pictures.
///
/// A picture is only whole once the next one has started, so the last delimiter and
/// everything after it stays in `rest` until more bytes arrive.
pub fn split_access_units(data: &Bytes) -> AccessUnits {
    let mut starts = Vec::new();
    for (at, kind) in nals(data) {
        if kind != NAL_DELIMITER {
            continue;
        }
        // The picture starts at its start code, not at the header byte inside it.
        let four = at >= 4 && data[at - 4] == 0 && data[at - 3] == 0 && data[at - 2] == 0;
        starts.push(if four { at - 4 } else { at - 3 });
    }
    if starts.len() < 2 {
        return AccessUnits {
            units: Vec::new(),
            rest: data.clone(),
        };
    }
    let units = starts
        .windows(2)
        .map(|pair| data.slice(pair[0]..pair[1]))
        .collect();
    AccessUnits {
        units,
        rest: data.slice(starts[starts.len() - 1]..),
    }
}

/// Whether this picture can be decoded on its own, which is where a viewer can join.
pub fn is_keyframe(unit: &[u8]) -> bool {
    nals(unit).into_iter().any(|(_, kind)| kind == NAL_IDR)
}

/// The name the browser knows this stream by, read off its parameter set: the profile, the
/// constraints on it and the level, as the three bytes after the NAL header.
pub fn codec_from(unit: &[u8]) -> Option<String> {
    for (at, kind) in nals(unit) {
        if kind != NAL_SPS || at + 3 >= unit.len() {
            continue;
        }
        return Some(format!(
            "avc1.{:02X}{:02X}{:02X}",
            unit[at + 1],
            unit[at + 2],
            unit[at + 3]
        ));
    }
    None
}
