import unittest
import time
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

try:
    from psensed_lighting import (
        hsv_to_rgb,
        rgb_to_hsv,
        scale_rgb,
        lerp_color,
        DaemonLightingEngine,
    )
except ImportError:
    hsv_to_rgb = None
    rgb_to_hsv = None
    scale_rgb = None
    lerp_color = None
    DaemonLightingEngine = None


class TestLightingEngineMath(unittest.TestCase):
    def setUp(self):
        if hsv_to_rgb is None:
            self.fail("psensed_lighting module could not be imported")

    def test_hsv_to_rgb_primary_colors(self):
        self.assertEqual(hsv_to_rgb(0, 1.0, 1.0), (255, 0, 0))
        self.assertEqual(hsv_to_rgb(120, 1.0, 1.0), (0, 255, 0))
        self.assertEqual(hsv_to_rgb(240, 1.0, 1.0), (0, 0, 255))
        self.assertEqual(hsv_to_rgb(0, 0.0, 0.0), (0, 0, 0))
        self.assertEqual(hsv_to_rgb(0, 0.0, 1.0), (255, 255, 255))

    def test_rgb_to_hsv(self):
        h, s, v = rgb_to_hsv(255, 0, 0)
        self.assertAlmostEqual(h, 0.0, places=1)
        self.assertAlmostEqual(s, 1.0, places=2)
        self.assertAlmostEqual(v, 1.0, places=2)

        h, s, v = rgb_to_hsv(0, 255, 0)
        self.assertAlmostEqual(h, 120.0, places=1)
        self.assertAlmostEqual(s, 1.0, places=2)

        h, s, v = rgb_to_hsv(0, 0, 255)
        self.assertAlmostEqual(h, 240.0, places=1)

    def test_scale_rgb(self):
        self.assertEqual(scale_rgb((100, 200, 50), 0.5), (50, 100, 25))
        self.assertEqual(scale_rgb((100, 200, 50), 0.0), (0, 0, 0))
        self.assertEqual(scale_rgb((200, 200, 200), 2.0), (255, 255, 255))

    def test_lerp_color(self):
        c1 = (0, 0, 0)
        c2 = (100, 200, 50)
        self.assertEqual(lerp_color(c1, c2, 0.0), (0, 0, 0))
        self.assertEqual(lerp_color(c1, c2, 1.0), (100, 200, 50))
        self.assertEqual(lerp_color(c1, c2, 0.5), (50, 100, 25))


class TestDaemonLightingEngine(unittest.TestCase):
    def setUp(self):
        if DaemonLightingEngine is None:
            self.fail("DaemonLightingEngine could not be imported")

    def test_start_stop_effect(self):
        frames = []

        def sink(zones):
            frames.append(zones)

        engine = DaemonLightingEngine(frame_sink=sink)
        status = engine.get_status()
        self.assertFalse(status["running"])
        self.assertIsNone(status["effect"])

        # Start BREATHING effect
        engine.start_effect("BREATHING", speed=5, brightness=80, color=(0, 255, 255))
        st = engine.get_status()
        self.assertTrue(st["running"])
        self.assertEqual(st["effect"], "BREATHING")
        self.assertEqual(st["speed"], 5)
        self.assertEqual(st["brightness"], 80)
        self.assertEqual(st["color"], (0, 255, 255))

        # Wait for a few frames
        time.sleep(0.12)
        self.assertGreater(len(frames), 1)
        self.assertEqual(len(frames[0]), 4)

        # Stop effect
        engine.stop_effect()
        st2 = engine.get_status()
        self.assertFalse(st2["running"])
        self.assertIsNone(st2["effect"])

    def test_all_effects_render(self):
        effects = ["BREATHING", "WAVE", "SHIFTING", "METEOR", "TWINKLING"]
        for eff in effects:
            frames = []
            engine = DaemonLightingEngine(frame_sink=lambda z: frames.append(z))
            engine.start_effect(eff, speed=4, brightness=100, direction=1, color=(255, 0, 128))
            time.sleep(0.09)
            engine.stop_effect()
            self.assertGreater(len(frames), 0, f"Effect {eff} did not generate any frames")
            self.assertEqual(len(frames[-1]), 4, f"Effect {eff} did not produce 4 zones")
            for zone_rgb in frames[-1]:
                self.assertEqual(len(zone_rgb), 3)
                for val in zone_rgb:
                    self.assertGreaterEqual(val, 0)
                    self.assertLessEqual(val, 255)


class DummyWmi:
    def __init__(self):
        self.calls = []

    def eval(self, guid, mid, in_bytes=b"", out_len=64):
        self.calls.append((guid, mid, in_bytes, out_len))
        return 0, b"\x00" * out_len


class TestPsensedIntegration(unittest.TestCase):
    def test_daemon_op_wmi_effects(self):
        # Test op_wmi effect methods without needing /dev/psense-wmi hardware
        from importlib.machinery import SourceFileLoader
        import importlib.util
        psensed_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src", "psensed"))
        loader = SourceFileLoader("psensed", psensed_path)
        spec = importlib.util.spec_from_loader("psensed", loader)
        psensed = importlib.util.module_from_spec(spec)
        loader.exec_module(psensed)
        # Save original state loader/saver
        orig_save = psensed._save_lighting_state
        orig_load = psensed._load_lighting_state
        saved_states = []
        psensed._save_lighting_state = lambda s: saved_states.append(s) or True
        psensed._load_lighting_state = lambda: saved_states[-1] if saved_states else None

        try:
            class MockDaemon:
                pass
            daemon = MockDaemon()
            daemon.wmi = DummyWmi()
            daemon._last_lighting_zones = None
            daemon.lighting_engine = DaemonLightingEngine(lambda z: psensed.Daemon._apply_lighting_frame(daemon, z))
            daemon.op_wmi = lambda name, args: psensed.Daemon.op_wmi(daemon, name, args)

            # Test kb.effect.set
            res = daemon.op_wmi("kb.effect.set", {
                "effect": "WAVE",
                "speed": 4,
                "brightness": 90,
                "direction": 2
            })
            self.assertEqual(res["status"], 0)
            self.assertTrue(res["effect"]["running"])
            self.assertEqual(res["effect"]["effect"], "WAVE")
            self.assertEqual(saved_states[-1]["op"], "kb.effect.set")

            # Test kb.effect.get
            res_get = daemon.op_wmi("kb.effect.get", {})
            self.assertEqual(res_get["status"], 0)
            self.assertTrue(res_get["effect"]["running"])
            self.assertEqual(res_get["effect"]["effect"], "WAVE")

            # Let frames generate and write to DummyWmi
            time.sleep(0.08)
            self.assertGreater(len(daemon.wmi.calls), 0)
            # Check GUID and mid 6
            guid, mid, inb, out_len = daemon.wmi.calls[-1]
            self.assertEqual(guid, "gaming")
            self.assertEqual(mid, 6)

            # Test kb.zone.set stops active dynamic effect
            res_zone = daemon.op_wmi("kb.zone.set", {"rgb": [255, 0, 0], "zones": "all"})
            self.assertFalse(daemon.lighting_engine.get_status()["running"])
            self.assertEqual(len(res_zone["applied"]), 4)

            # Test kb.restore restores dynamic effect
            # First set an effect again to save state
            daemon.op_wmi("kb.effect.set", {"effect": "BREATHING", "speed": 3, "color": [0, 200, 255]})
            daemon.lighting_engine.stop_effect()
            self.assertFalse(daemon.lighting_engine.get_status()["running"])

            res_restore = daemon.op_wmi("kb.restore", {})
            self.assertTrue(res_restore["restored"])
            self.assertTrue(daemon.lighting_engine.get_status()["running"])
            self.assertEqual(daemon.lighting_engine.get_status()["effect"], "BREATHING")

            # Test kb.effect.stop
            res_stop = daemon.op_wmi("kb.effect.stop", {})
            self.assertEqual(res_stop["status"], 0)
            self.assertFalse(daemon.lighting_engine.get_status()["running"])
        finally:
            psensed._save_lighting_state = orig_save
            psensed._load_lighting_state = orig_load


if __name__ == "__main__":
    unittest.main()

