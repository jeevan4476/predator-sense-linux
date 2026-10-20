//! psense-gpu-oc: the daemon-side GPU overdrive port.
//!
//! Port target: the python gpu_oc module (nvidia-settings ride-along on
//! profile.set, INI fixture states, nvidia-smi readbacks). Non-NVIDIA
//! and missing-tool paths must reproduce the python no-op behavior.
