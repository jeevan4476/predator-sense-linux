"""Predator Sense Linux — Qt GUI (PySide6).

Qt port of the Predator Sense 5.0.1.463 look: theme.py carries the palette
extracted from the original `styles.css` (ledger §13.17) and the Predator OTF
fonts ship in assets/fonts. Front-end to the `psensed` daemon over
/run/psense.sock (JSON newline protocol, identical to the CLI).
"""
from __future__ import annotations

import sys
from typing import Optional

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (QApplication, QHBoxLayout, QLabel, QMainWindow,
                               QMessageBox, QPushButton, QStackedWidget,
                               QVBoxLayout, QWidget)

import theme
from client import Poller, run_op
from pages_dashboard import DashboardPage
from pages_fans import FansPage


class LightingPage(QWidget):
    """Phase-2 placeholder: live kb.get state; editors land next."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("root")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 22, 28, 22)
        lay.addWidget(QLabel("BACKLIGHTING", objectName="h1"))
        lay.addWidget(QLabel("zone editor + effect picker — phase 2 of the GUI",
                             objectName="dim"))
        self._live = QLabel("—", objectName="value")
        lay.addWidget(self._live)
        lay.addStretch(1)

    def apply_kb(self, d: dict) -> None:
        if not isinstance(d, dict):
            return
        parts = [f"{k}={d.get(k)}" for k in ("mode", "brightness", "dir", "flag9")]
        rgb = d.get("rgb")
        if rgb:
            parts.append(f"rgb=({rgb[0]},{rgb[1]},{rgb[2]})")
        self._live.setText("  ".join(parts))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("PredatorSense Linux — PHN16-71")
        self.resize(960, 640)
        self._reachable: Optional[bool] = None

        central = QWidget()
        central.setObjectName("root")
        h = QHBoxLayout(central)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(0)

        # ---- sidebar -------------------------------------------------------
        sb = QWidget()
        sb.setObjectName("sidebar")
        sb.setFixedWidth(190)
        sbl = QVBoxLayout(sb)
        sbl.setContentsMargins(12, 18, 12, 12)
        sbl.setSpacing(4)
        logo = QLabel("PREDATOR")
        logo.setAlignment(Qt.AlignHCenter)
        logo.setStyleSheet(
            f"color: {theme.ACCENT}; font-size: 20px; "
            "font-weight: bold; letter-spacing: 4px;")
        sub = QLabel("Sense Linux")
        sub.setObjectName("dim")
        sub.setAlignment(Qt.AlignHCenter)
        sbl.addWidget(logo)
        sbl.addWidget(sub)
        sbl.addSpacing(14)

        self._pages: dict[str, QWidget] = {
            "Dashboard": DashboardPage(),
            "Fans": FansPage(),
            "Lighting": LightingPage(),
        }
        self._stack = QStackedWidget()
        for page in self._pages.values():
            self._stack.addWidget(page)
        h.addWidget(sb)
        h.addWidget(self._stack, 1)
        self.setCentralWidget(central)

        self._nav: dict[str, QPushButton] = {}
        for name, page in self._pages.items():
            b = QPushButton(name.upper())
            b.setObjectName("nav")
            b.setCheckable(True)
            b.setCursor(Qt.PointingHandCursor)
            idx = list(self._pages.values()).index(page)
            b.clicked.connect(lambda _c=False, i=idx: self._show_index(i))
            self._nav[name] = b
            sbl.addWidget(b)

        sbl.addStretch(1)
        ver = QLabel("psensed @ /run/psense.sock")
        ver.setObjectName("dim")
        sbl.addWidget(ver)

        # ---- daemon pollers ------------------------------------------------
        self._pollers: list[Poller] = []
        for op, interval, slot in (
            ({"op": "sensors"}, 2000, self._on_sensors),
            ({"op": "profile.get"}, 5000, self._on_profile),
            ({"op": "kb.get"}, 4000, self._on_kb),
        ):
            p = Poller(op, interval, self)
            p.connect_to(slot)
            p.start()
            self._pollers.append(p)

        self._show_index(0)
        QTimer.singleShot(800, self._check_reachable)

    # ---- navigation --------------------------------------------------------
    def _show_index(self, idx: int) -> None:
        self._stack.setCurrentIndex(idx)
        page = self._stack.widget(idx)
        for n, b in self._nav.items():
            b.setChecked(self._pages.get(n) is page)
        if isinstance(page, FansPage):
            page.refresh()
        elif isinstance(page, DashboardPage):
            page.refresh_profile()

    # ---- poll receivers ------------------------------------------------------
    def _on_sensors(self, d: dict) -> None:
        self._reachable = True
        page = self._pages["Dashboard"]
        if isinstance(page, DashboardPage):
            page.apply_sensors(d)

    def _on_profile(self, d: dict) -> None:
        page = self._pages["Dashboard"]
        if isinstance(page, DashboardPage):
            page.apply_profile(d)

    def _on_kb(self, d: dict) -> None:
        self._reachable = True
        page = self._pages["Lighting"]
        if isinstance(page, LightingPage):
            page.apply_kb(d)

    def _check_reachable(self) -> None:
        if self._reachable is None:
            run_op({"op": "info"}, self._after_info)

    def _after_info(self, d: dict) -> None:
        if not d:
            QMessageBox.warning(
                self, "psensed unreachable",
                "psensed did not answer on /run/psense.sock.\n"
                "start it:  sudo systemctl start psensed")

    def closeEvent(self, ev):  # noqa: N802
        for poller in self._pollers:
            poller.stopPoller()
        super().closeEvent(ev)


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("predator-sense-linux")
    theme.apply(app)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
