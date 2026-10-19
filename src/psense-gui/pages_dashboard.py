"""Dashboard: live sensors (temps/RPM) + thermal-profile quick switch."""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QLabel, QVBoxLayout,
                               QWidget, QGridLayout)

from client import run_op

PROFILES = ["low-power", "quiet", "balanced", "balanced-performance", "performance"]


def _card(title: str, stat_label: str = "stat") -> tuple[QFrame, QLabel, QLabel]:
    f = QFrame()
    f.setObjectName("card")
    lay = QVBoxLayout(f)
    lay.setContentsMargins(16, 12, 16, 14)
    lay.setSpacing(2)
    t = QLabel(title.upper())
    t.setObjectName("h2")
    v = QLabel("—")
    v.setObjectName(stat_label)
    v.setAlignment(Qt.AlignHCenter)
    lay.addWidget(t)
    lay.addWidget(v)
    lay.addStretch(1)
    return f, v, t


class DashboardPage(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("root")
        self._profiles: dict[str, str] = {}

        root = QVBoxLayout(self)
        root.setContentsMargins(28, 22, 28, 22)
        root.setSpacing(14)

        h = QLabel("DASHBOARD")
        h.setObjectName("h1")
        root.addWidget(h)
        root.addWidget(self._rule())

        grid = QGridLayout()
        grid.setSpacing(14)

        cards = [
            ("CPU Fan", "rpm"), ("GPU Fan", "rpm"),
            ("Temp 1", "temp"), ("Temp 2", "temp"), ("Temp 3", "temp"),
        ]
        self._st: dict[str, QLabel] = {}
        for i, (name, kind) in enumerate(cards):
            f, v, _t = _card(name, "stat")
            f.setFixedHeight(120)
            self._st[name] = v
            grid.addWidget(f, i // 3, i % 3)
        root.addLayout(grid)

        # --- profile quick switch -------------------------------------
        root.addWidget(self._rule())
        p = QLabel("THERMAL PROFILE")
        p.setObjectName("h2")
        root.addWidget(p)
        prow = QHBoxLayout()
        prow.setSpacing(10)
        self._pbtns: dict[str, QWidget] = {}
        from PySide6.QtWidgets import QPushButton
        for name in PROFILES:
            b = QPushButton(name.upper().replace("-", " "))
            b.setObjectName("mode")
            b.setCheckable(True)
            b.setCursor(Qt.PointingHandCursor)
            b.clicked.connect(lambda _c=False, n=name: self._set_profile(n))
            self._pbtns[name] = b
            prow.addWidget(b)
        prow.addStretch(1)
        root.addLayout(prow)

        self.err = QLabel("")
        self.err.setObjectName("dim")
        root.addWidget(self.err)
        root.addStretch(1)

    # ------------------------------------------------------------------
    @staticmethod
    def _rule() -> QFrame:
        r = QFrame()
        r.setFixedHeight(1)
        r.setStyleSheet("background: #002e40; border: none;")
        return r

    # --- incoming data ------------------------------------------------
    def apply_sensors(self, d: dict) -> None:
        rpm = d.get("fans_rpm") or {}
        temps = d.get("temps") or {}
        cpu = rpm.get("cpu") or rpm.get("fan1_input") or "—"
        gpu = rpm.get("gpu") or rpm.get("fan2_input") or "—"
        for key, val in (("CPU Fan", cpu), ("GPU Fan", gpu)):
            try:
                self._st[key].setText(f"{int(val)} RPM")
            except (TypeError, ValueError):
                self._st[key].setText(str(val))
        items = list(temps.items())
        for name in ("Temp 1", "Temp 2", "Temp 3"):
            idx = int(name.split()[1]) - 1
            label, val = items[idx] if idx < len(items) else ("", "0")
            try:
                c = int(val) / 1000.0
                self._st[name].setText(f"{c:.0f} °C")
            except (TypeError, ValueError):
                self._st[name].setText("—")
        self.err.setText("")

    def apply_profile(self, d: dict) -> None:
        cur = (d.get("profile") or "").strip()
        choices = d.get("choices") or []
        if cur:
            for name, b in self._pbtns.items():
                b.setChecked(cur.lower() == name.lower())
        if choices and not self._profiles:
            self._profiles = {c: "choices" for c in choices}
            self.err.setText("")

    def refresh_profile(self) -> None:
        run_op({"op": "profile.get"}, self.apply_profile)

    # --- actions --------------------------------------------------------
    def _set_profile(self, name: str) -> None:
        for n, b in self._pbtns.items():
            b.setChecked(n == name)
        run_op({"op": "profile.set", "name": name}, self._after_set)

    def _after_set(self, d: dict) -> None:
        if not d:
            self.err.setText("daemon unreachable")
        elif d.get("error"):
            self.err.setText(f"profile set failed: {d['error']}")
        else:
            self.err.setText("")
        self.refresh_profile()
