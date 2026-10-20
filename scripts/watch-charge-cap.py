#!/usr/bin/env python3
"""Watch battery charging behavior and 80% charge cap on AC.

Logs timestamp, AC status, capacity %, status, voltage, current, and
the EC BatteryControl begb mode (0=Optimized, 1=Full) at regular intervals.
"""

import argparse
import datetime
import json
import os
import socket
import sys
import time

def read_sysfs(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None

def find_power_supply(type_name):
    base = "/sys/class/power_supply"
    if not os.path.exists(base):
        return None
    for n in sorted(os.listdir(base)):
        p = os.path.join(base, n)
        t = read_sysfs(os.path.join(p, "type"))
        if t == type_name:
            return p
    return None

def query_battmode(sock_path="/run/psense.sock"):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2.0)
            s.connect(sock_path)
            req = {"id": 1, "op": "battmode.get"}
            s.sendall(json.dumps(req).encode() + b"\n")
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(1024)
                if not chunk:
                    break
                buf += chunk
            res = json.loads(buf.decode())
            return res.get("value")
    except Exception:
        return None

def main():
    ap = argparse.ArgumentParser(description="Monitor battery charging and 80% cap")
    ap.add_argument("--interval", "-i", type=int, default=60, help="Interval in seconds (default: 60)")
    ap.add_argument("--output", "-o", default="analysis/charge-cap-log.tsv", help="Output TSV path")
    ap.add_argument("--once", action="store_true", help="Print single snapshot and exit")
    ap.add_argument("--socket", default="/run/psense.sock", help="psensed socket path")
    args = ap.parse_args()

    acad = find_power_supply("Mains")
    bat = find_power_supply("Battery")

    if not bat:
        print("Error: No battery found under /sys/class/power_supply", file=sys.stderr)
        return 1

    header = "timestamp\tac_online\tcapacity_pct\tstatus\tvoltage_mv\tcurrent_ma\tbattmode\n"
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    if not os.path.exists(args.output) and not args.once:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(header)

    while True:
        ts = datetime.datetime.now().isoformat(timespec="seconds")
        ac_online = read_sysfs(os.path.join(acad, "online")) if acad else "?"
        cap = read_sysfs(os.path.join(bat, "capacity")) or "?"
        stat = read_sysfs(os.path.join(bat, "status")) or "?"
        volt_u = read_sysfs(os.path.join(bat, "voltage_now"))
        curr_u = read_sysfs(os.path.join(bat, "current_now"))
        
        volt_mv = f"{int(volt_u) // 1000}" if volt_u and volt_u.isdigit() else "?"
        curr_ma = f"{int(curr_u) // 1000}" if curr_u and curr_u.isdigit() else "?"
        
        bmode_val = query_battmode(args.socket)
        bmode_str = {0: "Optimized(80%)", 1: "Full(100%)", 2: "Adaptive"}.get(bmode_val, str(bmode_val))

        line = f"{ts}\t{ac_online}\t{cap}\t{stat}\t{volt_mv}\t{curr_ma}\t{bmode_str}"
        print(line)

        if not args.once:
            with open(args.output, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            time.sleep(args.interval)
        else:
            break

    return 0

if __name__ == "__main__":
    sys.exit(main())
