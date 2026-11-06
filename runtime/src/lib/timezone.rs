//! Time zone names the runtime can compute dates in.

use std::str::FromStr;

/// Whether `name` is a time zone this runtime can compute dates in: an IANA name
/// such as `Europe/Helsinki`.
///
/// `Intl.DateTimeFormat` matches a zone name without regard to case, so the
/// lookup does too.
pub fn is_timezone(name: &str) -> bool {
    chrono_tz::Tz::from_str(name).is_ok()
        || chrono_tz::TZ_VARIANTS
            .iter()
            .any(|tz| tz.name().eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_an_iana_name_and_refuses_anything_else() {
        assert!(is_timezone("Europe/Helsinki"));
        assert!(is_timezone("europe/helsinki"));
        assert!(is_timezone("UTC"));
        assert!(!is_timezone("Mars/Olympus"));
        assert!(!is_timezone(""));
    }
}
