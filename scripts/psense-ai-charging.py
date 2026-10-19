#!/usr/bin/env bash
# psense-ai-charging.py — AI Smart Battery Charging Daemon & Usage Predictor
# Spec: MUI_AISmartCharging_Tab, analysis/wmi-methods.md §13.25-§13.26
""":"
exec python3 "$0" "$@"
"""

import argparse
import datetime
import json
import os
import sys
import time

STATE_DIRS = [
    "/var/lib/predator-sense",
    "/run/predator-sense",
    os.path.expanduser("~/.local/share/predator-sense"),
]
SOCKET_PATH = "/run/psense.sock"

def daemon_call(op, args=None, timeout=5.0):
    import socket
    if not os.path.exists(SOCKET_PATH):
        return None
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(SOCKET_PATH)
        req = {"op": op}
        if args:
            req.update(args)
        s.sendall((json.dumps(req) + "\n").encode())
        res = s.recv(4096)
        s.close()
        return json.loads(res.decode())
    except Exception as e:
        return {"error": str(e)}

def get_history_file():
    for d in STATE_DIRS:
        f = os.path.join(d, "charge-history.json")
        if os.path.exists(f):
            return f
    # Return first writable or local
    for d in STATE_DIRS:
        try:
            os.makedirs(d, exist_ok=True)
            return os.path.join(d, "charge-history.json")
        except Exception:
            continue
    return os.path.expanduser("~/.local/share/predator-sense/charge-history.json")

def load_history():
    fpath = get_history_file()
    if os.path.exists(fpath):
        try:
            with open(fpath, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {"samples": [], "stats": {str(h): {"plugged": 0, "unplugged": 0} for h in range(24)}}

def save_history(h):
    fpath = get_history_file()
    try:
        os.makedirs(os.path.dirname(fpath), exist_ok=True)
        tmp = fpath + ".tmp"
        with open(tmp, "w") as f:
            json.dump(h, f)
        os.replace(tmp, fpath)
    except Exception as e:
        print(f"[ai-charging] failed to save history: {e}", file=sys.stderr)

def get_battery_info():
    ac_online = None
    capacity = None
    base = "/sys/class/power_supply"
    if os.path.exists(base):
        for entry in os.listdir(base):
            p = os.path.join(base, entry)
            # check AC / Mains
            online_f = os.path.join(p, "online")
            type_f = os.path.join(p, "type")
            if os.path.exists(online_f):
                try:
                    ac_online = int(open(online_f).read().strip()) == 1
                except Exception:
                    pass
            # check Battery capacity
            cap_f = os.path.join(p, "capacity")
            if os.path.exists(cap_f):
                try:
                    capacity = int(open(cap_f).read().strip())
                except Exception:
                    pass
    return ac_online, capacity

def analyze_and_act(history):
    now = datetime.datetime.now()
    hour = str(now.hour)
    ac_on, cap = get_battery_info()
    if ac_on is None:
        return

    # Update hourly statistics
    stat = history["stats"].setdefault(hour, {"plugged": 0, "unplugged": 0})
    if ac_on:
        stat["plugged"] += 1
    else:
        stat["unplugged"] += 1

    # Keep a sliding log of recent 500 samples
    history["samples"].append({
        "t": int(time.time()),
        "hour": now.hour,
        "ac": ac_on,
        "cap": cap
    })
    if len(history["samples"]) > 500:
        history["samples"] = history["samples"][-500:]

    save_history(history)

    # Predictive analysis: Check probability of being unplugged in the next 2 hours
    next_hour_1 = str((now.hour + 1) % 24)
    next_hour_2 = str((now.hour + 2) % 24)
    s1 = history["stats"].get(next_hour_1, {"plugged": 0, "unplugged": 0})
    s2 = history["stats"].get(next_hour_2, {"plugged": 0, "unplugged": 0})

    tot_upcoming = s1["plugged"] + s1["unplugged"] + s2["plugged"] + s2["unplugged"]
    unplug_upcoming = s1["unplugged"] + s2["unplugged"]

    unplug_prob = (unplug_upcoming / tot_upcoming) if tot_upcoming >= 10 else 0.0

    print(f"[{now.strftime('%H:%M:%S')}] AC: {ac_on}, Cap: {cap}%, Next 2h unplug prob: {unplug_prob:.1%}")

    # If unplugging is imminent (prob > 60%), lift cap to 100% (battmode 1).
    # Otherwise, maintain healthy 80% cap (battmode 0).
    target_mode = 1 if unplug_prob > 0.60 else 0

    cur_mode = daemon_call("battmode.get")
    if cur_mode and cur_mode.get("status") == 0:
        val = cur_mode.get("value")
        if val != target_mode:
            print(f"[ai-charging] Adaptive switch: changing battmode {val} -> {target_mode}")
            daemon_call("battmode.set", {"value": target_mode})

def main():
    p = argparse.ArgumentParser(description="PredatorSense AI Smart Battery Charging")
    p.add_argument("--status", action="store_true", help="Print current predictive model status")
    p.add_argument("--daemon", action="store_true", help="Run continuous 60s background observation loop")
    p.add_argument("--once", action="store_true", help="Sample once and exit")
    args = p.parse_args()

    h = load_history()

    if args.status:
        ac, cap = get_battery_info()
        cur = daemon_call("battmode.get")
        val = cur.get("value") if cur else "unknown"
        mode_str = "Optimized (80% Cap)" if val == 0 else "Full (100% Cap)" if val == 1 else str(val)
        print("=== PredatorSense AI Smart Battery Charging ===")
        print(f"AC Status:        {'Connected' if ac else 'Battery'}")
        print(f"Battery Charge:   {cap}%")
        print(f"Active Mode:      {mode_str}")
        print(f"History Samples:  {len(h.get('samples', []))}")
        print("Hourly Unplug Probabilities:")
        for hr in range(24):
            st = h["stats"].get(str(hr), {"plugged": 0, "unplugged": 0})
            tot = st["plugged"] + st["unplugged"]
            pct = (st["unplugged"] / tot * 100) if tot > 0 else 0.0
            print(f"  {hr:02d}:00 -> {pct:4.1f}% mobile ({tot} samples)")
        return

    if args.once:
        analyze_and_act(h)
        return

    print("[ai-charging] Starting background AI charging daemon...")
    while True:
        try:
            analyze_and_act(h)
        except Exception as e:
            print(f"[ai-charging] error: {e}", file=sys.stderr)
        time.sleep(60)

if __name__ == "__main__":
    main()
