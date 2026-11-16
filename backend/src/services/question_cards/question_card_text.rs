//! The two texts of a question card: the card as plain text, and the answers as the person's message.

use std::sync::LazyLock;

use regex::Regex;

use crate::protocol::chat_protocol::{QuestionCardAnswer, QuestionCardQuestion};

const CLOSING_LINE: &str = "Reply with 1a, 2b… or in your own words.";
const NO_ANSWER: &str = "no answer";

/// `/\s*[\r\n]+\s*/g`, with JavaScript's whitespace class.
static LINE_BREAK: LazyLock<Regex> = LazyLock::new(|| {
    let space = r"[\t\n\v\f\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
    Regex::new(&format!(r"{space}*[\r\n]+{space}*")).expect("valid regex")
});

/// Line breaks collapse to one space, so that each question stays one line of the answer message.
pub fn one_line(text: &str) -> String {
    LINE_BREAK.replace_all(text, " ").into_owned()
}

fn option_line(question: &QuestionCardQuestion, option_index: usize) -> String {
    let option = &question.options[option_index];
    let letter = char::from(b'a' + option_index as u8);
    let detail = option
        .detail
        .as_deref()
        .filter(|detail| !detail.is_empty())
        .map(|detail| format!(" – {detail}"))
        .unwrap_or_default();
    let recommended = if question.recommended.as_deref() == Some(option.label.as_str()) {
        " (recommended)"
    } else {
        ""
    };
    format!("   {letter}) {}{detail}{recommended}", option.label)
}

fn question_block(question: &QuestionCardQuestion, index: usize) -> String {
    let header = question
        .header
        .as_deref()
        .filter(|header| !header.is_empty())
        .map(|header| format!("{header}: "))
        .unwrap_or_default();
    let hint = if question.multi_select {
        " Choose any."
    } else {
        ""
    };
    let mut lines = vec![format!("{}. {header}{}{hint}", index + 1, question.text)];
    lines.extend((0..question.options.len()).map(|option| option_line(question, option)));
    lines.join("\n")
}

/// The message text of a card, which every channel that cannot draw the card shows.
pub fn question_card_text(questions: &[QuestionCardQuestion], intro: Option<&str>) -> String {
    let mut parts: Vec<String> = intro
        .filter(|intro| !intro.is_empty())
        .map(str::to_string)
        .into_iter()
        .collect();
    parts.push(
        questions
            .iter()
            .enumerate()
            .map(|(index, question)| question_block(question, index))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    parts.push(CLOSING_LINE.to_string());
    parts.join("\n\n")
}

fn answer_subject(question: &QuestionCardQuestion) -> String {
    if let Some(header) = question
        .header
        .as_deref()
        .filter(|header| !header.is_empty())
    {
        return format!("{}:", one_line(header));
    }
    let text = one_line(&question.text);
    if text.ends_with(['?', '!', ':', '.']) {
        text
    } else {
        format!("{text}:")
    }
}

fn answer_line(
    question: &QuestionCardQuestion,
    answer: &QuestionCardAnswer,
    index: usize,
) -> String {
    let mut chosen: Vec<String> = answer
        .options
        .iter()
        .map(|&option| one_line(&question.options[option as usize].label))
        .collect();
    if let Some(other) = answer.other.as_deref().filter(|other| !other.is_empty()) {
        chosen.push(other.to_string());
    }
    let chosen = if chosen.is_empty() {
        NO_ANSWER.to_string()
    } else {
        chosen.join(", ")
    };
    format!("{}. {} {chosen}", index + 1, answer_subject(question))
}

/// The message stored as the person's own: one line per question.
pub fn answer_message_text(
    questions: &[QuestionCardQuestion],
    answers: &[QuestionCardAnswer],
) -> String {
    questions
        .iter()
        .zip(answers)
        .enumerate()
        .map(|(index, (question, answer))| answer_line(question, answer, index))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::chat_protocol::QuestionCardOption;

    fn option(label: &str) -> QuestionCardOption {
        QuestionCardOption {
            label: label.to_string(),
            detail: None,
        }
    }

    fn question(text: &str) -> QuestionCardQuestion {
        QuestionCardQuestion {
            text: text.to_string(),
            header: None,
            options: vec![option("A"), option("B")],
            recommended: None,
            allow_other: true,
            multi_select: false,
        }
    }

    fn answer(options: &[u64], other: Option<&str>) -> QuestionCardAnswer {
        QuestionCardAnswer {
            options: options.to_vec(),
            other: other.map(str::to_string),
        }
    }

    fn budget() -> QuestionCardQuestion {
        QuestionCardQuestion {
            header: Some("Budget".into()),
            options: vec![
                QuestionCardOption {
                    label: "Under €500".into(),
                    detail: Some("fits the current plan".into()),
                },
                option("€500 to €2,000"),
                option("Over €2,000"),
            ],
            recommended: Some("Under €500".into()),
            ..question("How much can we spend each month?")
        }
    }

    fn channels() -> QuestionCardQuestion {
        QuestionCardQuestion {
            options: vec![option("LinkedIn"), option("Newsletter")],
            multi_select: true,
            ..question("Which channels should Lina use?")
        }
    }

    #[test]
    fn numbers_the_questions_letters_the_options_and_marks_the_recommended_one() {
        assert_eq!(
            question_card_text(&[budget(), channels()], Some("A few decisions first.")),
            [
                "A few decisions first.",
                "",
                "1. Budget: How much can we spend each month?",
                "   a) Under €500 – fits the current plan (recommended)",
                "   b) €500 to €2,000",
                "   c) Over €2,000",
                "2. Which channels should Lina use? Choose any.",
                "   a) LinkedIn",
                "   b) Newsletter",
                "",
                "Reply with 1a, 2b… or in your own words.",
            ]
            .join("\n")
        );
    }

    #[test]
    fn starts_at_the_first_question_with_no_intro_and_numbers_a_single_question_too() {
        assert_eq!(
            question_card_text(&[question("Pick one?")], None),
            "1. Pick one?\n   a) A\n   b) B\n\nReply with 1a, 2b… or in your own words."
        );
    }

    #[test]
    fn writes_one_line_per_question_with_a_blank_as_no_answer() {
        let launch = QuestionCardQuestion {
            header: Some("Launch".into()),
            options: vec![option("Soon"), option("After the summer")],
            ..question("When?")
        };
        let tone = QuestionCardQuestion {
            header: Some("Tone".into()),
            ..question("Which tone?")
        };
        assert_eq!(
            answer_message_text(
                &[budget(), channels(), launch, tone],
                &[
                    answer(&[0], None),
                    answer(&[0, 1], None),
                    answer(&[1], None),
                    answer(&[], None)
                ],
            ),
            [
                "1. Budget: Under €500",
                "2. Which channels should Lina use? LinkedIn, Newsletter",
                "3. Launch: After the summer",
                "4. Tone: no answer",
            ]
            .join("\n")
        );
    }

    #[test]
    fn adds_other_as_typed_after_the_chosen_options_and_without_quotes() {
        assert_eq!(
            answer_message_text(&[channels()], &[answer(&[1], Some("a stand at the fair"))]),
            "1. Which channels should Lina use? Newsletter, a stand at the fair"
        );
    }

    #[test]
    fn keeps_each_question_on_one_line_when_its_header_text_or_option_holds_a_line_break() {
        let broken = QuestionCardQuestion {
            header: Some("Bud\nget".into()),
            options: vec![option("First\r\n  part"), option("B")],
            ..question("Pick one?")
        };
        let plain = question("Pick\none?");
        assert_eq!(
            answer_message_text(&[broken, plain], &[answer(&[0], None), answer(&[1], None)]),
            "1. Bud get: First part\n2. Pick one? B"
        );
    }

    #[test]
    fn adds_a_colon_after_a_question_text_with_no_end_punctuation() {
        assert_eq!(
            answer_message_text(&[question("Pick a colour")], &[answer(&[0], None)]),
            "1. Pick a colour: A"
        );
    }
}
