#!/usr/bin/env bash
# Pack the installable payload for rpmbuild:
#   packaging/make-tar.sh        → dist/predator-sense-<ver>.tar.gz
# The tarball contains exactly what the distributions install: daemon+CLI,
# kernel module sources, GUI payload (bundled Electron + stock Acer
# renderer), systemd unit, man pages, desktop entry, LICENSE and docs.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(python3 - <<'EOF'
import re, pathlib
p = pathlib.Path("src/psense-electron/package.json")
print(re.search(r'"version":\s*"([^"]+)"', p.read_text()).group(1))
EOF
)"
OUT="$(cd "$REPO" && mkdir -p dist && cd dist && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/predator-sense-$VER"
tar -C "$REPO" -cf - --exclude 'src/psense-electron/debug' --exclude '.git' \
        src/psense src/psensed \
        src/psense-wmi \
        packaging/psensed.service packaging/predator-sense.desktop \
        packaging/install.sh packaging/gen-icon.py \
        packaging/predator-sense-icon.png packaging/predator-sense.spec \
        packaging/predator-sense.rpmlintrc packaging/man \
        packaging/make-tar.sh scripts \
        LICENSE README.md CONTRIBUTING.md spec docs/shots \
        src/psense-electron/app src/psense-electron/backend.js \
        src/psense-electron/main.js src/psense-electron/preload.js \
        src/psense-electron/lighting-engine.js \
        src/psense-electron/ddsc-table.json src/psense-electron/tls \
        src/psense-electron/package.json src/psense-electron/package-lock.json \
        src/psense-electron/bun.lock src/psense-electron/node_modules \
    | tar -xf - -C "$STAGE/predator-sense-$VER"
tar -czf "$OUT/predator-sense-$VER.tar.gz" -C "$STAGE" "predator-sense-$VER"
echo "dist/predator-sense-$VER.tar.gz  ($(du -h "$OUT/predator-sense-$VER.tar.gz" | cut -f1))"
