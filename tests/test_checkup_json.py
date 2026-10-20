"""H3: pin the machine contract of `psense checkup --json`.

Consumers (scripts, the Rust shadow daemon diff, CI) rely on:
- exit code 0 even when the daemon socket is unreachable (fields degrade,
  they do not crash: daemon-driven keys fall back to empty defaults),
- valid JSON on stdout with stable top-level keys:
  system (object), battery (object), storage (list), ram (object).

The subprocess is launched against an unused socket path so the contract
holds on a bare CI runner without root or a live psensed.
"""

import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "src", "psense")


class TestCheckupJsonContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.run(
            [os.path.abspath(sys.executable), CLI, "checkup", "--json",
             "--sock", os.path.join(os.environ.get("TMPDIR", "/tmp"),
                                    "psense-test-unreachable.sock")],
            capture_output=True, text=True, timeout=60,
        )

    def test_exit_code_zero_without_daemon(self):
        self.assertEqual(self.proc.returncode, 0,
                         f"stderr: {self.proc.stderr[-400:]}")

    def test_stdout_is_valid_json(self):
        payload = json.loads(self.proc.stdout)
        self.assertIsInstance(payload, dict)

    def test_stable_top_level_keys(self):
        payload = json.loads(self.proc.stdout)
        self.assertEqual(sorted(payload.keys()), ["battery", "ram", "storage", "system"])
        self.assertIsInstance(payload["system"], dict)
        self.assertIsInstance(payload["battery"], dict)
        self.assertIsInstance(payload["storage"], list)
        self.assertIsInstance(payload["ram"], dict)

    def test_system_fields_present(self):
        payload = json.loads(self.proc.stdout)
        self.assertEqual(sorted(payload["system"].keys()),
                         ["bios_version", "kernel", "os", "product_name"])


if __name__ == "__main__":
    unittest.main()
