"""Tests for CLI keyboard dynamic effects (psense kb effect ...).

Verifies command-line parsing, options, defaults, error handling,
and backward compatibility with existing kb get / kb restore / kb zone commands.
"""

import io
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

# Import src/psense dynamically (load_module() was removed in Python 3.15)
import importlib.util
from importlib.machinery import SourceFileLoader

PSENSE_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src", "psense"))
loader = SourceFileLoader("psense", PSENSE_PATH)
spec = importlib.util.spec_from_loader("psense", loader)
psense = importlib.util.module_from_spec(spec)
loader.exec_module(psense)


class TestCliLighting(unittest.TestCase):
    def setUp(self):
        self.mock_daemon_req = patch.object(psense, "daemon_req").start()
        # Default mock response for daemon_req info and operations
        self.mock_daemon_req.side_effect = self._fake_daemon_req
        self.last_op = None
        self.last_sock = None

    def tearDown(self):
        patch.stopall()

    def _fake_daemon_req(self, op, sock="/run/psense.sock", timeout=5, silent=False):
        self.last_op = op
        self.last_sock = sock
        name = op.get("op")
        if name == "info":
            return {"status": 0}
        if name == "kb.effect.set":
            return {
                "status": 0,
                "effect": {
                    "running": True,
                    "effect": op.get("effect").upper(),
                    "speed": op.get("speed"),
                    "brightness": op.get("brightness"),
                    "direction": op.get("direction"),
                    "color": op.get("rgb"),
                    "zone_count": 4,
                },
            }
        if name == "kb.effect.stop":
            return {"status": 0, "stopped": True}
        if name == "kb.effect.get":
            return {
                "status": 0,
                "effect": {
                    "running": True,
                    "effect": "WAVE",
                    "speed": 3,
                    "brightness": 100,
                    "direction": 1,
                    "color": [0, 174, 199],
                    "zone_count": 4,
                },
            }
        if name == "kb.get":
            return {"status": 0, "mode": 0, "brightness": 100}
        if name == "kb.restore":
            return {"status": 0, "restored": True}
        if name == "kb.zone.set":
            return {"status": 0, "zones": op.get("zones")}
        if name == "kb.set":
            return {"status": 0, "mode": op.get("mode")}
        return {"status": 0}

    def run_cli(self, argv):
        with patch.object(sys, "argv", ["psense"] + argv):
            with patch("sys.stdout", new_callable=io.StringIO) as out_s, \
                 patch("sys.stderr", new_callable=io.StringIO) as err_s:
                psense.main()
                return out_s.getvalue(), err_s.getvalue()

    def test_effect_wave_speed(self):
        out, err = self.run_cli(["kb", "effect", "wave", "--speed", "5"])
        self.assertIsNotNone(self.last_op)
        self.assertEqual(self.last_op.get("op"), "kb.effect.set")
        self.assertEqual(self.last_op.get("effect"), "wave")
        self.assertEqual(self.last_op.get("speed"), 5)
        self.assertEqual(self.last_op.get("brightness"), 100)
        self.assertEqual(self.last_op.get("direction"), 1)
        self.assertEqual(self.last_op.get("rgb"), [0, 174, 199])
        self.assertIn("Keyboard effect -> WAVE", out)
        self.assertIn("speed: 5", out)

    def test_effect_breathing_color(self):
        out, err = self.run_cli(["kb", "effect", "breathing", "--color", "00ffcc"])
        self.assertIsNotNone(self.last_op)
        self.assertEqual(self.last_op.get("op"), "kb.effect.set")
        self.assertEqual(self.last_op.get("effect"), "breathing")
        self.assertEqual(self.last_op.get("rgb"), [0, 255, 204])
        self.assertEqual(self.last_op.get("speed"), 3)
        self.assertEqual(self.last_op.get("brightness"), 100)
        self.assertIn("Keyboard effect -> BREATHING", out)

    def test_effect_stop(self):
        out, err = self.run_cli(["kb", "effect", "stop"])
        self.assertIsNotNone(self.last_op)
        self.assertEqual(self.last_op.get("op"), "kb.effect.stop")
        self.assertIn("Keyboard effect stopped", out)

    def test_effect_status(self):
        out, err = self.run_cli(["kb", "effect", "status"])
        self.assertIsNotNone(self.last_op)
        self.assertEqual(self.last_op.get("op"), "kb.effect.get")
        self.assertIn("Active effect: WAVE", out)

    def test_effect_no_args_shows_status(self):
        out, err = self.run_cli(["kb", "effect"])
        self.assertIsNotNone(self.last_op)
        self.assertEqual(self.last_op.get("op"), "kb.effect.get")
        self.assertIn("Active effect: WAVE", out)

    def test_effect_json_flag(self):
        out, err = self.run_cli(["kb", "effect", "wave", "--json"])
        self.assertIsNotNone(self.last_op)
        data = json.loads(out)
        self.assertEqual(data.get("status"), 0)
        self.assertEqual(data.get("effect", {}).get("effect"), "WAVE")

    def test_effect_direction_options(self):
        self.run_cli(["kb", "effect", "shifting", "--direction", "2"])
        self.assertEqual(self.last_op.get("direction"), 2)

        self.run_cli(["kb", "effect", "shifting", "--dir", "left"])
        self.assertEqual(self.last_op.get("direction"), 2)

        self.run_cli(["kb", "effect", "shifting", "--direction", "right"])
        self.assertEqual(self.last_op.get("direction"), 1)

    def test_effect_aliases_rainbow_and_neon(self):
        self.run_cli(["kb", "effect", "rainbow"])
        self.assertEqual(self.last_op.get("effect"), "wave")

        self.run_cli(["kb", "effect", "neon"])
        self.assertEqual(self.last_op.get("effect"), "shifting")

    def test_backward_compatibility_kb_get(self):
        out, err = self.run_cli(["kb", "get"])
        self.assertIsNotNone(self.last_op)
        self.assertEqual(self.last_op.get("op"), "kb.get")
        data = json.loads(out)
        self.assertEqual(data.get("status"), 0)

    def test_backward_compatibility_kb_restore(self):
        out, err = self.run_cli(["kb", "restore"])
        self.assertIsNotNone(self.last_op)
        self.assertEqual(self.last_op.get("op"), "kb.restore")
        data = json.loads(out)
        self.assertEqual(data.get("status"), 0)

    def test_backward_compatibility_kb_zone(self):
        out, err = self.run_cli(["kb", "zone", "--zones", "all", "--rgb", "0,174,199"])
        self.assertIsNotNone(self.last_op)
        self.assertEqual(self.last_op.get("op"), "kb.zone.set")
        self.assertEqual(self.last_op.get("zones"), "all")
        self.assertEqual(self.last_op.get("rgb"), [0, 174, 199])

    def test_color_parsing_formats(self):
        self.assertEqual(psense.parse_color("00ffcc"), [0, 255, 204])
        self.assertEqual(psense.parse_color("#00ffcc"), [0, 255, 204])
        self.assertEqual(psense.parse_color("#0fc"), [0, 255, 204])
        self.assertEqual(psense.parse_color("0fc"), [0, 255, 204])
        self.assertEqual(psense.parse_color("0,255,200"), [0, 255, 200])
        self.assertEqual(psense.parse_color(" 10, 20, 30 "), [10, 20, 30])
        self.assertEqual(psense.parse_color(None), [0, 174, 199])

    def test_kb_set_direction_parsing(self):
        self.run_cli(["kb", "set", "wave", "--dir", "left"])
        self.assertEqual(self.last_op.get("dir"), 2)

        self.run_cli(["kb", "set", "wave", "--dir", "right"])
        self.assertEqual(self.last_op.get("dir"), 1)

    def test_invalid_effect(self):
        with self.assertRaises(SystemExit):
            self.run_cli(["kb", "effect", "nonexistent_effect"])


if __name__ == "__main__":
    unittest.main()
