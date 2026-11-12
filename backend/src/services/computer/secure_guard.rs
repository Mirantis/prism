//! The runtime-wide side of a secure takeover: no model call and no agent process while
//! any computer has one open. Each computer holds the guard for its own window, so one
//! computer's window ending leaves another's in force.

use std::collections::HashSet;
use std::sync::LazyLock;

use parking_lot::Mutex;

use crate::lib::agent_processes::AGENT_PROCESSES;
use crate::lib::inference_gate::INFERENCE_GATE;

/// The holders by their identity: each `ComputerAccess` has a number of its own.
static HOLDERS: LazyLock<Mutex<HashSet<u64>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// The first holder holds the inference gate and suspends the agent's processes.
pub fn hold_secure_guard(holder: u64) {
    {
        let mut holders = HOLDERS.lock();
        if !holders.insert(holder) || holders.len() > 1 {
            return;
        }
    }
    INFERENCE_GATE.hold();
    AGENT_PROCESSES.suspend();
}

/// The last holder to let go resumes the agent's processes, then frees the inference gate.
pub fn release_secure_guard(holder: u64) {
    {
        let mut holders = HOLDERS.lock();
        if !holders.remove(&holder) || !holders.is_empty() {
            return;
        }
    }
    AGENT_PROCESSES.resume();
    INFERENCE_GATE.free();
}
