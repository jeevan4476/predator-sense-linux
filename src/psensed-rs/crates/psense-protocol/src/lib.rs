//! psense-protocol: the psensed socket protocol and EC frame contract as code.
//!
//! Normative source: `spec/daemon-protocol.md` (extracted from the python
//! daemon in R0; byte-level parity is owned here from R1 onward).
//!
//! R1 scope (feat/rust-daemon):
//! - the 16-B SetGamingKBBacklightEffect frame builder, byte-locked to the
//!   python daemon's `_kb_frame` (src/psensed) with live-verified vectors;
//! - the EC-native effect table (BREATHING/SHIFTING/METEOR/TWINKLING) plus
//!   the alias pass (RAINBOW->WAVE, NEON->SHIFTING) that precedes the
//!   lookup, replica of `_kb_apply_effect`'s resolution order.
//!
//! Transport, op registry and typed request/result payloads land with R2.

pub mod kb;

/// RFC 2119-style stability marker for the byte contract shared with the
/// python daemon during the shadow phase: any change to a frame layout
/// that already has a parity vector MUST update the vector and the spec
/// in the same commit.
pub const BYTE_CONTRACT_NOTE: &str =
    "frame layouts with parity vectors are byte-locked; see spec/daemon-protocol.md";
