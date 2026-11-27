//! How this terminal can draw a picture, asked of the terminal at start-up.
//!
//! The kitty graphics protocol with Unicode placeholders where the terminal draws
//! them; the image's description everywhere else.

use std::sync::LazyLock;

use regex::Regex;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cell {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerminalGraphics {
    pub kitty: bool,
    /// The pixel size of one cell, when the terminal reported it.
    pub cell: Option<Cell>,
}

impl TerminalGraphics {
    pub const TEXT: TerminalGraphics = TerminalGraphics {
        kitty: false,
        cell: None,
    };
}

const QUERY_ID: u32 = 31;
const PLACEHOLDER_QUERY_ID: u32 = 32;

/// A graphics query for a 1×1 picture, a feature query for Unicode placeholders,
/// the cell size in pixels, XTVERSION, then primary device attributes. Every
/// terminal answers the last one, so its answer ends the wait.
pub const PROBE: &str = concat!(
    "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\",
    "\x1b_Ga=q,i=32,e=T,U=1\x1b\\",
    "\x1b[16t\x1b[>0q\x1b[c",
);

static GRAPHICS_REPLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b_G([^\x1b]*)\x1b\\").unwrap());
static CELL_REPLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[6;(\d+);(\d+)t").unwrap());
static VERSION_REPLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1bP>\|([^\x1b]*)\x1b\\").unwrap());
static ATTRIBUTES_REPLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[\?[\d;]*c").unwrap());
static PARTIAL_REPLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b(?:\[\??[\d;]*|_G[^\x1b]*|P>\|[^\x1b]*)?$").unwrap());

#[derive(Debug, PartialEq)]
pub struct ProbeReplies {
    pub graphics: bool,
    /// The feature query reports `U=1`: the terminal draws Unicode placeholders.
    pub placeholders: bool,
    pub cell: Option<Cell>,
    pub terminal: Option<String>,
    /// The device attributes arrived, so every other answer has too.
    pub complete: bool,
    /// Whatever else arrived: keys the person typed during the wait.
    pub rest: String,
}

pub fn parse_probe_replies(input: &str) -> ProbeReplies {
    let (mut graphics, mut placeholders) = (false, false);
    let query = format!("i={QUERY_ID}");
    let placeholder_query = format!("i={PLACEHOLDER_QUERY_ID}");
    for c in GRAPHICS_REPLY.captures_iter(input) {
        let Some(keys) = c[1].strip_suffix(";OK") else {
            continue;
        };
        let keys: Vec<&str> = keys.split(',').collect();
        if keys.contains(&query.as_str()) {
            graphics = true;
        }
        if keys.contains(&placeholder_query.as_str())
            && keys.contains(&"e=T")
            && keys.contains(&"U=1")
        {
            placeholders = true;
        }
    }
    let cell = CELL_REPLY.captures(input).and_then(|c| {
        let height: u32 = c[1].parse().ok()?;
        let width: u32 = c[2].parse().ok()?;
        (width > 0 && height > 0).then_some(Cell { width, height })
    });
    let terminal = VERSION_REPLY.captures(input).map(|c| c[1].to_string());
    let complete = ATTRIBUTES_REPLY.is_match(input);
    let rest = GRAPHICS_REPLY.replace_all(input, "");
    let rest = CELL_REPLY.replace_all(&rest, "");
    let rest = VERSION_REPLY.replace_all(&rest, "");
    let rest = ATTRIBUTES_REPLY.replace_all(&rest, "").into_owned();
    ProbeReplies {
        graphics,
        placeholders,
        cell,
        terminal,
        complete,
        rest,
    }
}

/// The XTVERSION names of the terminals that draw Unicode placeholders without
/// answering the feature query, with the first version that draws them. Other
/// terminals that answer the graphics query draw placeholders as unknown characters.
pub fn draws_placeholders(terminal: Option<&str>) -> bool {
    static TERMINALS: LazyLock<Vec<(Regex, Vec<u32>)>> = LazyLock::new(|| {
        vec![
            (Regex::new(r"^kitty\((\d+)\.(\d+)").unwrap(), vec![0, 28]),
            (Regex::new(r"(?i)^ghostty\b").unwrap(), vec![]),
            (
                Regex::new(r"^Rio (\d+)\.(\d+)\.(\d+)").unwrap(),
                vec![0, 3, 11],
            ),
            (Regex::new(r"^rex\b").unwrap(), vec![]),
        ]
    });
    let Some(terminal) = terminal else {
        return false;
    };
    TERMINALS.iter().any(|(name, min)| {
        name.captures(terminal).is_some_and(|c| {
            let version: Vec<u32> = c
                .iter()
                .skip(1)
                .map(|m| m.map_or(0, |m| m.as_str().parse().unwrap_or(0)))
                .collect();
            at_least(&version, min)
        })
    })
}

/// `version` is `min` or newer, compared part by part.
fn at_least(version: &[u32], min: &[u32]) -> bool {
    for (i, part) in min.iter().enumerate() {
        let found = version.get(i).copied().unwrap_or(0);
        if found != *part {
            return found > *part;
        }
    }
    true
}

pub fn graphics_from(replies: &ProbeReplies) -> TerminalGraphics {
    TerminalGraphics {
        kitty: replies.placeholders
            || (replies.graphics && draws_placeholders(replies.terminal.as_deref())),
        cell: replies.cell,
    }
}

/// The keys typed during the wait, less an answer the wait ended in the middle of.
pub fn typed_during_probe(replies: &ProbeReplies) -> String {
    if replies.complete {
        return replies.rest.clone();
    }
    PARTIAL_REPLY.replace(&replies.rest, "").into_owned()
}

/// A whole answer to the probe that arrived after the wait, with its escape stripped.
pub fn is_late_probe_reply(input: &str) -> bool {
    static ATTRS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\x1b?\[\?[\d;]*c$").unwrap());
    static CELL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\x1b?\[6;\d+;\d+t$").unwrap());
    ATTRS.is_match(input) || CELL.is_match(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_kitty_answer() {
        let r = parse_probe_replies(
            "\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t\x1bP>|kitty(0.36.4)\x1b\\\x1b[?62;c",
        );
        assert!(r.complete && r.graphics);
        assert_eq!(
            r.cell,
            Some(Cell {
                width: 10,
                height: 20
            })
        );
        assert!(graphics_from(&r).kitty);
        assert_eq!(r.rest, "");
    }

    #[test]
    fn a_plain_terminal_shows_text() {
        let r = parse_probe_replies("x\x1b[?62;22c");
        assert!(!graphics_from(&r).kitty);
        assert_eq!(r.rest, "x");
    }

    #[test]
    fn knows_which_terminals_draw_placeholders() {
        assert!(draws_placeholders(Some("kitty(0.28.0)")));
        assert!(!draws_placeholders(Some("kitty(0.27.9)")));
        assert!(draws_placeholders(Some("ghostty 1.0")));
        assert!(!draws_placeholders(Some("WezTerm")));
    }

    #[test]
    fn drops_a_partial_answer() {
        let r = parse_probe_replies("ab\x1b[?6");
        assert_eq!(typed_during_probe(&r), "ab");
    }

    const REX_REPLIES: &str = "\x1b_Gi=31;OK\x1b\\\x1b_Gi=32;EINVAL: dimensions required\x1b\\\x1b[6;16;8t\x1bP>|rex 0.1.0-preview.23\x1b\\\x1b[?62;22c";
    const RIO_REPLIES: &str = "\x1b_Gi=31;OK\x1b\\\x1b_Gi=32;EINVAL: dimensions required\x1b\\\x1b[6;20;10t\x1bP>|Rio 0.5.32\x1b\\\x1b[?62;4;6;22;52c";
    const KONSOLE_REPLIES: &str = "\x1b_Gi=31;OK\x1b\\\x1b_Gi=32;OK\x1b\\\x1b[6;17;8t\x1bP>|Konsole 25.08.3\x1b\\\x1b[?62;1;4c";
    const PLACEHOLDER_REPLY: &str = "\x1b_Gi=32,e=T,U=1;OK\x1b\\";

    #[test]
    fn reads_the_placeholder_feature_query() {
        assert!(parse_probe_replies(&format!("{PLACEHOLDER_REPLY}\x1b[?1;2c")).placeholders);
        assert!(parse_probe_replies("\x1b_GU=1,e=T,i=32;OK\x1b\\").placeholders);
        assert!(!parse_probe_replies("\x1b_Gi=32,e=T;OK\x1b\\").placeholders);
        assert!(!parse_probe_replies("\x1b_Gi=32;OK\x1b\\").placeholders);
        let rex = parse_probe_replies(REX_REPLIES);
        assert!(rex.graphics && !rex.placeholders && rex.rest.is_empty());
        assert!(!parse_probe_replies("\x1b_Gi=31;EINVAL:bad\x1b\\\x1b[?62;c").graphics);
    }

    #[test]
    fn knows_terminals_by_name_and_version() {
        for (terminal, expected) in [
            ("kitty(0.36.4)", true),
            ("kitty(0.28.0)", true),
            ("kitty(0.27.1)", false),
            ("ghostty 1.1.3", true),
            ("Rio 0.5.30", true),
            ("Rio 0.3.11", true),
            ("Rio 0.3.10", false),
            ("rex 0.1.0-preview.23", true),
            ("Konsole 24.08.3", false),
            ("WezTerm 20240203-110809-5046fc22", false),
        ] {
            assert_eq!(draws_placeholders(Some(terminal)), expected, "{terminal}");
        }
        assert!(!draws_placeholders(None));
    }

    #[test]
    fn draws_images_where_placeholders_draw() {
        let new_term =
            format!("\x1b_Gi=31;OK\x1b\\{PLACEHOLDER_REPLY}\x1bP>|NewTerm 1.0\x1b\\\x1b[?1;2c");
        assert!(graphics_from(&parse_probe_replies(&new_term)).kitty);
        let rex = graphics_from(&parse_probe_replies(REX_REPLIES));
        assert!(rex.kitty);
        assert_eq!(
            rex.cell,
            Some(Cell {
                width: 8,
                height: 16
            })
        );
        assert!(graphics_from(&parse_probe_replies(RIO_REPLIES)).kitty);
        assert!(
            !graphics_from(&parse_probe_replies(
                &RIO_REPLIES.replace("Rio 0.5.32", "Rio 0.3.10")
            ))
            .kitty
        );
        let konsole = graphics_from(&parse_probe_replies(KONSOLE_REPLIES));
        assert!(!konsole.kitty);
        assert_eq!(
            konsole.cell,
            Some(Cell {
                width: 8,
                height: 17
            })
        );
    }
}
