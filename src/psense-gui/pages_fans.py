"""Fans page: mode switch (auto/turbo/custom) + CPU/GPU % sliders + curve list."""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QLabel, QPushButton,
                               QSlider, QVBoxLayout, QWidget)

from client import run_op

FAN_KEYS = {"cpu": "fan1", "gpu": "fan2"}   # hwmon channel naming
MODE_NAMES = {"auto", "turbo", "custom"}


def _rule() -> QFrame:
    r = QFrame()
    r.setFixedHeight(1)
    r.setStyleSheet("background: #002e40; border: none;")
    return r


def _mkslider() -> tuple[QSlider, QLabel]:
    sl = QSlider(Qt.Horizontal)
    sl.setRange(20, 100)
    sl.setValue(60)
    lbl = QLabel("60 %")
    lbl.setObjectName("value")
    sl.valueChanged.connect(lambda v: lbl.setText(f"{v} %"))
    return sl, lbl


class FansPage(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("root")
        self._st: dict = {}
        self._responses: list[str] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(28, 22, 28, 22)
        root.setSpacing(12)

        h = QLabel("FAN CONTROL")
        h.setObjectName("h1")
        root.addWidget(h)
        root.addWidget(_rule())

        root.addWidget(QLabel("MODE", objectName="h2"))
        mrow = QHBoxLayout()
        self._mode: dict[str, QPushButton] = {}
        for name in MODE_NAMES:
            b = QPushButton(name.upper())
            b.setObjectName("mode")
            b.setCheckable(True)
            b.setCursor(Qt.PointingHandCursor)
            b.clicked.connect(lambda _c=False, n=name: self._set_mode(n))
            self._mode[name] = b
            mrow.addWidget(b)
        mrow.addStretch(1)
        root.addLayout(mrow)

        self._sliders: dict[str, QSlider] = {}
        for fan in ("cpu", "gpu"):
            row = QHBoxLayout()
            name = QLabel(f"{fan.upper()} %")
            name.setFixedWidth(70)
            name.setObjectName("value")
            sl, lbl = _mkslider()
            self._sliders[fan] = sl
            row.addWidget(name)
            row.addWidget(sl, 1)
            row.addWidget(lbl)
            root.addLayout(row)
        app = QPushButton("APPLY CUSTOM %")
        app.setObjectName("act")
        app.setCursor(Qt.PointingHandCursor)
        app.clicked.connect(self._apply_speed)
        root.addWidget(app, 0, Qt.AlignLeft)
        root.addWidget(
            QLabel("custom % writes the hwmon pwm channel directly (T0′); sweep map in M1", objectName="dim"))

        root.addWidget(_rule())
        root.addWidget(QLabel("REGISTERED CURVES", objectName="h2"))
        self._curve_label = QLabel("—")
        self._curve_label.setObjectName("dim")
        root.addWidget(self._curve_label)

        rrow = QHBoxLayout()
        reset = QPushButton("RESET (AUTO BOTH)")
        reset.setObjectName("act")
        reset.setCursor(Qt.PointingHandCursor)
        reset.clicked.connect(lambda: run_op({"op": "fan.reset"}, self._log))
        rrow.addWidget(reset)
        rrow.addStretch(1)
        root.addLayout(rrow)

        self._err = QLabel("")
        self._err.setObjectName("dim")
        root.addWidget(self._err)
        root.addStretch(1)

    # --- incoming data ------------------------------------------------
    def refresh(self) -> None:
        run_op({"op": "fan.get"}, self._state_in)

    def _state_in(self, d: dict) -> None:
        self._st = d if isinstance(d, dict) else {}
        self._render()

    def _render(self) -> None:
        modes = []
        for fan, key in FAN_KEYS.items():
            fs = self._st.get(key) or {}
            m = str(fs.get("mode") or "").lower()
            modes.append(f"{fan}: {m}")
            if "custom" in m or fs.get("pwm"):
                try:
                    self._sliders[fan].setValue(round(int(fs["pwm"]) * 100 / 255))
                except (TypeError, ValueError, KeyError):
                    pass
        cur = self._st.get("curves") or {}
        if cur:
            for k, v in cur.items():
                modes.append(f"{k} curve: {v}")
        self._mode["custom"].setChecked(all("custom" in str((self._st.get(k) or {}).get("mode", "")).lower()
                                            for k in FAN_KEYS.values()))
        self._curve_label.setText("   ".join(modes))

    # --- actions --------------------------------------------------------
    def _set_mode(self, name: str) -> None:
        run_op({"op": "fan.mode", "mode": name, "fan": "both"}, self._after)

    def _apply_speed(self) -> None:
        for fan in ("cpu", "gpu"):
            run_op({"op": "fan.speed",
                    "pct": self._sliders[fan].value(), "fan": fan}, self._after)

    def _after(self, d: dict) -> None:
        self._log(d)
        self.refresh()

    def _log(self, d: dict) -> None:
        err = (None if d and not d.get("error") else
               d.get("error") if d else "daemon unreachable")
        if err:
            self._responses.append(str(err))
            self._err.setText("last ops: " + " | ".join(self._responses[-3:]))
        else:
            self._err.setText("")
