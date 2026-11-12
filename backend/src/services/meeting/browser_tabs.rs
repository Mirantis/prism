//! The tabs the agent works in.
//!
//! One of them is active, and the active one is brought to the front — a screen share
//! captures the display, so the tab in front is the tab the room sees.
//!
//! The meeting's own tab is never in here. That page is the call, and a navigation on it
//! would leave the meeting.
//!
//! Separate from `browser_stack.rs` because only that file needs a browser: everything
//! here is bookkeeping over pages, and it is tested without one.

use parking_lot::Mutex;

use crate::services::meeting::browser_stack::PageHandle;

#[derive(Default)]
struct TabState {
    pages: Vec<PageHandle>,
    active: Option<PageHandle>,
}

impl TabState {
    /// Drop tabs that the site or the agent closed.
    fn prune(&mut self) {
        self.pages.retain(|page| !page.is_closed());
        if self
            .active
            .as_ref()
            .map(|active| active.is_closed())
            .unwrap_or(true)
        {
            self.active = self.pages.last().cloned();
        }
    }
}

#[derive(Default)]
pub struct TabSet {
    state: Mutex<TabState>,
}

impl TabSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Track a tab and make it active.
    ///
    /// A tab the site opened for itself arrives here too, from the context's page
    /// listener. The browser puts such a tab in front, and the agent that clicked the link
    /// expects to be looking at it.
    pub fn add(&self, page: PageHandle) {
        let mut state = self.state.lock();
        if state.pages.contains(&page) {
            return;
        }
        state.pages.push(page.clone());
        state.active = Some(page);
    }

    /// The open tabs, oldest first.
    pub fn list(&self) -> Vec<PageHandle> {
        let mut state = self.state.lock();
        state.prune();
        state.pages.clone()
    }

    /// The tab commands act on, or `None` when none is open.
    pub fn current(&self) -> Option<PageHandle> {
        let mut state = self.state.lock();
        state.prune();
        state.active.clone()
    }

    /// Remember the tab the user selected without changing the display.
    pub fn observe(&self, page: &PageHandle) {
        let mut state = self.state.lock();
        if state.pages.contains(page) && !page.is_closed() {
            state.active = Some(page.clone());
        }
    }

    /// Make tab `index` active and bring it to the front.
    pub async fn select(&self, index: usize) -> anyhow::Result<Option<PageHandle>> {
        let page = {
            let mut state = self.state.lock();
            state.prune();
            let Some(page) = state.pages.get(index).cloned() else {
                return Ok(None);
            };
            state.active = Some(page.clone());
            page
        };
        page.bring_to_front().await?;
        Ok(Some(page))
    }

    /// Bring the active tab to the front, for a command that is about to use it.
    pub async fn raise(&self) -> anyhow::Result<Option<PageHandle>> {
        let page = self.current();
        if let Some(page) = &page {
            page.bring_to_front().await?;
        }
        Ok(page)
    }

    /// Close tab `index`.
    ///
    /// Closing a tab the agent is not in leaves the active one alone. The active tab is on
    /// the screen the room is watching, and tidying up a background tab must not move it.
    /// Closing the active tab falls back to the tab before it.
    pub async fn close(&self, index: usize) -> anyhow::Result<bool> {
        let (page, was_active) = {
            let mut state = self.state.lock();
            state.prune();
            let Some(page) = state.pages.get(index).cloned() else {
                return Ok(false);
            };
            let was_active = state.active.as_ref() == Some(&page);
            (page, was_active)
        };

        let _ = page.close().await;
        let next = {
            let mut state = self.state.lock();
            if index < state.pages.len() {
                state.pages.remove(index);
            }
            if !was_active {
                return Ok(true);
            }
            state.active = state.pages.get(index.saturating_sub(1)).cloned();
            state.active.clone()
        };
        if let Some(next) = next {
            next.bring_to_front().await?;
        }
        Ok(true)
    }

    /// Forget every tab. The browser they belonged to is gone.
    pub fn clear(&self) {
        let mut state = self.state.lock();
        state.pages.clear();
        state.active = None;
    }
}
