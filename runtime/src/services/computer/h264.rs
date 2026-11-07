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

#[cfg(test)]
mod tests {
    use super::*;

    /// A NAL of `kind`, behind a start code of the length the encoder really varies.
    fn nal(kind: u8, body: &[u8], short: bool) -> Vec<u8> {
        let mut out = if short {
            vec![0x00, 0x00, 0x01]
        } else {
            vec![0x00, 0x00, 0x00, 0x01]
        };
        out.push(kind);
        out.extend_from_slice(body);
        out
    }

    fn delimiter() -> Vec<u8> {
        nal(9, &[0xf0], false)
    }

    /// The first three bytes of a parameter set are the profile, its constraints and the
    /// level.
    fn sps() -> Vec<u8> {
        nal(7, &[0x64, 0x00, 0x1f, 0xac], false)
    }

    fn pps() -> Vec<u8> {
        nal(8, &[0xeb, 0xe2], false)
    }

    fn idr() -> Vec<u8> {
        nal(5, &[0x88, 0x84, 0x00], false)
    }

    fn slice() -> Vec<u8> {
        nal(1, &[0x9a, 0x12], true)
    }

    fn concat(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.concat()
    }

    #[test]
    fn cuts_the_stream_where_each_picture_begins_and_keeps_the_last_one_back() {
        let first = concat(&[delimiter(), sps(), pps(), idr()]);
        let second = concat(&[delimiter(), slice()]);
        let third = concat(&[delimiter(), slice()]);

        let split = split_access_units(&Bytes::from(concat(&[
            first.clone(),
            second.clone(),
            third.clone(),
        ])));

        // A picture is only whole once the next one has started.
        assert_eq!(split.units.len(), 2);
        assert_eq!(split.units[0].as_ref(), first.as_slice());
        assert_eq!(split.units[1].as_ref(), second.as_slice());
        assert_eq!(split.rest.as_ref(), third.as_slice());
    }

    #[test]
    fn loses_nothing_when_the_bytes_arrive_in_pieces_of_any_size() {
        let stream = concat(&[
            delimiter(),
            sps(),
            pps(),
            idr(),
            delimiter(),
            slice(),
            delimiter(),
            slice(),
            delimiter(),
            slice(),
        ]);
        for size in [1usize, 3, 5, 64] {
            let mut pending: Vec<u8> = Vec::new();
            let mut seen: Vec<Bytes> = Vec::new();
            let mut i = 0;
            while i < stream.len() {
                pending.extend_from_slice(&stream[i..(i + size).min(stream.len())]);
                let out = split_access_units(&Bytes::from(pending.clone()));
                seen.extend(out.units);
                pending = out.rest.to_vec();
                i += size;
            }
            assert_eq!(seen.len(), 3);
            let mut joined: Vec<u8> = seen.iter().flat_map(|unit| unit.to_vec()).collect();
            joined.extend_from_slice(&pending);
            assert_eq!(joined, stream);
        }
    }

    #[test]
    fn holds_everything_back_until_a_second_picture_has_begun() {
        let whole = concat(&[delimiter(), sps(), pps(), idr()]);
        let split = split_access_units(&Bytes::from(whole.clone()));
        assert!(split.units.is_empty());
        assert_eq!(split.rest.len(), whole.len());
    }

    #[test]
    fn is_a_keyframe_for_a_picture_a_viewer_can_join_on() {
        assert!(is_keyframe(&concat(&[delimiter(), sps(), pps(), idr()])));
    }

    #[test]
    fn is_no_keyframe_for_one_that_needs_the_picture_before_it() {
        assert!(!is_keyframe(&concat(&[delimiter(), slice()])));
    }

    #[test]
    fn names_the_stream_from_its_parameter_set() {
        // What the encoder in the image really produced for a 1280x720 screen.
        assert_eq!(
            codec_from(&concat(&[delimiter(), sps(), pps(), idr()])).as_deref(),
            Some("avc1.64001F")
        );
    }

    #[test]
    fn has_no_name_until_a_parameter_set_arrives() {
        assert_eq!(codec_from(&concat(&[delimiter(), slice()])), None);
    }
}
