//! Time zone names the runtime can compute dates in.

use std::str::FromStr;

/// Whether `name` is a time zone this runtime can compute dates in: an IANA name
/// such as `Europe/Helsinki`.
///
/// `Intl.DateTimeFormat` matches a zone name without regard to case, so the
/// lookup does too.
pub fn is_timezone(name: &str) -> bool {
    resolve_timezone(name).is_some()
}

/// The zone `name` names, matched without regard to case as `Intl.DateTimeFormat`
/// matches it. `None` for a name that is not a zone.
pub fn resolve_timezone(name: &str) -> Option<chrono_tz::Tz> {
    chrono_tz::Tz::from_str(name).ok().or_else(|| {
        chrono_tz::TZ_VARIANTS
            .iter()
            .find(|tz| tz.name().eq_ignore_ascii_case(name))
            .copied()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_an_iana_zone_name_and_utc() {
        assert!(is_timezone("Europe/Helsinki"));
        assert!(is_timezone("europe/helsinki"));
        assert!(is_timezone("UTC"));
    }

    #[test]
    fn rejects_a_name_no_date_can_be_computed_in() {
        assert!(!is_timezone("Nope/Zone"));
        assert!(!is_timezone("Mars/Olympus"));
        assert!(!is_timezone(""));
    }

    #[test]
    fn resolves_a_name_in_any_case_to_the_zone() {
        assert_eq!(
            resolve_timezone("europe/helsinki"),
            Some(chrono_tz::Europe::Helsinki)
        );
        assert_eq!(resolve_timezone("Nope/Zone"), None);
    }
}
