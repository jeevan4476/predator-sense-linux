#!/usr/bin/env bash
# Predator Sense Linux — one-command setup (whole system).
#
#   sudo ./setup.sh                 # everything: deps -> kmod -> daemon -> GUI -> verify
#   sudo ./setup.sh --yes           # same, auto-confirming package installs
#   sudo ./setup.sh --no-kmod       # skip the kernel-module stage (already installed?)
#   sudo ./setup.sh --unit          # only the CLI + daemon + systemd unit
#   sudo ./setup.sh --gui           # only the GUI (needs the vendored renderer)
#   sudo ./setup.sh --remove        # full uninstall (incl. DKMS module)
#
# What a fresh clone gets: a fully working CLI + daemon + system service.
# The Electron GUI is installed only when src/psense-electron/app/ exists in
# the tree — the public source repository ships without the proprietary
# renderer bundle (README "Source-only distribution policy").
#
# Layout (identical for the rpm and script installs)
#   /usr/bin/psense                  CLI
#   /usr/sbin/psensed                root daemon (JSON API on /run/psense.sock)
#   /etc/systemd/system/psensed.service   (script install; rpm uses /usr/lib/systemd/system)
#   /etc/modules-load.d/psense-wmi.conf   (module autoload at boot)
#   /opt/predator-sense/             Electron GUI (bundled runtime, shim + original renderer)
#   /usr/bin/predator-sense          GUI launcher
#   /usr/share/applications/predator-sense.desktop
#   /usr/share/icons/hicolor/256x256/apps/predator-sense.png
#
# The repository tree is NOT modified. GUI user state lives in
# ~/.config/predator-sense-linux-*.json and is kept on uninstall.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
SYSTEMD_UNIT=/etc/systemd/system/psensed.service
MODULE_NAME="psense-wmi"
MODULE_VER="0.2.0"

DO_KMOD=1
DO_UNIT=1
DO_GUI=1
DO_REMOVE=0
DO_VERIFY=1
ASSUME_YES=0

for arg in "$@"; do
    case "$arg" in
        --remove) DO_REMOVE=1 ;;
        --unit)   DO_UNIT=1 ; DO_GUI=0 ; DO_KMOD=0 ;;
        --gui)    DO_UNIT=0 ; DO_GUI=1 ; DO_KMOD=0 ;;
        --no-kmod) DO_KMOD=0 ;;
        --yes)    ASSUME_YES=1 ;;
        --help|-h) sed -n '3,13p' "$0"; exit 0 ;;
        *) echo "error: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
    esac
done

[ "$(id -u)" -eq 0 ] || { echo "error: run as root (sudo ./setup.sh)" >&2; exit 1; }
[ -f "$REPO/src/psensed" ] || { echo "error: run this script from a checkout of predator-sense-linux" >&2; exit 1; }

# ---------------------------------------------------------------- helpers
c_freeze() { systemctl stop psensed 2>/dev/null || true; }
was_active() { [ "$(systemctl is-active psensed 2>/dev/null || true)" = "active" ]; }

# ---------------------------------------------------------------- remove
remove_all() {
    systemctl disable --now psensed 2>/dev/null || true
    dkms remove -m "$MODULE_NAME" -v "$MODULE_VER" >/dev/null 2>&1 || true
    rmmod "$MODULE_NAME" 2>/dev/null || true
    rm -f /etc/modules-load.d/psense-wmi.conf
    rm -f "$SYSTEMD_UNIT" /usr/bin/psense /usr/sbin/psensed \
          /usr/bin/predator-sense /usr/share/applications/predator-sense.desktop \
          /usr/share/icons/hicolor/256x256/apps/predator-sense.png
    # legacy paths from pre-FHS installs
    rm -f /usr/local/bin/psense /usr/local/sbin/psensed /usr/local/bin/predator-sense
    systemctl daemon-reload
    rm -rf /opt/predator-sense
    echo "[ok] removed (user state in ~/.config/predator-sense-linux-*.json kept)"
}

if [ "$DO_REMOVE" -eq 1 ]; then remove_all; exit 0; fi

# ---------------------------------------------------------------- stage 1: packages
install_pkgs() {
    local pkgs=("$@")
    if [ "$ASSUME_YES" -ne 1 ]; then
        echo
        echo "==>About to install: ${pkgs[*]}"
        read -r -p "    proceed? [Y/n] " a || a=Y
        case "$a" in [nN]*) echo "    skipped — missing tools may break later stages"; return ;; esac
    fi
    if command -v dnf >/dev/null; then
        dnf install -y "${pkgs[@]}" || true
    elif command -v pacman >/dev/null; then
        pacman -Sy --needed --noconfirm "${pkgs[@]}" || true
    elif command -v apt-get >/dev/null; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y "${pkgs[@]}" || true
    else
        echo "    (no known package manager — install manually: ${pkgs[*]})"
    fi
}

kver="$(uname -r)"
NEEDED=(python3 smartmontools)
if command -v dnf >/dev/null; then
    NEEDED+=(kernel-devel-"$kver" kernel-headers dkms gcc make)
elif command -v apt-get >/dev/null; then
    NEEDED+=(linux-headers-"$kver" dkms build-essential)
elif command -v pacman >/dev/null; then
    NEEDED+=(linux-headers dkms base-devel)
fi

echo "==> [1/5] checking prerequisites"
MISSING=()
for pkgcmd in "python3 --version" "smartctl --version" "make --version" "gcc --version"; do
    sh -c "$pkgcmd" >/dev/null 2>&1 || MISSING+=("$pkgcmd")
done
command -v dkms >/dev/null || MISSING+=("dkms")
if [ ${#MISSING[@]} -gt 0 ] && command -v dnf >/dev/null 2>&1; then
    install_pkgs "${NEEDED[@]}"
elif [ ${#MISSING[@]} -gt 0 ]; then
    echo "    missing: ${MISSING[*]}"
    install_pkgs "${NEEDED[@]}"
fi
command -v dkms >/dev/null || { echo "error: dkms is required (see README Route 2)" >&2; exit 1; }

# ---------------------------------------------------------------- stage 2: kernel module
if [ "$DO_KMOD" -eq 1 ]; then
    echo "==> [2/5] building + registering ${MODULE_NAME} (${MODULE_VER}) via DKMS"
    bash "$REPO/src/psense-wmi/install-dkms.sh" 2>&1 | sed 's/^/    /'
    # the DKMS installer only *suggests* the boot autoload — persist it here
    echo "$MODULE_NAME" > /etc/modules-load.d/psense-wmi.conf
else
    echo "==> [2/5] kernel module stage skipped (--no-kmod)"
fi

# ---------------------------------------------------------------- stage 3: daemon + CLI
if [ "$DO_UNIT" -eq 1 ]; then
    echo "==> [3/5] installing CLI + daemon + systemd unit"
    install -Dm755 "$REPO/src/psense"  /usr/bin/psense
    install -Dm755 "$REPO/src/psensed" /usr/sbin/psensed
    install -Dm644 "$REPO/packaging/psensed.service" "$SYSTEMD_UNIT"
    systemctl daemon-reload
    systemctl enable --now psensed
    echo "    daemon: $(systemctl is-active psensed)  cli: /usr/bin/psense"
else
    echo "==> [3/5] daemon stage skipped"
fi

# ---------------------------------------------------------------- stage 4: GUI
install_gui() {
    was_active=$(systemctl is-active psensed 2>/dev/null || true)
    [ "$was_active" = "active" ] && systemctl stop psensed || true
    rm -rf /opt/predator-sense
    mkdir -p /opt/predator-sense
    for item in app backend.js main.js preload.js lighting-engine.js \
                ddsc-table.json tls package.json package-lock.json bun.lock node_modules; do
        cp -a "$REPO/src/psense-electron/$item" /opt/predator-sense/
    done
    # single-user box: the app writes ~/.config state and (optionally) a debug/
    # dir next to itself for the PS_* capture harness — keep it user-owned.
    if [ -n "${SUDO_USER:-}" ]; then
        chown -R "$SUDO_USER:" /opt/predator-sense
    fi
    if [ "$was_active" = "active" ]; then
        systemctl start psensed
    fi
    cat > /usr/bin/predator-sense <<'EOF'
#!/bin/sh
# Predator Sense GUI launcher (original renderer + Linux shim)
cd /opt/predator-sense
exec ./node_modules/electron/dist/electron . "$@"
EOF
    chmod 755 /usr/bin/predator-sense
    install -Dm644 "$REPO/packaging/predator-sense.desktop" \
        /usr/share/applications/predator-sense.desktop
    # the icon artifact is committed; gen-icon.py (Pillow) is only a fallback
    install -Dm644 "$REPO/packaging/predator-sense-icon.png" \
        /usr/share/icons/hicolor/256x256/apps/predator-sense.png
    update-desktop-database /usr/share/applications 2>/dev/null || true
    gtk-update-icon-cache -q /usr/share/icons/hicolor 2>/dev/null || true
    echo "    gui: /opt/predator-sense  launcher: /usr/bin/predator-sense"
}

echo "==> [4/5] GUI stage"
if [ "$DO_GUI" -eq 0 ]; then
    echo "    skipped (--unit/--gui flag)"
elif [ ! -d "$REPO/src/psense-electron/app" ]; then
    echo "    skipped: the vendored renderer bundle (src/psense-electron/app/) is not"
    echo "    in this tree — public source releases ship without the proprietary GUI"
    echo "    payload (README: Source-only distribution policy)."
    echo "    The CLI + daemon installed by stage 3 are FULLY functional."
else
    install_gui
fi

# ---------------------------------------------------------------- stage 5: verify
echo "==> [5/5] verify"
[ -S /run/psense.sock ] && echo "    [ok] /run/psense.sock" \
    || echo "    [warn] /run/psense.sock absent (daemon not running?)"
[ -e /dev/psense-wmi ] && echo "    [ok] /dev/psense-wmi" \
    || echo "    [warn] /dev/psense-wmi absent (module not loaded?)"
if [ "$DO_UNIT" -eq 1 ] && command -v psense >/dev/null; then
    if out=$(timeout 15 psense fan status 2>&1); then
        echo "    [ok] live read: $out" | head -1
    else
        echo "    [warn] 'psense fan status' did not answer: $out" | head -1
    fi
fi
if [ "$DO_GUI" -eq 1 ] && command -v predator-sense >/dev/null; then
    echo "    [ok] GUI launcher present (run: predator-sense)"
fi

echo
echo "Setup complete. Dashboard hint: 'psense checkup' for a full health report."
