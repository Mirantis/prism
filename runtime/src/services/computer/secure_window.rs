//! What a secure takeover must not leave behind.
//!
//! The agent resumes with the screen in front of it, so a password still sitting in
//! a field would be readable the moment it looks. Clearing every password field is
//! also the answer to "did they submit the form": a submitted sign-in leaves no
//! field to clear, and an abandoned one leaves nothing that outlives the window.

use crate::services::meeting::browser_stack::PageHandle;

/// How long one frame gets. An evaluation in the page has no deadline of its own, and the
/// agent runs again when this is done, so a wedged frame would stop the runtime for good.
const CLEAR_TIMEOUT_MS: u64 = 5_000;

/// The function each frame runs, called with `PASSWORD_FIELDS` and answering how many
/// fields held something.
///
/// Every open shadow root as well as the document: a design system can put the sign-in
/// form inside a web component, and `querySelectorAll` stops at the boundary. A closed root
/// is unreachable by construction. A field is emptied through the prototype's setter, which
/// is what a framework holding the field's state listens for; assigning `value` alone can
/// be re-rendered straight back out of that state.
const CLEAR_PASSWORD_FIELDS: &str = r#"(selector) => {
  const globals = globalThis;
  const roots = [globals.document];
  const fields = [];
  for (let i = 0; i < roots.length; i++) {
    for (const element of Array.from(roots[i].querySelectorAll('*'))) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    for (const field of Array.from(roots[i].querySelectorAll(selector))) {
      fields.push(field);
    }
  }
  let count = 0;
  for (const field of fields) {
    if (!field.value) continue;
    const setter = globals.Object.getOwnPropertyDescriptor(
      globals.Object.getPrototypeOf(field),
      'value',
    )?.set;
    if (setter) setter.call(field, '');
    else field.value = '';
    field.dispatchEvent(new globals.Event('input', { bubbles: true }));
    field.dispatchEvent(new globals.Event('change', { bubbles: true }));
    count++;
  }
  return count;
}"#;

/// A frame the page has already left. It holds nothing, so there is nothing to clear and
/// nothing to say: a sign-in that went through navigates, which is this exact state.
fn is_gone(err: &anyhow::Error) -> bool {
    let message = err.to_string();
    message.contains("Execution context was destroyed") || message.contains("detached")
}

/// Empty every password field in every frame of these tabs, and report how many held
/// something. A frame that is wedged is reported and passed over.
pub async fn clear_password_fields(pages: &[PageHandle]) -> i64 {
    todo!()
}
