"""Predator Sense Linux GUI — theme.

Palette + fonts ported 1:1 from Predator Sense 5.0.1.463's stylesheet
(`styles.4ff4983a2c9326e4.css`, ledger §13.17): dark #000 base, Predator-teal
#00c8ec accent, #f44336 alert red, Predator OTF fonts.
"""
from __future__ import annotations

import os

ASSETS = os.path.join(os.path.dirname(__file__), "assets")

# --- palette (from Predator Sense styles.css) --------------------------------
BG        = "#000000"
PANEL     = "#0b0d10"
PANEL_2   = "#111418"
BORDER    = "#002e40"
ACCENT    = "#00c8ec"
ACCENT_DIM= "#006476"
ACCENT_DK = "#002e40"
ALERT     = "#f44336"
AMBER     = "#ffd740"
GREEN     = "#1eff96"
TEXT      = "#fafafa"
TEXT_DIM  = "#b0b0b0"

FONT_FAMILY = "Predator"


def load_fonts(app) -> None:
    """Register the extracted Predator OTFs system-independently."""
    from PySide6.QtGui import QFontDatabase
    import os
    fdir = os.path.join(ASSETS, "fonts")
    for f in os.listdir(fdir):
        if f.lower().endswith((".otf", ".ttf")):
            fid = QFontDatabase.addApplicationFont(os.path.join(fdir, f))
            if fid < 0:
                # fallback: application font family name only
                continue

DARK_QSS = f"""
* {{
    font-family: "{FONT_FAMILY}", "Noto Sans", sans-serif;
}}
QMainWindow, QWidget#root {{
    background-color: {BG};
}}
QLabel {{
    color: {TEXT};
    background: transparent;
}}
QLabel#h1 {{
    font-size: 26px;
    font-weight: bold;
    letter-spacing: 2px;
    color: {TEXT};
}}
QLabel#h2 {{
    font-size: 15px;
    font-weight: bold;
    color: {ACCENT};
    letter-spacing: 1.5px;
}}
QLabel#dim {{
    color: {TEXT_DIM};
    font-size: 12px;
}}
QLabel#stat {{
    font-size: 30px;
    font-weight: bold;
    color: {AMBER};
}}
QLabel#statBig {{
    font-size: 44px;
    font-weight: bold;
    color: {AMBER};
}}
QLabel#value {{
    color: {TEXT};
    font-size: 18px;
}}
QFrame#card {{
    background-color: {PANEL};
    border: 1px solid {ACCENT_DK};
    border-radius: 6px;
}}
QFrame#sidebar {{
    background-color: {PANEL_2};
    border-right: 1px solid {ACCENT_DK};
}}
QPushButton#nav {{
    color: {TEXT_DIM};
    background: transparent;
    border: none;
    text-align: left;
    padding: 10px 14px;
    font-size: 13px;
}}
QPushButton#nav:hover {{
    color: {ACCENT};
    background-color: {ACCENT_DK};
}}
QPushButton#nav:checked {{
    color: {BG};
    background-color: {ACCENT};
    font-weight: bold;
}}
QPushButton#mode {{
    color: {TEXT};
    background-color: {PANEL_2};
    border: 1px solid {ACCENT_DK};
    border-radius: 4px;
    padding: 8px 18px;
    font-size: 12px;
}}
QPushButton#mode:hover {{
    border-color: {ACCENT};
    color: {ACCENT};
}}
QPushButton#mode:checked {{
    background-color: {ACCENT};
    color: {BG};
    border-color: {ACCENT};
    font-weight: bold;
}}
QPushButton#act {{
    color: {ACCENT};
    background-color: transparent;
    border: 1px solid {ACCENT};
    border-radius: 4px;
    padding: 6px 14px;
}}
QPushButton#act:hover {{
    background-color: {ACCENT_DK};
}}
QSlider::groove:horizontal {{
    background: {ACCENT_DK};
    height: 6px;
    border-radius: 3px;
}}
QSlider::sub-page:horizontal {{
    background: {ACCENT};
    border-radius: 3px;
}}
QSlider::handle:horizontal {{
    background: {TEXT};
    width: 14px;
    margin: -5px 0;
    border-radius: 7px;
}}
QProgressBar {{
    background: {ACCENT_DK};
    border: none;
    border-radius: 3px;
    text-align: center;
    color: {TEXT};
    font-weight: bold;
}}
QProgressBar::chunk {{
    background: {ACCENT};
    border-radius: 3px;
}}
QScrollArea {{
    border: none;
}}
"""


def apply(app) -> None:
    import os
    load_fonts(app)
    app.setStyleSheet(DARK_QSS)
