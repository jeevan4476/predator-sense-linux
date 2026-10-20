# psensed Socket Protocol — Technical Specification

Version: 1.0-draft (R0) · 2026-10-20 · branch `docs/daemon-protocol`
Sources of truth: `src/psensed` (daemon, all line refs), `src/psense` (CLI client),
`src/psense-electron/backend.js` (GUI client). Extraction cross-checked: every op
referenced by both clients resolves to a daemon handler; reverse unknowns flagged
in §11.

This document is NORMATIVE for the Rust port (`src/psensed-rs`, per plan
`run/plans/2026-10-20-implementation-plan.md`) and for the TS retype of
`backend.js`. It specifies the behavior of the CURRENT python daemon — quirks
included — except where §11 explicitly marks a behavior as an erratum pending a
deliberate fix. Rust R1 parity is defined against THIS text.

Conventions: "MUST/MUST NOT/SHOULD/MAY" per RFC 2119 spirit. All JSON is UTF-8.
 "->" marks response builders.

## 1. Transport

| # | Rule |
|---|------|
| T1 | Socket path `/run/psense.sock`. Server override: `psensed` flag `--socket` only. Clients: no env override (CLI `--sock` flag per subcommand; backend.js hardcoded). |
| T2 | Socket file mode `0660`, owner root, group `wheel` (chown best-effort; on refresh/fallback chmod 0660 regardless). (psensed 296–301) |
| T3 | One request per connection: client connects, sends exactly ONE JSON object terminated by `\n`, reads exactly ONE reply (also newline-terminated), then either side may close. No keepalive, no pipelining, no request ids. (psensed 1462–1488; psense 245–259; backend.js 95–109) |
| T4 | Daemon reads in a loop of 4096-B chunks until buffer ends with `\n` OR EOF OR buffer exceeds **65536 bytes**; a truncated buffer decodes as-is and fails into the bad-request path (no partial-limit rejection). Per-recv timeout 3 s. (psensed 1460–1469) |
| T5 | Daemon replies with `sendall(json.dumps(reply) + "\n")` — a single write. Nothing is streamed; oversized responses are always complete. (psensed 1480) |
| T6 | Empty/whitespace-only request: connection closed, NO reply. (psensed 1470) |
| T7 | Delegated ops: reply is HELD (connection kept open) until the worker completes; the eventual reply is `sendall`-ed on the same socket by the completion path, which then closes. (psensed 1475–1478, 452–469) |

## 2. Request schema

- One flat JSON object; `op` names the operation; every OTHER top-level key is an
  argument passed as a dict to the handler (`psensed 1500–1516`). ARGS ARE
  SIBLING KEYS of `op`, never nested.
- Unknown/extra keys are ignored everywhere (handlers read only known keys).
- Non-dict top level (array/number/string) -> bad-request error (§2.1).
- String op names are exact: routing keys off `str(req.get("op",""))`.

## 2.1 Universal failure behavior

- Malformed JSON, non-UTF8, non-object top level, or ANY handler exception -> the
  connection receives `{"error": "bad request: <repr>"}` and the daemon keeps
  serving. (psensed 1471–1474)
- Anything the daemon cannot route -> `{"error": "unknown op <quoted>"}`.
  (psensed 1516)
- Client contract: presence of key `error` (any value) = failure. This key test
  is THE portable success discriminator; per-op success payloads below only ever
  ADD information. (psense 85/130/158…; backend.js error checks)

## 3. Response conventions (non-uniform by design)

- WMI-class ops carry `status` (ioctl return; 0 = ok) alongside payload fields.
- Ack-style ops (fan.mode/speed/reset, curves) report `applied`/`registered` and
  carry no `status`.
- Errors are flat `{"error": str}`; SOME errors add sidecar keys (`choices`,
  `detail`, full `status`) — clients MUST treat extra keys as advisory.
- THE STRING PREFIX `"wmi busy:"` IS A CONTRACT: GUI clients retry on it
  (`/^wmi busy:/i`, sleep 250 ms; backend.js 110–118). Rust MUST preserve the
  prefix byte-for-byte. Full current string:
  `"wmi busy: another eval is running (or pending); retry shortly — reads are unaffected"`
  (psensed 446–448)
- `"wmi eval wedged >25s..."` payload: `{"error": "wmi eval wedged >25s; op still running in kernel — check dmesg and /proc/$(cat /run/psensed.pid)/stack"}` (psensed 456–458). The `>25s` text embeds the 25.0 constant MUST match `WMI_TIMEOUT_S`.

## 4. Dispatch model

Routing (psensed 1500–1516), in order:

| match | handler class | queued? |
|---|---|---|
| `sensors \| info \| sysinfo \| fan.get \| fan.reset \| fan.mode \| fan.speed` | `_misc` | no |
| `profile.* \| switchkey.* \| gpu.oc.*` | `op_profile` | no |
| `memory` / `sysinfo` / `health` | op_memory / op_sysinfo / op_health | no |
| `fan.curve.*` | op_fan | no |
| `wmi.raw` OR `kb.*` OR `fan.w*` OR `battmode.*` OR `usbcharge.*` | `_delegate_wmi` -> single worker | YES |
| anything else | unknown-op error | — |

Note: `fan.w*` prefix means fan.wmodes/fan.wmode/fan.wspeed/fan.wget/fan.wtable.
`battmode.get`/`usbcharge.*` are read-side WMI evals and ARE queued (they still
cost an SMM eval). Unqueued ops never return `wmi busy`.

## 5. Queueing + spacing (the heart of the system)

Q1. ONE worker thread serializes ALL WMI-class ops; at most ONE delegated
    request may exist at a time (running OR pending). A second WMI-class op
    arriving while one exists is refused IMMEDIATELY with the `wmi busy` error
    (§3) — clients retry on their own. (psensed 444–450)
Q2. Boot-time self-traffic: `kb.restore` is enqueued at startup (psensed 339) —
    a client racing it may see one `wmi busy`.
Q3. Spacing constants (psensed 75–88):

| constant | value | meaning |
|---|---|---|
| CACHE_S | 2.0 s | sensor read cache TTL |
| WRITE_GAP | 0.03 s | consecutive `gaming` mid-6 evals (zone writes); also 30 ms sleeps between multi-zone writes and between pwm_enable/pwm writes |
| EVAL_GAP | 0.20 s | minimum gap BETWEEN all other evals |
| FAMILY_GAP | 0.5 s | ANY switch between GUID families forces >=500 ms regardless of EVAL_GAP |
| TICK_S | 2.0 s | curve scheduler tick |
| WMI_TIMEOUT_S | 25.0 s | held-request watchdog (§3 wedged reply) |
| HYSTERESIS_PCT | 2 | curve re-write deadband |

Q4. Spacing algorithm (psensed 200–211): `wait = target_gap - (now - last_eval_t)`
    where the target gap is WRITE_GAP for back-to-back gaming/mid-6, otherwise
    EVAL_GAP; if the GUID family CHANGED since the previous eval, wait becomes
    `max(wait, FAMILY_GAP)`; positive wait sleeps. The 30 ms kernel-side pacing
    is additionally enforced by /dev/psense-wmi itself (psensed 139–141).
Q5. Late results with no waiting client are dropped silently except boot-restore
    results. (psensed 452–469)
Q6. ERRATUM (doc drift): `spec/protocol.md` claims ">=250 ms" — the CODE enforces
    0.20 s (measured-safe retune, comment psensed 78–81). The SPEC text to keep
    is 200 ms. Fix pending: reconcile protocol.md.

## 6. Keyboard lighting protocol semantics (the 16-B controller-DLL frame)

F1. Frame builder (psensed 120–135) — method 20, `in` buffer:

    byte 0        mode      (0..255; 0 = STATIC/DIRECT)
    byte 1        speed     (0..255)
    byte 2        brightness(0..255)
    byte 3        direction + 1   (clamped only by callers' masking: kb.set
                                 masks dir &= 0xF first, psensed 655; so dir
                                 0xFF -> byte 0x00 via wraparound)
    bytes 4..6    R, G, B   (each clamped 0..255 at build time)
    byte 7        0x00      (reserved)
    byte 8        0x03      (on-flag)
    byte 9        device    (kb.set arg `device`, default 1)
    bytes 10..15  0x00      (reserved)
The OLD layout ([3]=0, [4]=dir, RGB@[5..7]) is FORBIDDEN — it produced the
historic animated-mode backlight drop (code comment psensed 118–131). `wmi.raw`
users MUST NOT emit method-20 with the legacy layout.

F2. Readback — method 21 (`kb.get`, psensed 551–569), in `u32LE(1)`; slot map
    (live-calibrated 2026-10-19):
    [0]=gate · [1]=mode · [2]=speed · [3]=brightness · [4]=direction ·
    [5..7]=frame RGB echo · [6..8]=zone-store RGB (overlapping window; visible
    zone color right after id-6 writes) · [9]=0x03 flag.
    `kb.get` fields: status, raw(hex) + when >=10 B: mode, speed, brightness,
    dir, frame_rgb[3], rgb[3], flag9.
    ERRATUM: protocol.md §6.1 documents the superseded legend — ignore it.

F3. Effect names (kb.effect.set `effect`, psensed 497–520; also file CLI 361–405):
    upper-cased; aliases RAINBOW->WAVE and NEON->SHIFTING applied BEFORE routing.
    EC-NATIVE (one frame write, zero steady-state CPU, no further traffic):
      BREATHING=1, SHIFTING=4, METEOR=6, TWINKLING=7
    SOFTWARE ENGINE (daemon animates in userspace; see F6):
      WAVE (hence RAINBOW), and any upper-case name not in the EC table that the
      software engine recognizes: {BREATHING, WAVE, SHIFTING, METEOR, TWINKLING}
      — net effect: SCREEN/MUSIC and unknown names -> {"error": "Unknown effect: NAME"}.
F4. Zone writes (method 6): in = u64 LE [mask, R, G, B]; mask bits = zone-1..4 ->
    1,2,4,8 ("zones:" "all"=0xF | "1234"/"1,2,3,4" string | int list 1..4 |
    int bitmask accepted as-is). (psensed 607–646)
F5. Mode-0 semantics: `kb.effect.stop` ALWAYS force-writes the static frame
    `_kb_frame(0,0,last_bri,0,(0,0,0))` because EC frame registers survive daemon
    restarts (psensed 471–484, 593–600). `kb.zone.set` triggers an UNforced
    static write only when the EC effect or software engine is known-active.
    `kb.set`/`kb.effect.set`/stop clear the zone palette cache.
F6. Software engine pacing: ~26 FPS tick; per-frame zone writes through the
    SAME method-6 path with in-daemon dedupe against the last applied palette.
    The GUI-side engine (SCREEN/MUSIC) streams `kb.zone.set` at ~22 FPS with
    client-side zone diffing (lighting-engine.js 110–135; target interval 45 ms).
F7. Speed divergence wart (documented, do not silently change): EC-native path
    forwards `speed` verbatim into frame byte 1 (no 1..9 clamp); the software
    engine clamps 1..9. CLI pre-validates 1..9 either way. (psensed 504 vs lighting 130)
F8. Persistence: every successful kb.* write saves
    `{"op": "<kb.effect.set|kb.effect.stop|kb.zone.set|kb.set>", "args": {...}}`
    atomically: temp file + os.replace, first of
    `/var/lib/predator-sense/lighting.json` then `/run/predator-sense/lighting.json`.
    (psensed 90–117) Restore (`kb.restore`, also boot-enqueued) re-issues the
    saved op. Zone colors live ONLY in the EC + in-memory cache (not persisted).

## 7. OP REFERENCE

Arg columns: `req` = daemon rejects if absent; `opt` = default shown. All args
read with `.get` — unknown keys ignored. Types are enforced only where a handler
explicitly validates; ints MUST be JSON numbers (not strings) where noted.

### 7.1 Unqueued (answered synchronously)

sensors (no args) :: cache 2 s -> -> {fans_rpm:{cpu,gpu:str|null}, temps:{<tempN_input>:str}, stale:bool, fresh:bool}
info (no args) :: -> -> {daemon, acer_hwmon, platform_profile, pwm_available, wmi_dev, socket, curves, product_name, board_name, sys_vendor, bios_version, bios_date}
sysinfo (no args) :: 30 s cache, root DMI -> full snapshot {serial, uuid, ram, storage[], battery[], devices[], network{...}, ...}; per-section failures swallowed (paths stay absent)
fan.get (no args) :: -> -> {rpm_cpu, rpm_gpu, pwm_available, curves, fan1:{pwm,mode,rpm}, fan2:{...}}
fan.reset :: args: fan opt ("cpu"|"gpu"|"both") [ERRATUM E1: currently IGNORED — always resets BOTH fans] -> -> {applied:{fanN:"auto"}[, note]}
fan.mode :: args: mode req in {auto,turbo,custom} (EC mapping turbo=0,custom=1,auto=2), fan opt both -> -> {applied:{fanN:mode}[, note]}
fan.speed :: args: pct req int 0..100, fan opt -> -> {applied:{fanN:pct}[, note]}
   Errors (fan. sysfs class): {"error":"pwm nodes not available — unlock with rules/m1-fan-test.sh (force_caps)"}; {"error":"mode must be one of [..]"}; {"error":"pct required (0-100)"}; {"error":"pct must be 0-100"}
profile.get :: -> -> {profile:str, choices:[str]}
profile.set :: args: name req (alias `choice` also read); MUST be in sysfs choices -> writes profile then applies GPU-OC ride-along -> -> {profile, gpu_oc:{...}} ; errors: platform-profile not found / invalid choice {val!r}+choices / write failed
switchkey.get :: -> -> {mode:0|1} (0 = key cycles thermal profile)
switchkey.set :: args: mode opt int default 0 -> -> {status:0|-1, mode} (sysfs module-param write; -1 = failed, no "error" field!)
gpu.oc.get :: -> -> {supported, model, gpu_id, mode, core_offset_mhz, mem_offset_mhz, applied, error}
gpu.oc.set :: args: core opt int 0, mem opt int 0; non-int -> {"error":"core and mem offsets must be integers"} -> status dict (unsupported platform -> applied:false + error field)
memory :: -> -> {dimms, total_mb, type, frequency, speed_max} ; DMI read fail -> {"error":"dmi read failed: ..."}
health :: -> -> {battery:{battery_health:0|1|-1, battery_full_raw, battery_design_raw, battery_capacity_ratio_pct, battery_cycle_count, battery_status},
                  disks:[{dev, model, index, media, media_name, total_mb, health, smart_status}], ram:{health:-1}}
   ratio >= 80 % -> 0 else 1; runs `smartctl -H` per disk (subprocess; failures encoded -1/empty)
fan.curve.set :: args: fan req cpu|gpu; points req (list of [temp,pct] pairs OR "t:pct t:pct" string), >=2 points, temp<=120, pct<=100 -> -> {registered:{fanN:sorted_points}} (also triggers immediate tick); errors: fan/points/provide >=2/invalid point
fan.curve.get :: -> -> {curves:{fanN:points}}
fan.curve.clear :: args: fan req cpu|gpu -> -> {cleared:"fanN", ...auto-reset result}; errors: {"error":"no curve for fan <idx>"} [E2: unknown fan prints "None"]

### 7.2 Queued (single-slot WMI worker; may reply `wmi busy`; 20 s client timeouts)

wmi.raw :: args: guid opt gaming|apge|battery|generic, mid opt int (NON-int -> {"error":"mid must be an int"}), in opt hex (bad -> {"error":"in must be a hex string"}), out_len opt 64 capped 4096
   -> -> {status, out:hex, out_used, u64:[LE u64 words of out]}
   Missing module -> {"error":"psense-wmi module unavailable: <oserror>"}
kb.get :: (no args; method 21) -> see F2 fields.
kb.effect.set :: args: effect req (else {"error":"effect is required (BREATHING, WAVE, SHIFTING, METEOR, TWINKLING)"}),
   speed opt 3 [F7], brightness opt 100, direction opt 1, rgb|color opt [0,174,199] (non-3x int list -> {"error":"rgb/color must be [r,g,b] ints"}),
   zone_count opt 4 (GUI also sends zoneCount — ignored; keep zone_count as the canonical key)
   EC-native -> -> {status, effect:{status, ack:hex, frame:hex, engine:"ec-native", effect, mode, speed, brightness, direction, rgb}}
   software -> -> {status, effect:{engine:"software", ...engine status}}
kb.effect.stop :: -> -> {status:0, stopped:true} (force static write; ERRATUM E3: not idempotent-safe against EC — always writes)
kb.effect.get :: -> -> {status:0, effect:{...}} (EC effect dict or engine status)
kb.zone.set :: args: rgb opt [0,0,0] (bad -> {"error":"rgb must be [r,g,b] ints"}), zones opt "all" (bad -> {"error":"zones: list of 1..4 or 'all'"})
   -> per-changed-zone method-6 evals (30 ms apart): -> {zones:[names...], applied:[{zone_bit,status}...]}
   unchanged palette -> {zones:[...], applied:[], skipped:"palette unchanged"} (dedupe is part of the contract: repeated identical palettes MUST NOT generate evals)
kb.set :: args: mode opt 0, speed opt 0, brightness opt 100, dir opt 0 (masked &0xF), device opt 1, rgb opt [0,0,0]
   mode/speed/brightness/dir/device non-int -> {"error":"mode/speed/brightness/dir/device must be ints"}; rgb bad -> rgb error
   mode in {0, 0xFF} forces speed=0. -> -> {status, ack:hex, frame:hex(16-B, F1)}
kb.restore :: (no args; uses persisted state, §F8) -> -> {status:0, restored:false, reason:"no saved state"} | {status:0, restored:true, op:..., effect|detail:...} | {status:-1, restored:false, op, error} 
fan.wmodes :: args: fan opt both (cpu|gpu|both) -> method-15 read -> {status, raw, cpu_mode, gpu_mode} (data[1]&0b11 / >>6&0b11)
fan.wmode :: args: fan opt both, mode req auto|turbo|custom -> read+write method-14 -> {status, ack:hex, applied:{cpu,gpu}}; bad enum -> {"error":"fan ∈ [..], mode ∈ [..]"}
fan.wspeed :: args: fan opt cpu (cpu|gpu|both), pct req int 0..100 -> forces CUSTOM first (in-queue) then per-fan method-16 fid|(pct<<8) -> {switched:{...}, cpu_speed:{pct,status,ack}, gpu_speed:{...}}; CUSTOM failure -> {"error":"fan.wmode CUSTOM failed","detail":{...}}
fan.wget :: args: fan opt cpu (cpu|gpu ONLY) -> method-17 -> {status, raw, [+ pct]}
fan.wtable :: (no args) -> method-19 empty input -> {status, raw, word}
battmode.get :: (no args) -> battery method-20 in=00 01 00 00 (u8[4] 1,1,0,0) -> {status, raw, function_list?, function_status[5]?, optimized?, value:0|1?}
battmode.set :: args: value req int 0|1|2 (else {"error":"value must be 0 (optimized), 1 (full) or 2 (adaptive)"}) -> TWO method-21 writes (u8[8]: 1,mask,flag,0...) plus id-20 verify read ->
   {disable_adaptive|disable_optimized|optimized|adaptive sub-results..., status:0 [NOTE: forced — even when sub-writes fail; ground truth = committed], reported:{mode_now}?, committed:bool?}
   NOTE (contract): top-level status is forced 0 even when sub-writes fail; ground truth = `committed` (CLI exit codes currently ignore it — E4).
usbcharge.get :: (no args) -> apge id-2 in=u32LE(0x04) -> {status, raw, wmi_return?, switch_byte?, enabled?(=0x0F), threshold?}; data[0]!=0 overwrites status
usbcharge.set :: args: enabled opt bool, threshold opt int {10,20,30} (accepts "20%" style; else {"error":"threshold must be 10, 20, or 30"})
   pre-read must succeed -> write apge id-1 u64LE(0x04 | switch<<8 | threshold<<16), switch=0x0F enabled / 0x1F disabled -> {status, raw, requested, reported?, committed?}
   pre-read failure -> {"error":"usbcharge.get pre-read failed","status":...,"raw":...}

## 8. Polld cadence contracts (clients; protocol-relevant behavior)

| client timer | cadence | ops |
|---|---|---|
| backend pump | 1000 ms, re-entrancy guarded | sensors, fan.get, profile.get (+ CPU/GPU/net computed client-side) |
| memory lookup cache | 60 s client TTL | memory |
| sysinfo (agent wedge) | 30 s timer + 30 s daemon cache | sysinfo |
| health dialogs | 10 s client TTL | health |
| boot lighting self-heal | +5000 ms | kb.effect.set/session replay via persisted state |
| GUI SCREEN/MUSIC engine | ~22 fps, zone-diffed | kb.zone.set |
| usbcharge coalesce | 1 s TTL in-process dedupe, 15 s timeout | usbcharge.get |

Rust daemon note: cadence CONTRACTS may be tuned by clients; daemon-side MUST
haves are the caches (2 s sensors / 30 s sysinfo) and the spacing model (§5).

## 9. Access / identity gates

- Socket access gate = file permissions only (0660 root:wheel). The kernel
  module requires CAP_SYS_ADMIN for the ioctl itself; the daemon runs as root.
  Rust hardening (planned): optional SO_PEERCRED peer check, message-size cap
  (already 64 KiB via T4), bad-request rate cap — additive, MUST NOT change the
  reply format.
- The daemon is stateless across restarts EXCEPT the two-path lighting state
  file (§F8) which drives boot re-apply.

## 10. Protocol examples (wire-exact)

Request: {"op": "kb.effect.set", "effect": "breathing", "speed": 3, "brightness": 100, "direction": 1, "rgb": [199, 46, 20], "zone_count": 4}\n
Reply  : {"status": 0, "effect": {"status": 0, "ack": "...", "frame": "01036402c72e1400030100000000000000", "engine": "ec-native", "effect": "BREATHING", "mode": 1, "speed": 3, "brightness": 100, "direction": 1, "rgb": [199, 46, 20]}}\n
Request: {"op": "sensors"}\n -> {"fans_rpm": {"cpu": "3456", "gpu": "0"}, "temps": {"temp1_input": "52"}, "stale": false, "fresh": true}\n
Busy   : {"error": "wmi busy: another eval is running (or pending); retry shortly — reads are unaffected"}\n
Bad    : {"op": "printer.print"}\n -> {"error": "unknown op 'printer.print'"}\n

## 11. ERRATA / known deviations (current-code facts; fix on branches, not silently)

E1  fan.reset ignores its `fan` arg (positional-arg bug, psensed 955–956 vs
    _fan_write signature 1371) — documents as "always both" until fixed.
E2  fan.curve.clear unknown fan -> "no curve for fan None" (psensed 1439–1441).
E3  re module never imported in psensed; the lspci display-scan block of sysinfo
    silently no-ops on NameError (psensed 1264/1274).
E4  CLI exit-code gaps: battmode.set committed:false exits 0; curve cmds exit 0
    on transport failure; switchkey.get crashes on daemon-down (None guard).
E5  spec/protocol.md drift: EVAL_GAP 250 ms claim vs 0.20 s code; superseded
    frame/readback layout in §6.1; docstring "get" op typo (psensed L26);
    unreachable op_system alias (996); duplicate sysinfo branch (1509).
E6  backend.js: tray calls backend.daemonCall which is NOT exported
    (main.js 1146 / backend.js 2072–2077) — tray profile/fan/restore actions
    can never reach the socket; GUI-side bug.
E7  dual arg name: kb.effect.set zoneCount (GUI) vs zone_count (canonical).
E8  daemon ops with NO client: info, kb.get (GUI does not poll it), kb.effect.get,
    fan.mode, fan.wmodes/wget/wtable, fan.curve.*, gpu.oc.* (GUI-managed via psense-gui
    client only), wmi.raw — spec still required for rust parity.

## 12. Versioning policy

1. Additive keys/ops: allowed without version bump; clients MUST ignore unknown keys.
2. Changing/removing any documented key, error STRING (esp. "wmi busy:" prefix,
   "wmi eval wedged" text), or enum value: REQUIRES a major protocol bump +
   coordinated client updates.
3. Rust parity rule: reply JSON sets MUST match supersets-compatible-or-better —
   golden A/B harness replays recorded request vectors against both daemons and
   diffs decoded replies EXCEPT: key order (irrelevant), float formatting,
   and keys explicitly marked ADDITIVE in R-crates.
4. The R1 byte-level vectors live in crates/psensed-rs/fuzz/ + testdata (frame
   builder across all effects x dirs x rgb edges; readback slot decode).
