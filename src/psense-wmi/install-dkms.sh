#!/bin/bash
# Install psense-wmi through DKMS so the module rebuilds automatically on
# every kernel update (ledger: src/psense-wmi, spec §8 T1 transport).
#
#   sudo bash install-dkms.sh          # add/build/install + hot-swap the module
#
# Idempotent: re-running upgrades the DKMS tree, removes the previous module
# version and reloads the freshly built .ko from the /updates depmod path.
set -euo pipefail

readonly NAME="psense-wmi"
readonly VER="0.2.0"
readonly SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEST="/usr/src/${NAME}-${VER}"

[ "$(id -u)" -eq 0 ] || { echo "error: run as root"; exit 1; }
command -v dkms >/dev/null 2>&1 || { echo "error: dkms not installed (dnf install dkms)"; exit 1; }

echo "==> staging sources to ${DEST}"
rm -rf "${DEST}"
mkdir -p "${DEST}"
# copy sources only; build artifacts live in the working tree only
for f in Makefile dkms.conf psense-wmi.c; do
    install -m 0644 "${SRC}/${f}" "${DEST}/"
done

if dkms status -m "${NAME}" | grep -q "installed"; then
    echo "==> removing previous DKMS install"
    dkms remove -m "${NAME}" -v "${VER}" >/dev/null 2>&1 || true
fi

echo "==> dkms add/build/install ${NAME}-${VER}"
dkms add      -m "${NAME}" -v "${VER}"
dkms build    -m "${NAME}" -v "${VER}"
dkms install  -m "${NAME}" -v "${VER}"
depmod -a

echo "==> hot-swapping module (stops the daemon first if it is running)"
if [ -r /run/psensed.pid ] && kill -0 "$(cat /run/psensed.pid)" 2>/dev/null; then
    kill "$(cat /run/psensed.pid)" 2>/dev/null || true
    sleep 0.5
    echo "    (psensed stopped — restart it after this script succeeds)"
fi
rmmod "${NAME}" 2>/dev/null || true
if modprobe "${NAME}"; then
    echo "==> ok: ${NAME} loaded (dkms) — $(basename $(command -v modprobe)) path: $(modinfo -n "${NAME}")"
else
    echo "error: modprobe failed; reload manually with:" >&2
    echo "       make && sudo insmod ${SRC}/psense-wmi.ko" >&2
    exit 1
fi

echo "==> auto-load on boot: echo ${NAME} > /etc/modules-load.d/${NAME}.conf"
