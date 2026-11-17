//! The runtime-wide side of a secure takeover: no model call and no agent process while
//! any computer has one open. Each window holds the guard for itself, so one window
//! ending leaves another's in force, on another computer or on the same one.

use std::collections::HashSet;
use std::sync::LazyLock;

use parking_lot::Mutex;

use crate::lib::agent_processes::AGENT_PROCESSES;
use crate::lib::inference_gate::INFERENCE_GATE;

/// One secure window: the `ComputerAccess` it is on, and its number there.
pub type SecureKey = (u64, u64);

/// The windows that hold the guard.
static HOLDERS: LazyLock<Mutex<HashSet<SecureKey>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// The first holder holds the inference gate and suspends the agent's processes.
///
/// The gate and the processes change under the `HOLDERS` lock, as the TypeScript does
/// with no `await` between the two, so a window that ends at the same moment cannot
/// free them after this one held them. Neither calls back into this module.
pub fn hold_secure_guard(key: SecureKey) {
    let mut holders = HOLDERS.lock();
    if !holders.insert(key) || holders.len() > 1 {
        return;
    }
    INFERENCE_GATE.hold();
    AGENT_PROCESSES.suspend();
}

/// The last holder to let go resumes the agent's processes, then frees the inference gate.
pub fn release_secure_guard(key: SecureKey) {
    let mut holders = HOLDERS.lock();
    if !holders.remove(&key) || !holders.is_empty() {
        return;
    }
    AGENT_PROCESSES.resume();
    INFERENCE_GATE.free();
}

#[cfg(test)]
mod tests {
    use super::*;

    // Holder numbers no `ComputerAccess` in the tests gets.
    const A: u64 = u64::MAX - 1;
    const B: u64 = u64::MAX - 2;

    fn guarded() -> bool {
        INFERENCE_GATE.held() && AGENT_PROCESSES.is_suspended()
    }

    #[test]
    #[serial_test::serial(secure_guard, inference_gate)]
    fn keeps_the_guard_while_another_computer_has_a_window_open() {
        hold_secure_guard((A, 1));
        hold_secure_guard((B, 1));
        release_secure_guard((A, 1));
        assert!(guarded());
        release_secure_guard((B, 1));
        assert!(!INFERENCE_GATE.held());
        assert!(!AGENT_PROCESSES.is_suspended());
    }

    #[test]
    #[serial_test::serial(secure_guard, inference_gate)]
    fn keeps_the_guard_for_a_new_window_on_the_computer_whose_old_one_ends() {
        hold_secure_guard((A, 1));
        hold_secure_guard((A, 2));
        release_secure_guard((A, 1));
        assert!(guarded());
        release_secure_guard((A, 2));
        assert!(!INFERENCE_GATE.held());
    }
}
