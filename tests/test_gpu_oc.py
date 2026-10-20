"""Tests for OEM INI GPU Overclocking Engine (psensed_gpu_oc)."""

import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import importlib.util
from importlib.machinery import SourceFileLoader

from psensed_gpu_oc import GpuOverclockManager, detect_gpu, detect_model

psensed_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src", "psensed"))
loader = SourceFileLoader("psensed", psensed_path)
spec = importlib.util.spec_from_loader("psensed", loader)
psensed = importlib.util.module_from_spec(spec)
loader.exec_module(psensed)


class TestGpuOverclockManager(unittest.TestCase):
    def setUp(self):
        self.ref_ini_dir = os.path.abspath(
            os.path.join(
                os.path.dirname(__file__),
                "..",
                "analysis",
                "reference",
                "predator-sense",
                "PredatorSense_5.0.1463",
                "AgentService",
                "driver",
            )
        )
        self.phn16_ini = os.path.join(self.ref_ini_dir, "Predator PHN16-71.ini")

    def test_load_real_phn16_71_ini_profile(self):
        """Verify real OEM INI Predator PHN16-71.ini parses with correct offsets."""
        if not os.path.isfile(self.phn16_ini):
            self.skipTest("Reference INI file not found in analysis directory")

        gpu_id = "PCI\\VEN_10DE&DEV_28E1&SUBSYS_170F1025"
        mgr = GpuOverclockManager(
            ini_path=self.phn16_ini,
            model="Predator PHN16-71",
            gpu_id=gpu_id,
            apply_fn=lambda c, m: (True, None),
        )

        self.assertTrue(mgr.supported)
        self.assertEqual(mgr.model, "Predator PHN16-71")
        self.assertEqual(mgr.gpu_id, gpu_id)

        # Performance / Turbo mode -> +100 Core, +200 Memory
        core, mem = mgr.resolve_offsets("performance")
        self.assertEqual(core, 100)
        self.assertEqual(mem, 200)

        core, mem = mgr.resolve_offsets("turbo")
        self.assertEqual(core, 100)
        self.assertEqual(mem, 200)

        # Balanced / Quiet / Default -> 0 Core, 0 Memory
        core, mem = mgr.resolve_offsets("balanced")
        self.assertEqual(core, 0)
        self.assertEqual(mem, 0)

        core, mem = mgr.resolve_offsets("quiet")
        self.assertEqual(core, 0)
        self.assertEqual(mem, 0)

    def test_custom_ini_profile_parsing(self):
        """Test parsing of a custom model INI profile."""
        ini_content = """[OC_GPU]
Count=1
GPUName1=PCI\\VEN_10DE&DEV_9999&SUBSYS_ABCD1025
[PCI\\VEN_10DE&DEV_9999&SUBSYS_ABCD1025]
Quiet=5
Default=10
Turbo=135
RAM_Quiet=15
RAM_Default=20
RAM_Turbo=320
"""
        with tempfile.NamedTemporaryFile("w", suffix=".ini", delete=False) as tf:
            tf.write(ini_content)
            tf_path = tf.name

        try:
            mgr = GpuOverclockManager(
                ini_path=tf_path,
                model="TestLaptop",
                gpu_id="PCI\\VEN_10DE&DEV_9999&SUBSYS_ABCD1025",
                apply_fn=lambda c, m: (True, None),
            )
            self.assertTrue(mgr.supported)
            self.assertEqual(mgr.resolve_offsets("turbo"), (135, 320))
            self.assertEqual(mgr.resolve_offsets("performance"), (135, 320))
            self.assertEqual(mgr.resolve_offsets("balanced"), (5, 15))
        finally:
            if os.path.exists(tf_path):
                os.unlink(tf_path)

    def test_apply_mode_performance_and_turbo(self):
        """Test apply_mode('performance') and apply_mode('turbo') applies +100/+200 offsets."""
        apply_mock = MagicMock(return_value=(True, None))
        mgr = GpuOverclockManager(
            ini_path=self.phn16_ini if os.path.isfile(self.phn16_ini) else None,
            model="Predator PHN16-71",
            gpu_id="PCI\\VEN_10DE&DEV_28E1&SUBSYS_170F1025",
            apply_fn=apply_mock,
        )

        res = mgr.apply_mode("performance")
        self.assertTrue(res["supported"])
        self.assertTrue(res["applied"])
        self.assertIsNone(res["error"])
        self.assertEqual(res["core_offset_mhz"], 100)
        self.assertEqual(res["mem_offset_mhz"], 200)
        self.assertEqual(res["mode"], "performance")
        apply_mock.assert_called_with(100, 200)

        # Apply turbo mode
        apply_mock.reset_mock()
        res = mgr.apply_mode("turbo")
        self.assertTrue(res["applied"])
        self.assertEqual(res["core_offset_mhz"], 100)
        self.assertEqual(res["mem_offset_mhz"], 200)
        apply_mock.assert_called_with(100, 200)

    def test_apply_mode_balanced_resets_offsets(self):
        """Test apply_mode('balanced') resets offsets to 0."""
        apply_mock = MagicMock(return_value=(True, None))
        mgr = GpuOverclockManager(
            ini_path=self.phn16_ini if os.path.isfile(self.phn16_ini) else None,
            model="Predator PHN16-71",
            gpu_id="PCI\\VEN_10DE&DEV_28E1&SUBSYS_170F1025",
            apply_fn=apply_mock,
        )

        # First set performance
        mgr.apply_mode("performance")

        # Now reset to balanced
        apply_mock.reset_mock()
        res = mgr.apply_mode("balanced")
        self.assertTrue(res["applied"])
        self.assertEqual(res["core_offset_mhz"], 0)
        self.assertEqual(res["mem_offset_mhz"], 0)
        self.assertEqual(res["mode"], "balanced")
        apply_mock.assert_called_with(0, 0)

        # Quiet mode also resets to 0
        apply_mock.reset_mock()
        res = mgr.apply_mode("quiet")
        self.assertEqual(res["core_offset_mhz"], 0)
        self.assertEqual(res["mem_offset_mhz"], 0)
        apply_mock.assert_called_with(0, 0)

    def test_manual_override_offsets(self):
        """Test set_offsets manual override."""
        apply_mock = MagicMock(return_value=(True, None))
        mgr = GpuOverclockManager(
            model="Predator PHN16-71",
            gpu_id="PCI\\VEN_10DE&DEV_28E1&SUBSYS_170F1025",
            apply_fn=apply_mock,
        )

        res = mgr.set_offsets(120, 250)
        self.assertEqual(res["mode"], "manual")
        self.assertEqual(res["core_offset_mhz"], 120)
        self.assertEqual(res["mem_offset_mhz"], 250)
        self.assertTrue(res["applied"])
        apply_mock.assert_called_with(120, 250)

    def test_graceful_degradation_hardware_failure(self):
        """Test graceful degradation when driver fails or GPU is in D3cold power gate."""
        apply_mock = MagicMock(return_value=(False, "GPU is in D3cold sleep state"))
        mgr = GpuOverclockManager(
            model="Predator PHN16-71",
            gpu_id="PCI\\VEN_10DE&DEV_28E1&SUBSYS_170F1025",
            apply_fn=apply_mock,
        )

        res = mgr.apply_mode("performance")
        self.assertFalse(res["applied"])
        self.assertIn("D3cold", res["error"])
        self.assertEqual(res["core_offset_mhz"], 100)
        self.assertEqual(res["mem_offset_mhz"], 200)

    def test_graceful_degradation_no_gpu(self):
        """Test behavior when no NVIDIA GPU is detected."""
        mgr = GpuOverclockManager(
            model="Predator PHN16-71",
            gpu_id=None,
        )
        self.assertFalse(mgr.supported)
        self.assertIn("No NVIDIA GPU", mgr.error)

        res = mgr.apply_mode("performance")
        self.assertFalse(res["supported"])
        self.assertFalse(res["applied"])
        self.assertIsNotNone(res["error"])

    def test_daemon_op_system_integration(self):
        """Test daemon op_profile / op_system integration with gpu.oc ops."""
        daemon = psensed.Daemon.__new__(psensed.Daemon)
        apply_mock = MagicMock(return_value=(True, None))
        daemon.gpu_oc = GpuOverclockManager(
            model="Predator PHN16-71",
            gpu_id="PCI\\VEN_10DE&DEV_28E1&SUBSYS_170F1025",
            apply_fn=apply_mock,
        )

        # Test gpu.oc.get
        st = daemon.op_system("gpu.oc.get", {})
        self.assertTrue(st["supported"])
        self.assertEqual(st["model"], "Predator PHN16-71")

        # Test gpu.oc.set
        set_res = daemon.op_system("gpu.oc.set", {"core": 150, "mem": 300})
        self.assertEqual(set_res["mode"], "manual")
        self.assertEqual(set_res["core_offset_mhz"], 150)
        self.assertEqual(set_res["mem_offset_mhz"], 300)
        self.assertTrue(set_res["applied"])
        apply_mock.assert_called_with(150, 300)

        # Test dispatch routing
        req_get = {"op": "gpu.oc.get"}
        d_res = daemon._dispatch(req_get)
        self.assertEqual(d_res["model"], "Predator PHN16-71")

        req_set = {"op": "gpu.oc.set", "core": 80, "mem": 160}
        d_set = daemon._dispatch(req_set)
        self.assertEqual(d_set["core_offset_mhz"], 80)
        self.assertEqual(d_set["mem_offset_mhz"], 160)

    def test_daemon_profile_set_name_and_choice(self):
        """Verify profile.set accepts both 'name' and 'choice' keys."""
        daemon = psensed.Daemon.__new__(psensed.Daemon)
        apply_mock = MagicMock(return_value=(True, None))
        daemon.gpu_oc = GpuOverclockManager(
            model="Predator PHN16-71",
            gpu_id="PCI\\VEN_10DE&DEV_28E1&SUBSYS_170F1025",
            apply_fn=apply_mock,
        )

        with patch.object(psensed, "find_platform_profile", return_value="/tmp/mock_pp"), \
             patch.object(psensed, "read", return_value="low-power balanced performance"), \
             patch.object(psensed, "write", return_value=True):
            # Test with 'name' key (used by CLI and Electron GUI)
            res_name = daemon.op_system("profile.set", {"name": "performance"})
            self.assertEqual(res_name["profile"], "performance")
            self.assertTrue(res_name["gpu_oc"]["applied"])
            self.assertEqual(res_name["gpu_oc"]["core_offset_mhz"], 100)

            # Test with 'choice' key
            res_choice = daemon.op_system("profile.set", {"choice": "balanced"})
            self.assertEqual(res_choice["profile"], "balanced")
            self.assertTrue(res_choice["gpu_oc"]["applied"])
            self.assertEqual(res_choice["gpu_oc"]["core_offset_mhz"], 0)


if __name__ == "__main__":
    unittest.main()
