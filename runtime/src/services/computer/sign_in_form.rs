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

use serde::{Deserialize, Serialize};

use crate::services::meeting::browser_stack::{FrameHandle, PageHandle};

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
    todo!()
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
    todo!()
}

/// The sign-in this page holds, and the origin it goes to, or `None` when it holds none.
pub async fn find_sign_in(page: &PageHandle, site: Option<&str>) -> Option<SignInShape> {
    todo!()
}

/// Press what submits this step, when the page did not submit it itself.
async fn submit_step(page: &PageHandle, result: SignInResult) -> anyhow::Result<()> {
    todo!()
}

/// Wait for the screen that asks for the password, as a person waits for it to load.
async fn wait_for_password_step(page: &PageHandle, site: &str) -> bool {
    todo!()
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
    todo!()
}
