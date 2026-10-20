"""Regression tests for the feat/hardening errata batch (daemon-protocol §11).

E1  fan.reset {fan} must honor the `fan` argument (was passed positionally
    as pct and silently ignored: both fans always reset).
E2  fan.curve.clear must reject invalid fan values with a useful message.
E3  src/psensed must import `re` (the sysinfo lspci display scan silently
    no-opped on NameError before the import was restored).
"""

import os
import sys
import unittest
import importlib.util
from importlib.machinery import SourceFileLoader

psensed_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src", "psensed"))
loader = SourceFileLoader("psensed_hardening", psensed_path)
spec = importlib.util.spec_from_loader("psensed_hardening", loader)
psensed = importlib.util.module_from_spec(spec)
loader.exec_module(psensed)


def make_daemon():
    """Daemon instance bypassing __init__ (no socket bind, no threads)."""
    d = psensed.Daemon.__new__(psensed.Daemon)
    d.pwms = ["pwm1", "pwm2"]
    d.pwms_ok = True
    d.curves = {}
    d.last_write = 0.0
    return d


class WriteRecorder:
    """Patches psensed.write to record (path, value) and succeed."""

    def __init__(self):
        self.calls = []

    def __enter__(self):
        self._orig = psensed.write
        psensed.write = lambda path, value: self.calls.append((path, value)) or True
        return self

    def __exit__(self, *exc):
        psensed.write = self._orig


class TestFanResetHonoursFan(unittest.TestCase):
    def setUp(self):
        self.d = make_daemon()

    def test_cpu_only(self):
        with WriteRecorder() as rec:
            r = self.d._misc("fan.reset", {"fan": "cpu"})
        self.assertNotIn("error", r)
        self.assertEqual(r["applied"], {"fan1": "auto"})
        self.assertTrue(all(p.startswith("pwm1") for p, _ in rec.calls))

    def test_gpu_only(self):
        with WriteRecorder() as rec:
            r = self.d._misc("fan.reset", {"fan": "gpu"})
        self.assertEqual(r["applied"], {"fan2": "auto"})
        self.assertTrue(all(p.startswith("pwm2") for p, _ in rec.calls))

    def test_default_both(self):
        with WriteRecorder() as rec:
            r = self.d._misc("fan.reset", {})
        self.assertEqual(r["applied"], {"fan1": "auto", "fan2": "auto"})
        self.assertEqual(len(rec.calls), 2)

    def test_auto_pops_curve(self):
        self.d.curves[1] = {"points": [(50, 50)], "last_pct": 50}
        with WriteRecorder():
            self.d._misc("fan.reset", {"fan": "cpu"})
        self.assertNotIn(1, self.d.curves)


class TestCurveClearMessages(unittest.TestCase):
    def setUp(self):
        self.d = make_daemon()

    def test_invalid_fan_name(self):
        r = self.d.op_fan("fan.curve.clear", {"fan": "wiimote"})
        self.assertEqual(r, {"error": "fan must be cpu|gpu"})

    def test_missing_fan_arg(self):
        r = self.d.op_fan("fan.curve.clear", {})
        self.assertEqual(r, {"error": "fan must be cpu|gpu"})

    def test_no_curve_registered(self):
        r = self.d.op_fan("fan.curve.clear", {"fan": "cpu"})
        self.assertEqual(r, {"error": "no curve for fan cpu"})

    def test_clear_registered_cpu(self):
        self.d.curves[1] = {"points": [(40, 25), (80, 70)], "last_pct": 70}
        with WriteRecorder() as rec:
            r = self.d.op_fan("fan.curve.clear", {"fan": "cpu"})
        self.assertEqual(r["cleared"], "fan1")
        self.assertEqual(r["applied"], {"fan1": "auto"})
        self.assertEqual(self.d.curves, {})
        self.assertTrue(all(p.startswith("pwm1") for p, _ in rec.calls))


class TestReImportForSysinfoScan(unittest.TestCase):
    def test_module_has_re(self):
        import re as re_mod
        self.assertIs(psensed.re, re_mod)

    def test_display_scan_pattern_parses(self):
        # the lspci display-controller scan that used to NameError
        m = psensed.re.match(r"(.*?)\s+\[[0-9a-f]{4}:[0-9a-f]{4}\]",
                             "NVIDIA GA106M [GeForce RTX 3060 Mobile] [10de:2560]")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "NVIDIA GA106M [GeForce RTX 3060 Mobile]")


class TestBattmodeCommittedContract(unittest.TestCase):
    """E4 client-side half: ensure the CLI honours committed:false (static check)."""

    def test_cli_source_checks_committed(self):
        with open(os.path.join(os.path.dirname("."), "src", "psense"),
                  encoding="utf-8") as f:
            src = f.read()
        self.assertIn('r.get("committed") is False', src)
        self.assertIn("warning: EC did not commit the new mode", src)


if __name__ == "__main__":
    unittest.main()
