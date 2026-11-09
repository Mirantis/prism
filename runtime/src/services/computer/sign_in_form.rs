//! The sign-in form on a page, found and filled by rule.
//!
//! A help request the model marks as a plain sign-in is answered with a username and a
//! password the user types in their own client. The runtime types those into the blocked
//! tab and submits the form. Which field takes which value is decided here, by selectors
//! in a fixed order, so the same page always answers the same way and no model sees what
//! was typed.
//!
//! A sign-in that asks for the username first and the password on the screen after it is
//! driven the same way, one step at a time. The user answers one box either way.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::lib::log_redaction::err_json;
use crate::services::meeting::browser_stack::{FrameHandle, PageHandle};
use crate::utils::with_timeout::with_timeout;
use crate::{log_debug, log_info, log_warn};

/// A field holding a password: the ordinary one, and the one a "show password" control has
/// turned into plain text, which keeps its autocomplete name.
pub const PASSWORD_FIELDS: &str = r#"input[type="password" i], input[autocomplete*="password" i]"#;

/// Where the username goes, most explicit first. The first tier with a field wins.
///
/// The last tier is any text field: right beside a password field, and wrong on its own,
/// where a search box would answer to it. A first step is recognized from the tiers that
/// name the field instead — see `NAMED_USERNAME_TIERS`.
const USERNAME_FIELDS: [&str; 3] = [
    r#"input[autocomplete="username" i], input[autocomplete="email" i]"#,
    r#"input[type="email" i], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]"#,
    r#"input[type="text" i], input[type="tel" i], input:not([type])"#,
];

/// How many of those tiers name the field, rather than merely allowing it.
const NAMED_USERNAME_TIERS: usize = 2;

/// What submits a form. A button with no type is a submit button inside one.
const SUBMIT_CONTROLS: &str =
    r#"button[type="submit" i], input[type="submit" i], button:not([type])"#;

/// How long one frame gets. An evaluation in the page has no deadline of its own, and the
/// agent is stopped for as long as this runs.
const FILL_TIMEOUT_MS: u64 = 5_000;

/// How long the password screen gets to arrive, and how often it is looked for.
const PASSWORD_STEP_TIMEOUT_MS: u64 = 15_000;
const PASSWORD_STEP_POLL_MS: u64 = 400;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignInCredentials {
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for SignInCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignInCredentials").finish_non_exhaustive()
    }
}

/// What the page holds, and what it did with what it was handed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignInResult {
    /// A visible password field is there.
    pub found: bool,
    /// A field for the username is there. On a page with no password field it is a named
    /// one, which is the first step of a sign-in that asks in two.
    pub username: bool,
    /// The page submitted the step itself; otherwise a real key press does it.
    pub submitted: bool,
}

/// A page's sign-in, as `find_sign_in` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignInShape {
    /// The page asks for the password now. False on the first step of a two-step sign-in.
    pub password: bool,
    /// The page has a field for the username.
    pub username: bool,
    /// The origin of the frame holding the form, which is where the credentials go.
    pub site: String,
}

/// What `IN_PAGE_SIGN_IN` is called with.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageArgument {
    /// The password to type, or null to leave a password field alone.
    pub password: Option<String>,
    /// The username to type, or null to leave a username field alone.
    pub username: Option<String>,
    pub password_fields: String,
    pub username_fields: Vec<String>,
    pub named_username_tiers: usize,
    pub submit_controls: String,
}

impl std::fmt::Debug for PageArgument {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PageArgument").finish_non_exhaustive()
    }
}

/// Find the sign-in, and fill what this step asks for: the function a frame runs, called
/// with a `PageArgument` and answering a `SignInResult`.
///
/// Runs in the page: a field is set through the prototype's setter and told about it,
/// which is what a framework holding its state listens for. Two nulls find the form and
/// change nothing, which is how a request is checked before the box for it is offered, and
/// how the password screen is waited for.
///
/// The values it types are passed as its argument rather than written into this source, so
/// a password cannot turn up in the text of an error about the page.
pub const IN_PAGE_SIGN_IN: &str = r#"(arg) => {
  const globals = globalThis;
  const visible = (field) => !field.disabled && field.getClientRects().length > 0;

  // Every open shadow root as well as the document: a design system can put the sign-in
  // form inside a web component, and `querySelectorAll` stops at the boundary.
  const roots = [globals.document];
  for (let i = 0; i < roots.length; i++) {
    for (const element of Array.from(roots[i].querySelectorAll('*'))) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }

  let password = null;
  let root = globals.document;
  for (const candidate of roots) {
    for (const field of Array.from(candidate.querySelectorAll(arg.passwordFields))) {
      if (!visible(field)) continue;
      password = field;
      root = candidate;
      break;
    }
    if (password) break;
  }

  // The username sits in the password field's own form where there is one. On a first
  // step there is no password field to look around, so every root is searched, and only
  // by the tiers that name the field.
  const scopes = password ? [password.form ?? root] : roots;
  const tiers = password ? arg.usernameFields : arg.usernameFields.slice(0, arg.namedUsernameTiers);
  let username = null;
  for (const tier of tiers) {
    for (const scope of scopes) {
      for (const field of Array.from(scope.querySelectorAll(tier))) {
        if (field === password || !visible(field)) continue;
        username = field;
        break;
      }
      if (username) break;
    }
    if (username) break;
  }

  const found = password !== null;
  if (arg.password === null && arg.username === null) {
    return { found, username: username !== null, submitted: false };
  }

  const set = (field, value) => {
    const setter = globals.Object.getOwnPropertyDescriptor(
      globals.Object.getPrototypeOf(field),
      'value',
    )?.set;
    if (setter) setter.call(field, value);
    else field.value = value;
    field.dispatchEvent(new globals.Event('input', { bubbles: true }));
    field.dispatchEvent(new globals.Event('change', { bubbles: true }));
  };
  if (username && arg.username !== null) set(username, arg.username);
  if (password && arg.password !== null) set(password, arg.password);

  // What this step filled last, which is where the key press lands when the page has no
  // form of its own.
  const filled = arg.password !== null ? password : username;
  if (!filled) return { found, username: username !== null, submitted: false };
  filled.focus();

  const form = filled.form;
  if (!form) return { found, username: username !== null, submitted: false };
  form.requestSubmit(form.querySelector(arg.submitControls) ?? undefined);
  return { found, username: username !== null, submitted: true };
}"#;

fn page_argument(username: Option<&str>, password: Option<&str>) -> PageArgument {
    PageArgument {
        password: password.map(str::to_string),
        username: username.map(str::to_string),
        password_fields: PASSWORD_FIELDS.to_string(),
        username_fields: USERNAME_FIELDS
            .iter()
            .map(|tier| tier.to_string())
            .collect(),
        named_username_tiers: NAMED_USERNAME_TIERS,
        submit_controls: SUBMIT_CONTROLS.to_string(),
    }
}

const NOTHING: SignInResult = SignInResult {
    found: false,
    username: false,
    submitted: false,
};

/// Where a frame is: the origin of its URL. A frame on no page at all (an opaque origin, or
/// a URL that does not parse) answers nothing, and is passed over.
pub fn frame_origin(frame: &FrameHandle) -> Option<String> {
    origin_of(&frame.url())
}

/// `new URL(url).origin`, or `None` for an opaque origin or a URL that does not parse.
fn origin_of(url: &str) -> Option<String> {
    let origin = url::Url::parse(url).ok()?.origin().ascii_serialization();
    if origin == "null" { None } else { Some(origin) }
}

/// What one frame answered, and which frame that was.
struct FrameResult {
    result: SignInResult,
    frame: FrameHandle,
}

/// Ask each frame, and answer with the first holding a sign-in.
///
/// `site` keeps the credentials where they were promised: a sign-in form can sit in an
/// iframe from another origin, so what the user was shown is the origin of the frame that
/// holds the form, and only that frame is asked again when the typing happens. A frame
/// that does not answer within `FILL_TIMEOUT_MS`, as one part-way through a navigation,
/// answers `NOTHING` and is logged at debug level.
async fn run(page: &PageHandle, arg: &PageArgument, site: Option<&str>) -> Option<FrameResult> {
    if page.is_closed() {
        return None;
    }
    let arg = serde_json::to_value(arg).expect("a page argument serializes");
    let mut best: Option<FrameResult> = None;
    for frame in page.frames() {
        if let Some(site) = site {
            if frame_origin(&frame).as_deref() != Some(site) {
                continue;
            }
        }
        let evaluated = async {
            let value = frame
                .evaluate_function(IN_PAGE_SIGN_IN, arg.clone())
                .await?;
            Ok(serde_json::from_value::<SignInResult>(value).unwrap_or(NOTHING))
        };
        let result = match with_timeout(evaluated, FILL_TIMEOUT_MS as i64).await {
            Ok(result) => result,
            Err(err) => {
                // A frame part-way through a navigation answers nothing. That is a step of
                // an ordinary sign-in rather than a fault, and the caller asks again.
                log_debug!(
                    json!({ "err": err_json(&err) }),
                    "[Computer] A frame could not be asked about its sign-in form"
                );
                NOTHING
            }
        };
        if result.found {
            return Some(FrameResult { result, frame });
        }
        // A first step: keep it, in case a later frame holds the whole form.
        if result.username && best.is_none() {
            best = Some(FrameResult { result, frame });
        }
    }
    best
}

/// The sign-in this page holds, and the origin it goes to, or `None` when it holds none.
pub async fn find_sign_in(page: &PageHandle, site: Option<&str>) -> Option<SignInShape> {
    let found = run(page, &page_argument(None, None), site).await?;
    let origin = frame_origin(&found.frame)?;
    Some(SignInShape {
        password: found.result.found,
        username: found.result.username,
        site: origin,
    })
}

/// Press what submits this step, when the page did not submit it itself.
async fn submit_step(page: &PageHandle, result: SignInResult) -> anyhow::Result<()> {
    if !result.submitted {
        page.keyboard_press("Enter").await?;
    }
    Ok(())
}

/// Wait for the screen that asks for the password, as a person waits for it to load.
async fn wait_for_password_step(page: &PageHandle, site: &str) -> anyhow::Result<bool> {
    let deadline = std::time::Instant::now() + Duration::from_millis(PASSWORD_STEP_TIMEOUT_MS);
    loop {
        let found = run(page, &page_argument(None, None), Some(site)).await;
        if found.is_some_and(|found| found.result.found) {
            return Ok(true);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        page.wait_for_timeout(PASSWORD_STEP_POLL_MS).await?;
    }
}

/// How `fill_sign_in_form` ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillOutcome {
    Filled,
    NoForm,
    NoPasswordStep,
}

/// Type the credentials into the sign-in on this page and submit it.
///
/// Only a frame whose origin is `site` is touched, which is the origin the user was shown
/// when they answered. A page asking for both at once takes one step. A page asking for
/// the username first takes two: the username goes in, that step is submitted, and the
/// password follows once the page shows a field for it.
///
/// A page whose form submits itself needs nothing more. One without a form gets a real key
/// press on the field the fill left focused, which is what a person does and what a page
/// listening for Enter expects.
pub async fn fill_sign_in_form(
    page: &PageHandle,
    credentials: &SignInCredentials,
    site: &str,
) -> anyhow::Result<FillOutcome> {
    let Some(shape) = find_sign_in(page, Some(site)).await else {
        return Ok(FillOutcome::NoForm);
    };

    if !shape.password {
        let first = run(
            page,
            &page_argument(Some(&credentials.username), None),
            Some(site),
        )
        .await;
        let Some(first) = first.filter(|first| first.result.username) else {
            return Ok(FillOutcome::NoForm);
        };
        submit_step(page, first.result).await?;
        if !wait_for_password_step(page, site).await? {
            log_warn!("[Computer] A sign-in took the username and never asked for the password");
            return Ok(FillOutcome::NoPasswordStep);
        }
        let second = run(
            page,
            &page_argument(None, Some(&credentials.password)),
            Some(site),
        )
        .await;
        let Some(second) = second.filter(|second| second.result.found) else {
            return Ok(FillOutcome::NoPasswordStep);
        };
        submit_step(page, second.result).await?;
        log_info!("[Computer] Signed in over two steps");
        return Ok(FillOutcome::Filled);
    }

    let result = run(
        page,
        &page_argument(Some(&credentials.username), Some(&credentials.password)),
        Some(site),
    )
    .await;
    let Some(result) = result.filter(|result| result.result.found) else {
        return Ok(FillOutcome::NoForm);
    };
    submit_step(page, result.result).await?;
    log_info!(
        "[Computer] Signed in on {}",
        if result.result.username {
            "two fields"
        } else {
            "a password field"
        }
    );
    Ok(FillOutcome::Filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_origin_a_frame_is_on() {
        assert_eq!(
            origin_of("https://login.example.com:8443/sign-in?next=/").as_deref(),
            Some("https://login.example.com:8443")
        );
        assert_eq!(
            origin_of("https://example.com/").as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn passes_over_a_frame_on_no_page_at_all() {
        assert_eq!(origin_of("about:blank"), None);
        assert_eq!(origin_of("data:text/html,hi"), None);
        assert_eq!(origin_of(""), None);
    }

    #[test]
    fn hands_the_page_the_values_as_its_argument() {
        let arg = serde_json::to_value(page_argument(Some("ada"), None)).unwrap();
        assert_eq!(
            serde_json::to_string(&arg).unwrap(),
            serde_json::to_string(&json!({
                "password": null,
                "username": "ada",
                "passwordFields": PASSWORD_FIELDS,
                "usernameFields": USERNAME_FIELDS,
                "namedUsernameTiers": 2,
                "submitControls": SUBMIT_CONTROLS,
            }))
            .unwrap()
        );
        assert!(!IN_PAGE_SIGN_IN.contains("ada"));
    }
}
