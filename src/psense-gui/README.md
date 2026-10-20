# Predator Sense Linux GUI (PySide6, phase 1)

Front-end to `psensed` (`/run/psense.sock`, JSON protocol = CLI's).

Run:            `psense-gui`  (after `rehash`)  — or
                `~/projects/predator-sense-linux/.venv/bin/python src/psense-gui/main.py`

Requires the root daemon (`sudo systemctl start psensed`). Socket keeps the
CLI's permissions (root:wheel 0660).

## Phase-1 scope
- theme.py — palette/fonts ported from Predator Sense 5.0.1.463 `styles.css`
  (ledger §13.17); Predator-Bold/Regular.otf in assets/fonts
- Dashboard — temps/RPM live (2 s poll) + thermal-profile radio buttons
- Fans — mode auto/turbo/custom (both fans), CPU/GPU % sliders, curve readout
- Lighting — live kb.get readout; zone editor + effect picker = phase 2
  (assets/kb/light_kbzone.svg already staged for the preview)

Pollers/ops: `client.py` (Poller/QThreadPool; UI thread never blocks on WMI).
