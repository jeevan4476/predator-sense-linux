//! psensed-core: the daemon machinery between the socket and the hardware.
//!
//! Port targets from src/psensed (R4): the single-threaded WMI eval queue
//! with the 200 ms / 500 ms spacing policy (kernel-side >= 30 ms vendor
//! pacing stays in the kmod), the EC kb frame wiring (kb.set / kb.effects
//! / zone store / persistence with atomic replace), fan+sensor sysfs
//! readers and the profile/platform-profile writers.
