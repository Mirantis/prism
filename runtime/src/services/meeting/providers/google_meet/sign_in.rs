//! Signing the browser into a Google account.
//!
//! Lives with the provider rather than with the browser stack because it is the one
//! thing about a meeting browser that is platform-specific: a Teams or Zoom provider
//! authenticates differently, or not at all. What the browser stack owns is a real
//! browser on a virtual display with a persistent profile — the session this module
//! establishes is stored in that profile, which is why the two are related but not
//! the same concern.
//!
//! Signing in is not a nicety. Meet **auto-denies automated anonymous guests**
//! (`CreateMeetingDevice` 403, with the host never prompted), so a bot that isn't
//! signed in reaches the lobby and never gets further.
//!
//! **Nothing here fails.** Failure is deliberately non-fatal: whether the browser is
//! signed in is decided by the profile's cookies, not by anything recorded here, and
//! this check has been observed reporting a challenge for a session that then joined
//! a call perfectly well. Refusing to join on a failed login would refuse joins that
//! would have worked. The reason is recorded instead, and named in the denial if one
//! follows.

use std::sync::LazyLock;

use parking_lot::Mutex;

use crate::config::CONFIG;
use crate::services::meeting::browser_stack::{Locator, PageHandle};
use crate::services::meeting::meeting_provider_interface::SignInOptions;

/// How long to let Google's redirect chain settle before judging the session, and how
/// long the URL must hold still to count as settled.
const SESSION_SETTLE_TIMEOUT_MS: u64 = 15_000;
const SESSION_STABLE_MS: u64 = 1_000;

/// How long one parking attempt gets, and how long the main frame must record no
/// navigation to count as still. The quiet window must be the shorter of the two.
///
/// 500 ms is a judgement, not a measurement: the commit that produced this defect
/// landed about 200 ms after its own navigation resolved, and this leaves margin
/// without adding a second to every failed sign-in.
const QUIESCE_SETTLE_TIMEOUT_MS: u64 = 3_000;
const QUIESCE_QUIET_MS: u64 = 500;

/// What Google answered about a profile's session, and the reading it rests on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEvidence {
    pub live: bool,
    pub signal: String,
}

/// What the last sign-in attempt read: why it failed, when one did, and what Google
/// answered about the profile's session.
///
/// Module-level because the provider it serves is a module singleton, and both fields
/// are reset on every `sign_in_to_google` call: the alternative is one meeting's reading
/// deciding the next meeting's join. One call at a time is what makes that reset
/// enough, and the voice lock holds it — a meeting owns it from its startup to its
/// teardown, so two sign-ins cannot interleave here.
#[derive(Debug, Default)]
struct SignInState {
    sign_in_failure: Option<String>,
    session: Option<SessionEvidence>,
}

static STATE: LazyLock<Mutex<SignInState>> = LazyLock::new(|| Mutex::new(SignInState::default()));

/// Whether this browser is *meant* to be signed into a Google account.
///
/// Deliberately "meant to be" rather than "was confirmed to be". It answers one
/// question — should Meet offering a guest name field be read as a stale session? —
/// and for that, intent is the right test and confirmation is the wrong one.
///
/// Confirmation belongs in the other half of that decision, and it is
/// `session_evidence()`: whether Meet's guest field means a stale session depends on
/// both readings, and this one says only that a session is meant to exist.
pub fn is_authenticated() -> bool {
    let email = CONFIG.google_bot_email.as_deref().unwrap_or("");
    let password = CONFIG.google_bot_password.as_deref().unwrap_or("");
    !email.is_empty() && !password.is_empty()
}

/// What Google answered about this profile's session on the last sign-in call, and the
/// reading the answer rests on.
///
/// `None` when no call has run for this browser, which the caller reads as "not
/// confirmed" — the safe direction, since a session nobody has checked may well be
/// refused.
pub fn session_evidence() -> Option<SessionEvidence> {
    STATE.lock().session.clone()
}

/// Why signing in failed, when an account was configured — otherwise `None`.
///
/// Exists so a downstream refusal can name its real cause. Meet hides "we refuse
/// automated anonymous guests" behind the same wall it shows for an ended meeting,
/// and the runtime knew the answer thirty seconds earlier without saying it.
pub fn sign_in_failure_reason() -> Option<String> {
    STATE.lock().sign_in_failure.clone()
}

/// Navigate-and-wait until the URL stops moving, then report where we landed.
///
/// Replaces a flat two-second wait. Two seconds was a guess about how long
/// Google's redirect chain takes, and a chain slower than that read as "signed out" on
/// a profile that was signed in — which then ran a full interactive login against an
/// already-authenticated account, burned 20-45 s finding no login form, and could leave
/// the session mid-rotation. That is the stale-profile hazard `read_session` exists to
/// avoid, caused by the check meant to detect it.
///
/// Polling for stability (every 250 ms) is also *cheaper* than the old sleep in the
/// common case: a chain that settles immediately costs about `SESSION_STABLE_MS`.
/// Fails when the tab closes under it. `None` for either bound takes
/// `SESSION_SETTLE_TIMEOUT_MS` and `SESSION_STABLE_MS`.
pub async fn settled_url(
    page: &PageHandle,
    timeout_ms: Option<u64>,
    stable_ms: Option<u64>,
) -> anyhow::Result<String> {
    let timeout_ms = timeout_ms.unwrap_or(SESSION_SETTLE_TIMEOUT_MS) as i64;
    let stable_ms = stable_ms.unwrap_or(SESSION_STABLE_MS) as i64;
    let deadline = crate::support::now_ms() + timeout_ms;
    let mut last = page.url();
    let mut stable_since = crate::support::now_ms();

    while crate::support::now_ms() < deadline {
        page.wait_for_timeout(250).await?;
        let current = page.url();
        if current != last {
            last = current;
            stable_since = crate::support::now_ms();
            continue;
        }
        if crate::support::now_ms() - stable_since >= stable_ms {
            break;
        }
    }
    Ok(page.url())
}

/// Wait for a locator to become visible, answering false instead of failing.
async fn appears_visible(locator: &Locator, timeout_ms: u64) -> bool {
    locator
        .wait_for(
            crate::services::meeting::browser_stack::WaitForState::Visible,
            timeout_ms,
        )
        .await
        .is_ok()
}

/// Sign the browser into Google, if an account is configured and the profile isn't
/// signed in already.
///
/// `force` skips the "am I already signed in?" probe. The caller passes it once the
/// probe has already answered that the session is not live and Meet agrees, so asking
/// again spends the settle budget for an answer we hold.
///
/// The login goes through
/// `https://accounts.google.com/ServiceLogin?hl=en&continue=https%3A%2F%2Fmyaccount.google.com%2F`:
/// `hl=en` pins the interface language, since Google otherwise localizes from the egress
/// IP and every selector here is written in English, and `ServiceLogin` asks for the
/// identifier form rather than whatever Google decides to show. Whatever happens, the page
/// is left still with `quiesce`, since the very next thing this browser does is load the
/// meeting.
pub async fn sign_in_to_google(page: &PageHandle, options: SignInOptions) {
    todo!()
}

/// Park the page on a blank document, and hand it back only once nothing is navigating.
///
/// A failed sign-in does not leave a still page. Google's redirect chains outlive the
/// navigation that started them — an error page about to commit, a `ServiceLogin`
/// bounce still resolving — and whatever navigates next inherits them. The shape this
/// takes in production is a join reporting
///
/// ```text
///     Could not load the meeting page: Navigation to "https://meet.google.com/abc"
///     is interrupted by another navigation to "about:blank"
/// ```
///
/// which reads as a broken meeting link and is nothing of the sort. The sign-in
/// failure is the real story and it was two steps upstream.
///
/// Stillness is measured from the main frame's navigation commits, the event a
/// navigation is reported "interrupted by another navigation" from. The parking `goto`
/// resolves with a commit still to come, and `page.url()` reads `about:blank` either side
/// of that commit, so the page counts as still only once `quiet_ms` passes with no commit
/// and it reads the blank document.
///
/// A quiet page reading anything else means the late commit was somebody else's, so the
/// parking is done again. Best effort, in two attempts: if even `about:blank` will not
/// settle, the caller has worse problems than a page that is still moving. `None` for
/// either bound takes `QUIESCE_SETTLE_TIMEOUT_MS` and `QUIESCE_QUIET_MS`.
pub async fn quiesce(page: &PageHandle, timeout_ms: Option<u64>, quiet_ms: Option<u64>) {
    todo!()
}

/// What Google says about this profile's session — asked by navigating, not by looking
/// for a cookie.
///
/// A cookie check was the obvious implementation and it was wrong in the way that
/// mattered: Google's auth cookies rotate, and a profile whose browser was killed
/// mid-rotation keeps a `__Secure-1PSID` that Google no longer honours. We reported
/// "signed in", Meet disagreed, offered a guest name field, and the join was
/// auto-denied — with nothing in the logs pointing at the session.
///
/// `myaccount.google.com` is the test because it only stays on that origin for a
/// live session; without one it bounces to `accounts.google.com` or to the
/// `www.google.com/account/about` marketing page. A reading that is not live is what
/// triggers a fresh login, so a stale profile heals itself.
///
/// Every exit records its reading as well as returning it. This is the one place that
/// sees the settled URL, and the provider asks for the reading later, once the join
/// reaches Meet's lobby.
async fn read_session(page: &PageHandle) -> SessionEvidence {
    todo!()
}

/// Keep the reading for the provider, and hand it back to the caller.
fn record(evidence: SessionEvidence) -> SessionEvidence {
    STATE.lock().session = Some(evidence.clone());
    evidence
}

/// Where a settled URL landed, without its query — a `continue=` value is Google's
/// business and not log material. The path stays: it is what tells the signed-out
/// `www.google.com/account/about` page from anything else on that host.
fn landing_of(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => format!("{}{}", parsed.origin().ascii_serialization(), parsed.path()),
        Err(_) => url.to_string(),
    }
}
