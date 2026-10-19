"""Native Dynamic Lighting Engine for psensed (daemon).

Computes 4-zone RGB animation frames (WAVE, BREATHING, SHIFTING, METEOR, TWINKLING)
in a lightweight daemon thread and passes them to a sink callback to drive WMI zone writes.
"""

import math
import random
import threading
import time


def clamp(val, low, high):
    return max(low, min(high, val))


def hsv_to_rgb(h, s, v):
    """Convert HSV (h in 0..360, s in 0..1, v in 0..1) to RGB tuple (0..255)."""
    h = ((h % 360) + 360) % 360
    s = clamp(s, 0.0, 1.0)
    v = clamp(v, 0.0, 1.0)
    c = v * s
    x = c * (1.0 - abs(((h / 60.0) % 2) - 1.0))
    m = v - c

    if h < 60:
        r1, g1, b1 = c, x, 0.0
    elif h < 120:
        r1, g1, b1 = x, c, 0.0
    elif h < 180:
        r1, g1, b1 = 0.0, c, x
    elif h < 240:
        r1, g1, b1 = 0.0, x, c
    elif h < 300:
        r1, g1, b1 = x, 0.0, c
    else:
        r1, g1, b1 = c, 0.0, x

    return (
        round((r1 + m) * 255),
        round((g1 + m) * 255),
        round((b1 + m) * 255),
    )


def rgb_to_hsv(r, g, b):
    """Convert RGB (0..255) to HSV tuple (h in 0..360, s in 0..1, v in 0..1)."""
    r_f = clamp(r, 0, 255) / 255.0
    g_f = clamp(g, 0, 255) / 255.0
    b_f = clamp(b, 0, 255) / 255.0

    mx = max(r_f, g_f, b_f)
    mn = min(r_f, g_f, b_f)
    d = mx - mn

    h = 0.0
    s = 0.0 if mx == 0.0 else d / mx
    v = mx

    if d != 0.0:
        if mx == r_f:
            h = ((g_f - b_f) / d + (6.0 if g_f < b_f else 0.0)) * 60.0
        elif mx == g_f:
            h = ((b_f - r_f) / d + 2.0) * 60.0
        else:
            h = ((r_f - g_f) / d + 4.0) * 60.0

    return (h, s, v)


def clamp_rgb(rgb):
    """Clamp RGB sequence to list of 3 ints in [0, 255]."""
    if not rgb or len(rgb) < 3:
        return (0, 174, 199)
    return (
        clamp(int(round(rgb[0])), 0, 255),
        clamp(int(round(rgb[1])), 0, 255),
        clamp(int(round(rgb[2])), 0, 255),
    )


def scale_rgb(rgb, factor):
    """Scale an RGB tuple by a float factor."""
    f = max(0.0, factor)
    return (
        clamp(round(rgb[0] * f), 0, 255),
        clamp(round(rgb[1] * f), 0, 255),
        clamp(round(rgb[2] * f), 0, 255),
    )


def lerp_color(c1, c2, t):
    """Linearly interpolate between color c1 and c2 by factor t in [0..1]."""
    t = clamp(t, 0.0, 1.0)
    return (
        round(c1[0] + (c2[0] - c1[0]) * t),
        round(c1[1] + (c2[1] - c1[1]) * t),
        round(c1[2] + (c2[2] - c1[2]) * t),
    )


class DaemonLightingEngine:
    """Computes dynamic keyboard lighting animations in psensed."""

    def __init__(self, frame_sink=None):
        self.frame_sink = frame_sink
        self.running = False
        self.session_id = 0
        self.lock = threading.Lock()
        self.thread = None
        self.current_config = {
            "effect": None,
            "speed": 3,
            "brightness": 100,
            "direction": 1,
            "color": (0, 174, 199),
            "zone_count": 4,
        }

    def start_effect(self, effect, speed=3, brightness=100, direction=1, color=(0, 174, 199), zone_count=4):
        """Start or reconfigure an animation effect."""
        eff_upper = str(effect or "").upper()
        if eff_upper not in ("BREATHING", "WAVE", "SHIFTING", "METEOR", "TWINKLING"):
            raise ValueError(f"Unknown effect: {effect}")

        spd = clamp(int(speed or 3), 1, 9)
        bri = clamp(int(brightness if brightness is not None else 100), 0, 100)
        dir_val = 2 if int(direction or 1) == 2 else 1
        clr = clamp_rgb(color)
        zcount = clamp(int(zone_count or 4), 1, 4)

        with self.lock:
            self.session_id += 1
            cur_session = self.session_id
            self.running = True
            self.current_config = {
                "effect": eff_upper,
                "speed": spd,
                "brightness": bri,
                "direction": dir_val,
                "color": clr,
                "zone_count": zcount,
            }

            # Start animation thread
            self.thread = threading.Thread(
                target=self._loop,
                args=(cur_session, eff_upper, spd, bri, dir_val, clr, zcount),
                name=f"psensed-lighting-{eff_upper.lower()}",
                daemon=True,
            )
            self.thread.start()

    def stop_effect(self):
        """Stop any active animation."""
        with self.lock:
            self.running = False
            self.session_id += 1
            self.current_config["effect"] = None

    def get_status(self):
        """Return the current engine status dictionary."""
        with self.lock:
            return {
                "running": self.running and self.current_config["effect"] is not None,
                "effect": self.current_config["effect"],
                "speed": self.current_config["speed"],
                "brightness": self.current_config["brightness"],
                "direction": self.current_config["direction"],
                "color": self.current_config["color"],
                "zone_count": self.current_config["zone_count"],
            }

    def _loop(self, session_id, effect, speed, brightness, direction, color, zone_count):
        """Main animation loop running on background thread at ~25-28 FPS (~35-40ms)."""
        bri_scale = brightness / 100.0
        last_time = time.monotonic()

        # State variables for effects
        phase = 0.0
        base_hue = 0.0
        meteor_pos = float(zone_count) if direction == 2 else -1.0
        glints = [0.0] * zone_count

        user_hue, user_sat, _ = rgb_to_hsv(*color)
        shift_sat = 0.9 if user_sat < 0.1 else user_sat

        while True:
            with self.lock:
                if not self.running or self.session_id != session_id:
                    break

            now = time.monotonic()
            dt = max(0.001, now - last_time)
            last_time = now

            zones = []

            if effect == "BREATHING":
                freq = 0.8 + (speed - 1) * 0.4
                phase += dt * freq * math.pi
                factor = 0.2 + 0.8 * (0.5 * (1.0 + math.sin(phase)))
                c = scale_rgb(color, factor * bri_scale)
                zones = [c] * zone_count

            elif effect == "WAVE":
                hue_speed = 45.0 + speed * 25.0  # deg/sec
                step = (-1.0 if direction == 2 else 1.0) * hue_speed * dt
                base_hue = (base_hue + step) % 360.0
                for i in range(zone_count):
                    offset = (-i if direction == 2 else i) * (60.0 if zone_count > 1 else 0.0)
                    hue = (base_hue + offset) % 360.0
                    zones.append(hsv_to_rgb(hue, 1.0, bri_scale))

            elif effect == "SHIFTING":
                shift_speed = 25.0 + speed * 20.0  # deg/sec
                step = (-1.0 if direction == 2 else 1.0) * shift_speed * dt
                phase = (phase + step) % 360.0
                for i in range(zone_count):
                    zone_offset = (-i if direction == 2 else i) * (35.0 if zone_count > 1 else 0.0)
                    h = (user_hue + phase + zone_offset) % 360.0
                    zones.append(hsv_to_rgb(h, shift_sat, bri_scale))

            elif effect == "METEOR":
                meteor_speed = 1.6 + speed * 0.9  # zones/sec
                if direction == 2:
                    meteor_pos -= meteor_speed * dt
                    if meteor_pos < -2.0:
                        meteor_pos = float(zone_count)
                else:
                    meteor_pos += meteor_speed * dt
                    if meteor_pos > zone_count + 1.0:
                        meteor_pos = -1.0

                ambient = 0.08
                for i in range(zone_count):
                    dist = (i - meteor_pos) if direction == 2 else (meteor_pos - i)
                    trail = 0.0
                    if 0.0 <= dist < 2.5:
                        trail = math.exp(-dist * 1.6)
                    elif -0.5 < dist < 0.0:
                        trail = (1.0 + dist / 0.5) * 0.25
                    intensity = min(1.0, ambient + trail * (1.0 - ambient))
                    zones.append(scale_rgb(color, intensity * bri_scale))

            elif effect == "TWINKLING":
                ambient = 0.18
                decay_rate = 1.2 + speed * 0.3
                spawn_prob = 0.04 + speed * 0.02
                for i in range(zone_count):
                    if glints[i] > 0.0:
                        glints[i] = max(0.0, glints[i] - dt * decay_rate)
                    elif random.random() < spawn_prob:
                        glints[i] = 1.0

                for i in range(zone_count):
                    intensity = ambient + (1.0 - ambient) * glints[i]
                    c = scale_rgb(color, intensity * bri_scale)
                    if glints[i] > 0.4:
                        white_blend = ((glints[i] - 0.4) / 0.6) * 0.5
                        c = lerp_color(c, (255, 255, 255), white_blend)
                    zones.append(c)

            # Pass calculated zones to frame_sink
            if self.frame_sink and zones:
                try:
                    self.frame_sink(zones)
                except Exception:
                    pass

            elapsed = time.monotonic() - now
            target_interval = 0.038  # ~26 FPS (~38 ms)
            delay = max(0.005, target_interval - elapsed)
            time.sleep(delay)
