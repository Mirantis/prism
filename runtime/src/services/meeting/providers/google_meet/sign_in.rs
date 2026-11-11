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

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;

use crate::config::CONFIG;
use crate::services::meeting::browser_stack::{
    GotoOptions, LoadState, Locator, PageHandle, TextMatch, WaitForState,
};
use crate::services::meeting::meeting_provider_interface::SignInOptions;
use crate::services::meeting::audio_playback::clock_ms;
use crate::{log_info, log_warn};

/// Where an interactive sign-in starts. See `sign_in_to_google`.
const SIGN_IN_URL: &str =
    "https://accounts.google.com/ServiceLogin?hl=en&continue=https%3A%2F%2Fmyaccount.google.com%2F";

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
    let deadline = clock_ms() + timeout_ms;
    let mut last = page.url();
    let mut stable_since = clock_ms();

    while clock_ms() < deadline {
        page.wait_for_timeout(250).await?;
        let current = page.url();
        if current != last {
            last = current;
            stable_since = clock_ms();
            continue;
        }
        if clock_ms() - stable_since >= stable_ms {
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
    // Reset first: this module outlives a single meeting, and stale auth state is
    // worse than none — see `SignInState` above.
    {
        let mut state = STATE.lock();
        state.sign_in_failure = None;
        state.session = None;
    }

    let email = CONFIG.google_bot_email.clone().unwrap_or_default();
    let password = CONFIG.google_bot_password.clone().unwrap_or_default();
    if email.is_empty() || password.is_empty() {
        log_info!("[Meeting] No Google account configured — joining as an anonymous guest");
        return;
    }
    if !options.force {
        let session = read_session(page).await;
        if session.live {
            log_info!("[Meeting] Reusing the signed-in session from the persisted profile");
            return;
        }
        // Name what refused the session, at the moment the password is about to be typed.
        // A login this account did not need is what earns it a Google challenge, so the log
        // has to say which reading asked for this one.
        log_info!("[Meeting] Signing in: {}", session.signal);
    }

    match interactive_sign_in(page, &email, &password).await {
        Ok(SignInEnd::SignedIn) => return,
        Ok(SignInEnd::NotSignedIn) => {}
        Err(err) => {
            let message = err.to_string();
            log_warn!("[Meeting] Sign-in failed: {}", message);
            STATE.lock().sign_in_failure = Some(message);
        }
    }

    // Whatever happened above, leave the page still. A sign-in that failed is the one
    // most likely to be mid-redirect, and the very next thing this browser does is
    // load the meeting — which is how a sign-in problem came to be reported to users
    // as a broken meeting link.
    quiesce(page, None, None).await;
}

/// How the login form ended, when nothing went wrong on the way through it.
enum SignInEnd {
    SignedIn,
    NotSignedIn,
}

/// The login form itself: identifier, password, and a reading of where that landed.
async fn interactive_sign_in(
    page: &PageHandle,
    email: &str,
    password: &str,
) -> anyhow::Result<SignInEnd> {
    // `hl=en` pins the interface language. Without it Google localizes from the
    // egress IP — a German page rendered here once — and every selector below is
    // written in English. `ServiceLogin` (rather than the bare origin) asks for
    // the identifier form instead of whatever Google decides to show.
    page.goto(
        SIGN_IN_URL,
        GotoOptions {
            wait_until: LoadState::DomContentLoaded,
            timeout_ms: Some(45_000),
        },
    )
    .await?;

    // The identifier field is `type="text"`, not `type="email"` — matching on
    // type finds nothing and times out.
    let identifier = page.locator("#identifierId");
    if !appears_visible(&identifier, 8_000).await {
        // A leftover session shows an account chooser rather than the email form.
        // "Use another account" is the way back to it.
        let another = page
            .get_by_role("link", Some(TextMatch::pattern("use another account", "i")))
            .or(page.get_by_role(
                "button",
                Some(TextMatch::pattern("use another account", "i")),
            ))
            .first();
        if appears_visible(&another, 5_000).await {
            another.click(5_000).await?;
        }
    }
    if !appears_visible(&identifier, 20_000).await {
        // No identifier form and no account chooser normally means Google decided we
        // were already authenticated and sent us straight through. Re-ask instead of
        // reporting a failure — a bare wait that failed here is how a good profile ended
        // up flagged as a failed sign-in.
        if read_session(page).await.live {
            log_info!("[Meeting] Already signed in — Google skipped the login form");
            return Ok(SignInEnd::SignedIn);
        }
        anyhow::bail!("the Google sign-in form never appeared");
    }
    let next = page
        .get_by_role("button", Some(TextMatch::pattern("^next$", "i")))
        .first();
    identifier.click(30_000).await?;
    identifier.type_text(email, 60, None).await?;
    next.click(10_000).await?;

    let pw = page
        .locator("input[type=\"password\"]:visible, input[name=\"Passwd\"]")
        .first();
    pw.wait_for(WaitForState::Visible, 25_000).await?;
    pw.click(30_000).await?;
    pw.type_text(password, 60, None).await?;
    next.click(10_000).await?;

    // Wait for the post-password redirect chain to stop moving rather than sleeping
    // a flat 8 s: a slow interstitial used to make the check below run early and
    // report failure for a login that was about to succeed.
    settled_url(page, Some(45_000), None).await?;

    if read_session(page).await.live {
        return Ok(SignInEnd::SignedIn);
    }
    // Most often a "verify it's you" challenge, which needs a code only a human
    // has. Say so plainly instead of leaving a silent guest join to fail later.
    static WHITESPACE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\s+").expect("valid regex"));
    let visible = page
        .locator("body")
        .inner_text(Some(3_000))
        .await
        .unwrap_or_default();
    let visible = WHITESPACE.replace_all(&visible, " ");
    STATE.lock().sign_in_failure = Some("Google is likely challenging this account".to_string());
    log_warn!(
        "[Meeting] Sign-in did not complete — Google is likely challenging this account. Page said: {}",
        crate::support::js::slice16(&visible, 0, 200)
    );
    Ok(SignInEnd::NotSignedIn)
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
    let timeout_ms = timeout_ms.unwrap_or(QUIESCE_SETTLE_TIMEOUT_MS);
    let quiet_ms = quiet_ms.unwrap_or(QUIESCE_QUIET_MS) as i64;
    let last_commit = Arc::new(AtomicI64::new(clock_ms()));
    let main = page.main_frame();
    let listener = {
        let last_commit = last_commit.clone();
        page.on_frame_navigated(Arc::new(move |frame| {
            if *frame == main {
                last_commit.store(clock_ms(), Ordering::SeqCst);
            }
        }))
    };

    for _attempt in 1..=2 {
        // One budget for the whole attempt, the navigation included: the caller of a
        // failed sign-in is waiting on this, and a `goto` with a cap of its own would
        // spend that cap on top of the wait below.
        let deadline = clock_ms() + timeout_ms as i64;
        let _ = page
            .goto(
                "about:blank",
                GotoOptions {
                    wait_until: LoadState::DomContentLoaded,
                    timeout_ms: Some(timeout_ms),
                },
            )
            .await;

        while clock_ms() < deadline {
            // The wait fails once the page is closed, and nothing in this file fails —
            // see the header. A closed page is also still enough for the caller.
            if page.wait_for_timeout(100).await.is_err() {
                page.remove_frame_listener(listener);
                return;
            }
            if clock_ms() - last_commit.load(Ordering::SeqCst) < quiet_ms {
                continue;
            }
            if page.url() == "about:blank" {
                page.remove_frame_listener(listener);
                return;
            }
            break;
        }
    }
    page.remove_frame_listener(listener);
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
    // Twice, because the first navigation can be interrupted by a redirect chain that
    // is still running — Google's own — and fail for a session that is perfectly
    // alive. Watched live: a profile whose account page was rendering ("Skip to main
    // content Account") while this reported it signed out, because the failure was
    // swallowed at debug level and read as a negative rather than as no answer at all.
    for attempt in 1..=2 {
        let checked = async {
            page.goto(
                "https://myaccount.google.com/",
                GotoOptions {
                    wait_until: LoadState::DomContentLoaded,
                    timeout_ms: Some(30_000),
                },
            )
            .await?;
            // Judged only once the redirect chain has stopped moving — see `settled_url`.
            settled_url(page, None, None).await
        }
        .await;
        match checked {
            Ok(url) => {
                if url.starts_with("https://myaccount.google.com/") {
                    return record(SessionEvidence {
                        live: true,
                        signal: "the account page stayed on myaccount.google.com".to_string(),
                    });
                }
                return record(SessionEvidence {
                    live: false,
                    signal: format!("the account page settled on {}", landing_of(&url)),
                });
            }
            Err(err) => {
                // Loud, and never at debug: this used to be the quietest line in the file
                // and the one that most often decided a join.
                log_info!(
                    "[Meeting] Sign-in check could not complete (attempt {}): Error: {}",
                    attempt,
                    err
                );
                // Before the retry as well as before returning: the failed navigation is
                // still settling, and the next `goto` — here or in the sign-in that
                // follows — is otherwise interrupted by it.
                quiesce(page, None, None).await;
            }
        }
    }
    log_warn!(
        "[Meeting] Could not establish whether the profile is signed in — assuming it is not"
    );
    record(SessionEvidence {
        live: false,
        signal: "the account session check could not complete".to_string(),
    })
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    // The paused test clock, so the commit timings below hold under any load.
    use tokio::time::Instant;

    use serde_json::json;

    use super::*;
    use crate::services::meeting::browser_stack::testing::FakeBrowser;

    /// Commit `url` on the tab's main frame, as a navigation would.
    fn commit(fake: &FakeBrowser, page: &PageHandle, url: &str) {
        fake.emit(
            page,
            "Page.frameNavigated",
            json!({ "frame": { "id": page.target_id(), "loaderId": url, "url": url } }),
        );
    }

    fn navigations(fake: &FakeBrowser, page: &PageHandle) -> usize {
        fake.sent_to(page)
            .iter()
            .filter(|method| *method == "Page.navigate")
            .count()
    }

    #[tokio::test(start_paused = true)]
    async fn reports_where_a_redirect_chain_came_to_rest_not_where_it_was_mid_flight() {
        let fake = Arc::new(FakeBrowser::new());
        let page = fake.page("https://myaccount.google.com/");
        let hops = {
            let (fake, page) = (fake.clone(), page.clone());
            tokio::spawn(async move {
                for url in [
                    "https://accounts.google.com/ServiceLogin",
                    "https://accounts.google.com/CheckCookie",
                    "https://www.google.com/account/about/",
                ] {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    commit(&fake, &page, url);
                }
            })
        };
        let started = Instant::now();
        let url = settled_url(&page, Some(5_000), Some(600)).await.unwrap();
        hops.await.unwrap();
        assert_eq!(url, "https://www.google.com/account/about/");
        assert!(started.elapsed() < Duration::from_millis(4_000));
    }

    #[tokio::test(start_paused = true)]
    async fn gives_up_at_the_deadline_rather_than_hanging_on_a_chain_that_never_settles() {
        let fake = Arc::new(FakeBrowser::new());
        let page = fake.page("https://accounts.google.com/a");
        let churn = {
            let (fake, page) = (fake.clone(), page.clone());
            tokio::spawn(async move {
                for n in 0.. {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    commit(&fake, &page, &format!("https://accounts.google.com/{n}"));
                }
            })
        };
        let started = Instant::now();
        let url = settled_url(&page, Some(1_000), Some(500)).await.unwrap();
        churn.abort();
        assert!(url.starts_with("https://accounts.google.com/"));
        assert!(started.elapsed() < Duration::from_millis(1_800));
    }

    #[tokio::test(start_paused = true)]
    async fn holds_the_page_until_a_commit_that_outlives_its_own_goto_has_landed() {
        let fake = Arc::new(FakeBrowser::new());
        let page = fake.page("about:blank");
        let late = {
            let (fake, page) = (fake.clone(), page.clone());
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                commit(&fake, &page, "about:blank");
            })
        };
        let started = Instant::now();
        quiesce(&page, Some(3_000), Some(500)).await;
        late.await.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(800));
        assert_eq!(navigations(&fake, &page), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn parks_the_page_again_when_it_reads_somewhere_else_once_quiet() {
        let fake = FakeBrowser::new();
        let page = fake.page("https://accounts.google.com/signin/rejected");
        quiesce(&page, Some(2_000), Some(200)).await;
        assert_eq!(navigations(&fake, &page), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn returns_rather_than_failing_when_the_page_closes_while_it_waits() {
        let fake = Arc::new(FakeBrowser::new());
        let page = fake.page("https://accounts.google.com/x");
        let closer = {
            let (fake, page) = (fake.clone(), page.clone());
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                fake.close_from_site(&page);
            })
        };
        let started = Instant::now();
        quiesce(&page, Some(3_000), Some(500)).await;
        closer.await.unwrap();
        assert!(started.elapsed() < Duration::from_millis(1_000));
    }

    #[test]
    fn names_a_landing_without_its_query() {
        assert_eq!(
            landing_of("https://www.google.com/account/about/?continue=https%3A%2F%2Fx"),
            "https://www.google.com/account/about/"
        );
        assert_eq!(landing_of("not a url"), "not a url");
    }
}
