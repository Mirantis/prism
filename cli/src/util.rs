//! Small helpers that keep JavaScript's formatting and ordering where the text
//! on screen depends on them.

use std::cmp::Ordering;

/// A number as JavaScript prints it: `58` for an integral value, `58.5` otherwise.
pub fn js_number(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e21 {
        return format!("{}", n as i64);
    }
    format!("{n}")
}

/// An approximation of `String.prototype.localeCompare` for file names: case-insensitive first.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prints_numbers_like_javascript() {
        assert_eq!(js_number(58.0), "58");
        assert_eq!(js_number(1.5), "1.5");
    }
}
