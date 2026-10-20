//! psensed binary skeleton (R1).
//!
//! NOT yet the production daemon: the socket server, eval queue and
//! wiring land in R4 (single worker thread, no tokio by design). This
//! build exists so the workspace compiles and the protocol crate's
//! byte-contract tests run; it deliberately starts no socket yet.
fn main() {
    // R4 replaces this with the real serve loop
    std::process::exit(0);
}
