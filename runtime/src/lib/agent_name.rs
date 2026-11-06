//! The rule for a name the agent gives itself.
//!
//! The name is sent to other agents' prompts, people's notifications and the
//! systems that show it, and the agent can be talked into renaming itself. The
//! rule limits which characters a name may have: letters of any script with
//! their marks, digits, single spaces, and `- ' ’ . &`. That keeps markup, line
//! breaks, quotes, role markers such as `System:`, emoji and invisible
//! characters out of every place the name goes. A name of permitted characters
//! passes whatever it says ("Ignore previous instructions" is letters and
//! spaces), so every place that shows a name shows it as data.
//!
//! Invisible characters are refused even where a script uses them: Unicode's
//! default-ignorable characters, such as the zero-width non-joiner some
//! Persian words take, a Hangul filler that counts as a letter, or a variation
//! selector that counts as a mark. A name that needs one is written without
//! it.

use std::sync::LazyLock;

use regex::Regex;

use crate::support::js::len16;

/// The longest name, in UTF-16 code units.
pub const AGENT_NAME_MAX: usize = 64;

/// What a refused name is told: the agent reads it from `rename_self` and can pick another.
pub const AGENT_NAME_RULE: &str = "Use a name of up to 64 characters, with letters, digits and spaces. It may also contain - ' . and &.";

/// Combining marks in a row after a letter: enough for any script's letters, too few to stack text over a line.
const MAX_MARKS_IN_A_ROW: usize = 3;

static LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{L}$").unwrap());
static MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{M}$").unwrap());
static DIGIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{Nd}$").unwrap());
static INVISIBLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\p{Default_Ignorable_Code_Point}$").unwrap());
static SPACE_RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" {2,}").unwrap());
const PUNCTUATION: [char; 5] = ['-', '\'', '\u{2019}', '.', '&'];

/// The name, normalised to NFC, trimmed, with runs of spaces made one; or
/// `None` when it breaks the rule. An empty name breaks it.
pub fn normalise_agent_name(name: &str) -> Option<String> {
    let normalized = nfc(name);
    let value = SPACE_RUNS
        .replace_all(js_trim(&normalized), " ")
        .into_owned();
    if value.is_empty() || len16(&value) > AGENT_NAME_MAX || !follows_rule(&value) {
        return None;
    }
    Some(value)
}

fn follows_rule(value: &str) -> bool {
    let mut marks = 0usize;
    let mut after_letter = false;
    let mut has_letter_or_digit = false;
    let mut buf = [0u8; 4];
    for ch in value.chars() {
        let text: &str = ch.encode_utf8(&mut buf);
        if INVISIBLE.is_match(text) {
            return false;
        }
        if LETTER.is_match(text) {
            has_letter_or_digit = true;
            after_letter = true;
            marks = 0;
        } else if MARK.is_match(text) {
            // A mark belongs to the letter before it, and only a few may stack.
            marks += 1;
            if !after_letter || marks > MAX_MARKS_IN_A_ROW {
                return false;
            }
        } else if DIGIT.is_match(text) {
            has_letter_or_digit = true;
            after_letter = false;
            marks = 0;
        } else if ch == ' ' || PUNCTUATION.contains(&ch) {
            after_letter = false;
            marks = 0;
        } else {
            return false;
        }
    }
    has_letter_or_digit
}

/// `String.prototype.normalize('NFC')`.
fn nfc(text: &str) -> String {
    todo!("NFC normalization needs the unicode-normalization crate")
}

/// `String.prototype.trim`: JavaScript's white space and line terminators.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}
