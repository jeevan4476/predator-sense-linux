//! psense-engine: the daemon-side lighting engine port.
//!
//! Port target: the python `psensed_lighting` module (mathematical effects
//! rendered by the userspace engine: SCREEN/MUSIC/WAVE/RAINBOW/NEON after
//! EC-native delegation, plus the zone write policy that collapses
//! identical frames and targets only changed zones).
//!
//! Fixture-guided port (R2/R3): golden vectors from tests/ once the
//! python module's rendering is pinned frame-for-frame.
