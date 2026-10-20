#!/usr/bin/env bash
# Compat wrapper — the real installer is /setup.sh at the repository root.
# Kept at this path so README/tarball invocations keep working.
exec "$(cd "$(dirname "$0")/.." && pwd)/setup.sh" "$@"
