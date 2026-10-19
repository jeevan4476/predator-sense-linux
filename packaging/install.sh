#!/usr/bin/env bash
# Predator Sense Linux — installer for Fedora (tested on 44, PHN16-71).
#
#   sudo packaging/install.sh            install or update
#   sudo packaging/install.sh --remove   uninstall
#   sudo packaging/install.sh --unit     (re)install only the daemon unit/daemon
#   sudo packaging/install.sh --gui      (re)install only the GUI
#
# Layout (identical for the rpm and script installs)
#   /usr/bin/psense                  CLI
#   /usr/sbin/psensed                root daemon (JSON API on /run/psense.sock)
#   /etc/systemd/system/psensed.service   (script install; rpm uses /usr/lib/systemd/system)
#   /opt/predator-sense/             Electron GUI (bundled runtime, shim + original renderer)
#   /usr/bin/predator-sense          GUI launcher
#   /usr/share/applications/predator-sense.desktop
#   /usr/share/icons/hicolor/256x256/apps/predator-sense.png
#
# The repo tree is NOT modified. GUI user state lives in ~/.config/predator-sense-linux-*.json.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_UNIT=/etc/systemd/system/psensed.service

GUI_ARGS=(app backend.js main.js preload.js ddsc-table.json tls package.json package-lock.json bun.lock node_modules)
GUI_EXCLUDE=(debug README.md)

c_freeze() { systemctl stop psensed 2>/dev/null || true; }

install_daemon() {
    install -Dm755 "$REPO/src/psense"  /usr/bin/psense
    install -Dm755 "$REPO/src/psensed" /usr/sbin/psensed
    install -Dm644 "$REPO/packaging/psensed.service" "$SYSTEMD_UNIT"
    systemctl daemon-reload
    systemctl enable --now psensed
    echo "[ok] daemon: $(systemctl is-active psensed)  cli: /usr/bin/psense"
}

install_gui() {
    # stop the daemon for a consistent copy; bring it back afterwards
    was_active=$(systemctl is-active psensed 2>/dev/null || true)
    [ "$was_active" = "active" ] && systemctl stop psensed || true
    rm -rf /opt/predator-sense
    mkdir -p /opt/predator-sense
    for item in "${GUI_ARGS[@]}"; do
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
    install -Dm644 "$REPO/packaging/predator-sense.desktop" /usr/share/applications/predator-sense.desktop
    # generate the icon if missing (needs Pillow; artifact committed in repo)
    python3 "$REPO/packaging/gen-icon.py" >/dev/null 2>&1 || true
    install -Dm644 "$REPO/packaging/predator-sense-icon.png" \
        /usr/share/icons/hicolor/256x256/apps/predator-sense.png
    test -f /usr/share/icons/hicolor/256x256/apps/predator-sense.png \
        || echo "[warn] icon missing — run packaging/gen-icon.py first"
    update-desktop-database /usr/share/applications 2>/dev/null || true
    gtk-update-icon-cache -q /usr/share/icons/hicolor 2>/dev/null || true
    echo "[ok] gui: /opt/predator-sense  launcher: /usr/bin/predator-sense"
}

remove_all() {
    systemctl disable --now psensed 2>/dev/null || true
    rm -f "$SYSTEMD_UNIT" /usr/bin/psense /usr/sbin/psensed \
          /usr/bin/predator-sense /usr/share/applications/predator-sense.desktop \
          /usr/share/icons/hicolor/256x256/apps/predator-sense.png
    # legacy paths from pre-FHS installs
    rm -f /usr/local/bin/psense /usr/local/sbin/psensed /usr/local/bin/predator-sense
    systemctl daemon-reload
    rm -rf /opt/predator-sense
    echo "[ok] removed (user state in ~/.config/predator-sense-linux-*.json kept)"
}

case "${1:-install}" in
    --remove) remove_all ;;
    --unit)   install_daemon ;;
    --gui)    install_gui ;;
    install)  install_daemon && install_gui ;;
    *) echo "usage: $0 [install|--unit|--gui|--remove]" >&2; exit 2 ;;
esac
