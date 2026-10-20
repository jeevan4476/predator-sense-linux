# Predator Sense → Linux: hardware-control protocol specification

Target: **Acer Predator PHN16-71** (Helios Neo 16) running **Predator Sense 5.0.1463** on the vendor side; our side = Linux (Fedora 44, kernel ≥ 6.x).
This document is the design basis for `predator-sense-linux` (daemon + CLI first; RGB GUI later).

**Provenance.** Every number below is cross-checked between at least two of:
1. ACPI AML decompiles: `/tmp/opencode/{dsdt,ssdt1..26}.dsl`
2. Acer's own binaries (Ghidra/REA decompiles): `AcerHardwareService.exe` (`treadstone::TsClientCommandProcessor`), `AcerAgentService.exe` (JSON/pipe bridge), `AcerECKeyboardController.dll` (RGB packer)
3. Upstream Linux kernel `drivers/platform/x86/acer-wmi.c` — local copy: `analysis/reference/acer-wmi-upstream.c`
4. Live probing on this machine: `/sys/bus/wmi/devices/*`, hwmon, platform-profile

Evidence ledger with full GUID/object tables: `analysis/wmi-methods.md`. Factory preset fan curves: `analysis/fan-pwm-tables.json`.

---

## 1. Transport architecture

Windows Predator Sense reaches the EC through WMI method calls into ACPI (`WmiAcpi.sys` → `_WDG` GUID block → `WMxx(instance, methodId, buffer)` AML). Each `WMxx` method executes the low-level EC mailbox handshake `WSMI` (`CTID` tag per block, `MTID` = command, `WMIB` = 4 KB payload scratch, strobe `WSSP = 0xD0` through an I/O port whose address is stored in AGNS[`PSSP`]). The firmware state is additionally mirrored in MMIO windows `0xFE708400–0xFE708F00` plus the AGNS region at `0x46881000`.

Transports available to a Linux replacement (safest → most powerful):

| # | Transport | Coverage | Notes |
|---|---|---|---|
| T0 | **Stock kernel** (`acer_wmi`: platform-profile + hwmon) | thermal profiles, fan rpm/temp readings, and — behind a boot parameter — per-fan custom speed/mode | zero code (§2, §3.1–3.2, §4) |
| T1 | **Out-of-tree GPL kernel module** calling `wmi_evaluate_method(GUID, inst, method_id, in, out)` | everything in §2–§5 regardless of quirk gating | recommended core; GUID4 is claimed by nobody (device visible in `/sys/bus/wmi/devices/`) |
| T2 | **Direct mailbox/MMIO** (`/dev/mem` on AGNS `0x46881000` + strobe I/O port; ERAM/EUBC windows at `0xFE708xxx`) | adds the AWMI preset engine (§3.4) and raw `NPWM` (§3.5) | root only; highest fidelity, least abstraction |

## 2. Performance / thermal profiles

Single call — WMI class `AcerGamingFunction`, GUID **`7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56`** (DSDT obj `BH`, method `WMBH`), **method id 22** (MiscSetting):

```
in  ([MS-WMIO] buffer, LE):  [0]=0x0B (index PLATFORM_PROFILE)   [1]=thermal value
out:                         [0]=status (0=OK)
thermal: 0=quiet | 1=balanced | 4=performance | 5=turbo | 6=eco
```

Side effects (confirmed in AML `WMBH` case 0x16): DPTF governor `ODV0 = {0→1, 1→0, 4→2, 5→3, 6→4}` + `Notify(\_SB.IETM, 0x88)`; NVIDIA power banks `NPCF.{DBAC,NVWM,AMAT,ATPP,ACBT}` reprogrammed from per-mode tables `M1..M5` + `Notify(NPCF, 0xC0/0xC1)`. The value is firmware-persistent (observed `low-power` after cold boot — ECO survives reboot).

Read — **method id 23**: in `u32` `[0]=0x0B`, out 8 bytes `[0]=status`, `[1]=current thermal value`.

**Linux today** (T0, working on this machine):
```
/sys/devices/platform/acer-wmi/platform-profile/platform-profile-0/
  choices = low-power quiet balanced balanced-performance performance
  profile = low-power          # ⇔ eco (thermal 6)
```

| platform_profile | thermal | UI name |
|---|---|---|
| low-power | 6 | ECO |
| quiet | 0 | Quiet |
| balanced | 1 | Balanced/Default |
| balanced-performance | 4 | Performance |
| performance | 5 | Turbo |

CLI: `psense profile [<name>]` via platform-profile, falling back to T1 calls.

## 3. Fan control

### 3.1 Fan behavior (mode) — method ids 14 (set) / 15 (get)
```
in  u64:  [0..1] fan bitmap       bit0 = CPU fan, bit3 = GPU fan (0x0009 = both)
          [2] bits 17:16 = CPU mode   [2] bits 23:22 = GPU mode    (set, id 14)
in  u32:  [0..1] fan bitmap                                                    (get, id 15)
out:      [0] status
get out:  [0] status, bits 9:8 = CPU mode, bits 15:14 = GPU mode
modes:    0x1 = auto   ·   0x2 = turbo (CoolBoost)   ·   0x3 = custom
```
CoolBoost = firmware-type max fan behavior; custom = per-fan fixed % (§3.2). AML `WMBH` case 0x0E returns 8 bytes with the mirrored sub-command handling (status + mode bits).

### 3.2 Fan speed (custom %) — method ids 16 (set) / 17 (get)
```
in  u32:  [0] fan id  0x01 = CPU · 0x04 = GPU      [1] speed percent 0–100      (set — live-validated 2026-10-17)
in  u32:  [0] fan id                                                                       (get)
out:      [0] status (0 OK · 1 no-device · 2 invalid)      get out: [1] percent (bits 15:8)
```
Live 2026-10-17: id 16 accepted the 4-byte form (`01 70 00 00`); id 17 read the value back *byte-exact* (`00 70 …`). The EC even echoes over-range values (`0x70` = 112 (>100)) without complaint — **the daemon must clamp to 0–100 itself** (upstream hwmon interpolates pwm 0–255 → percent 0–100 before sending). Custom-speed register persists after switching the fan back to AUTO (id 17 keeps reporting it; whether AUTO overrides it physically = pending id-15 recheck).
**Linux today (hidden on this machine but implemented upstream)** — the hwmon block `pwm`/`pwm_enable` is gated on `ACER_CAP_PWM`, our quirk (`quirk_acer_predator_v4`) lacks `.pwm=1`, so PHN16-71 ships without these nodes. The write path (`WMID_gaming_set_fan_speed` ↔ `set_fan_behavior`) is complete and identical to what Windows Predator Sense does. Zero-code unlock (mapping `pwm_enable`: 0=turbo, 1=custom+`pwm`, 2=auto):

```
# one-shot test
sudo modprobe -r acer_wmi && sudo modprobe acer_wmi force_caps=0x1C26
# persistent
echo "options acer_wmi force_caps=0x1C26" | sudo tee /etc/modprobe.d/acer-wmi.conf
# 0x1C26 = PLATFORM_PROFILE(0x400)|HWMON(0x800)|PWM(0x1000)|SET_FUNCTION_MODE(0x20)|WIRELESS(0x2)|BLUETOOTH(0x4)
```
`acer_wmi.force_caps=0x1C26` fully replaces the capability mask (init: `interface->capability = force_caps`, acer-wmi.c line 3216), so it must include every cap we currently use (§11.4 of the ledger). Expected result: `hwmon5` gains `pwm1 / pwm1_enable / pwm2 / pwm2_enable` (pwm 0–255 maps linearly to the % API).

Upstream option: patch `quirk_acer_predator_v4` with `.pwm = 1` (structurally supported; validate on hardware first — it is the same twinned quirk family as AN515-58/PH16-72/PT14-51).

### 3.3 Factory preset curves (BR60–65) — the AWMI/603E9613 interface
Block `603E9613-EF25-4338-A3D0-C46177516DB7` (`AWMI` in SSDT13, method `WMAA`) evaluates six factory temperature→PWM tables `BR60..BR65` (256 bytes each; entry `i` = PWM duty for temperature `i°C`), extracted to `analysis/fan-pwm-tables.json`:
```
WMAA (instance, methodId=1, u8 buffer):
  [0] MODF = 0   read  → returns EC0.NPWM
  [0] MODF = 1   write → NPWM = BR6X[ Arg2[4] ]   table X selected by firmware var _SB.LCDN (0x60..0x63)
  [0] MODF = 2   query → returns 0xFE (max duty)
```
`LCDN` (preset-bank selector) lives at EUBC+0xEE = phys `0xFE708BEE`; the PWM register `NPWM` at ERAM+0xF5 = phys `0xFE7085F5`. `LCDN` is not written anywhere in AML — it tracks firmware state (profile-dependent). This marks the boundary between *fixed-speed* custom fans (§3.2) and *curve* selection; which LCDN value corresponds to which profile must be mapped empirically (M3 probe) before the daemon exposes "preset curve" as a feature. For MVP, custom = §3.2; curves = advisory/firmware-managed.

### 3.4 Direct PWM (T2, experimental)
With the manual-fan gate set (AML governor flag `GGOV(0x08100004)`, base computed from `GPCS[0x10]` + `SBRG`), `NPWM` can be written directly — enabling arbitrary temperature→PWM curves without firmware presets. Single data point; needs the T2 hazard harness (SMM gating, EC busy states) before daemonization. The GUI's "custom curve" (v1) is implemented as a userspace scheduler (poll temps → issue §3.2 speed writes) instead, which needs no direct EC writes: safer, and exactly what Predator Sense does.

## 4. Sensors (temps / fan RPM / battery) — method id 5 (`GetGamingSysInfo`)
```
in  u64:  [0] cmd    0x0 → supported-sensor bitmap (out bits 39:24)
                     0x1 → read sensor ([1] = sensor id)
                     0x2 → battery status
out u64:  [0] status (0 = OK) · [1..2] 16-bit reading · [24..39] bitmap
sensor ids: 0x01 CPU temp · 0x02 CPU fan RPM · 0x03 ext temp2
            0x06 GPU fan RPM · 0x0A GPU temp
```
**Hardware-validated 2026-10-17** (module round-trip, ledger §13.11): supported-mask read-back `0x227` exactly as sent; CPU temp `0x2C` = 44 °C vs hwmon 44000 m°C ok; CPU fan `0x06B8` = 1720 rpm vs hwmon 1720 ok. Also decoded from the AML: reads are **direct `EC0` field accesses** (no SMI/mailbox, `GGSI` always returns status 0), and `CPUF` is **big-endian in EC RAM** (AML byte-swaps it; result == hwmon).
Equivalent hardware paths (no WMI): hwmon "acer" — `fan1_input` (CPU rpm), `fan2_input` (GPU rpm), `temp1–3` — is the kernel's rendering of ids 5/0x01/0x02/0x06/0x0A. Direct EC RAM: `EC0` region — `CTMP+0x58` CPU °C, `GTMP+0x59` GPU °C, `CPUF+0x5C` 16-bit RPM **big-endian** (empirically anchored, see above), `GPUF+0x6A`. AML source: `analysis/reference/acpi/ssdt11.dsl` (`GGSI` @1921, `WMBH` case 5 @4195).

## 5. Misc / OC settings — ids 22 / 23
Known indices: `0x05` OC_1 (0 off / 2 OC_TURBO), `0x07` OC_2, `0x0A` supported-profiles bitmap (unreliable per kernel), `0x0B` thermal profile (§2). OC toggles feed the same `M1..M5` NPCF banks as profiles. Unknown indices: enumerate 0..0xFF via the get path (read-only probe) in M3.
**Id 23 get layout (cross-checked + live-validated 2026-10-17):** input u32 = setting index at bits 7:0; output u64 = `bits 7:0` status · `bits 15:8` value. Live probe `0x0B` → `value = 6`. Upstream profile enum at this index: `QUIET=0, BALANCED=1, PERFORMANCE=4, TURBO=5, ECO=6` (upstream `acer-wmi` `ACER_PREDATOR_V4_THERMAL_PROFILE_*`) — value 6 = ECO.
`SetGamingMiscSetting` (id 22, u64 in: `bits 7:0` opcode · `bits 15:8` value) is decoded **as of 2026-10-18 from the CareCenter agent (`AcerCCAgent.exe`, shipped in the same installer — ledger §13.25)**: opcode `0x0B` = thermal profile (§2), **opcode `0x02` = battery charge mode** (`0`=Optimized, `1`=Full, `2`=Adaptive-learning; their `setBatteryHealthy` → `gmInput=(value<<8)|2`). AML `WMBH` case 0x16/0x17 (set/get) stage opcodes through `WSMI` (port 0xD0 SMM round trip) with **no DPTF/NPCF side effects at 0x02** (only profile writes at `0x0B` touch `M1..M5`). `psensed battmode.get/set` **left the misc surface the same day** (§5.1, ledger §13.26): the misc-0x02 GET is live-verified but its value byte is the function-list register (3), never a mode, and the misc-0x02 SET demonstrably cannot commit (§13.25). The CareCenter agent's real set flow is a two-switch interface whose EC commit rides the `BatteryControl` 79772EC5 BE\* family — decoded and live-verified below (**§5.1**, ledger §13.26). Misc-0x02 GET out byte 1 = the function-list register (3) — **not** a mode value (ledger §13.26 reconciliation).

### 5.1 Battery charge control — `BatteryControl` `79772EC5-04B1-4BFD-843C-61E7F77B6CC9` (WMBE, "BE") — live-verified 2026-10-18 (ledger §13.26)
The CareCenter agent's two-switch charge-mode flow lands here (confirmed via the id-21 wrapper's exact vtable-slot location). Call order = MOF order: `uBatteryNo=1` (BAT1), functionMask `1`=optimized / `4`=adaptive, status `1`=on / `0`=off.
- id 20 **`GetBatteryHealthControlStatus`**: in u8[4] `[1, query, 0, 0]`; out u8[8] `[uFunctionList(=3), uReturn[2], uFunctionStatus[5]]`. `status[0]=1` ⇒ Optimized in effect; all zeros ⇒ Full/default charging. Status is global (query 1 and 4 identical). Battery-only reads return zeros; on-AC reads give the list.
- id 21 **`SetBatteryHealthControl`**: in u8[8] `[1, mask, status, 0×5]`; out u16 `uReturn` (0=ok, 1=function rejected). Live round-trip: `[1,1,1]` enables Optimized (BEGB `00→01`), `[1,1,0]` disables and restores. Function 4 (adaptive) rejected with `uReturn=1` on this unit — the live correlate of the renderer's `ABC/BAC` feature gate that hides AI-Smart.
- id 22/23 **Get/SetBatteryFunctionData**: the BAC (Battery Adaptive Charging) schedule record — `uBACStartTime[2]/uBACStopTime[2]/uBACStatus` (the `BatteryAdaptiveCharging` Get shape from the embedded protocol manual). Reads verified (`returnCode 1, 00:00, off` = never configured); writes parked.
- Reconciliation: the `AcerGamingFunction` misc opcode-0x02 GET byte 1 = the same function-list register (`3`), **not** the mode store ⇒ the misc id-22 "set" can never commit a mode (§13.25).
- Linux: `psensed battmode.get` (one battery-20 eval; the old misc-02 parity byte removed — §13.27's SMM deferral) and `battmode.set {0|1}` = the agent's two-switch sequence with a BEGB-committed verdict; mode 2 honestly reports the EC rejection. **GUI click-verified both ways** (SET 0.64–0.90 s, ACK → auto-GET → re-render; screenshots kept locally, not in the source tree). Hotspots: the card *radio* (`(429,231)` Optimized, `(429,305)` Full); the Full-card title row does not register (`(640,305)`). GUI: only Optimized/Full cards (AI-Smart hidden via the feature gate). Ops timing note: near-simultaneous WMI evals (<~150 ms apart) defer in the SMM 5–22 s — `psensed` spaces evals ≥200 ms (`EVAL_GAP`, the measured-safe retune of the original 250 ms figure) / ≥500 ms across GUID families (§13.27). The authoritative wire-level contract for these semantics now lives in `spec/daemon-protocol.md` (R0).
`SetGamingFanTable` = `AcerGamingFunction` **id 18** (u64 in) with **id 19** `GetGamingFanTable` (u64 out, no input per MOF) — ledger §13.15.1: the service passes it through uninterpreted, the AML's `BHPK=Buffer(0x202)` staging never escapes the MOF-truncated u64 output (`psense wmi gaming 19 --out 522` → `0100000000000000`, marker `0x01`), so **it is a selector/commit token, not curve data**. Custom curve stays on the userspace interpreter (§3.4); the real EC-side preset curves = the `WMAA` (603E9613) MODF path with BR60–65 (`analysis/fan-pwm-tables.json`), a future feature.

## 6. Lighting — keyboard RGB, lightbar strips, logo LED (decoded 2026-10-17, ledger §13)
All writes go through `AcerGamingFunction` (`ROOT\WMI` ExecMethod calls; ≥30 ms spacing — now code-proven in the service composer too). `AcerGamingFunction` = GUID `7A4DDFE7…`; **method ids from the decoded BMOF** (`analysis/reference/gaming.mof.decoded.txt`), Windows-binary-verified layouts below.

### 6.1 Effect frame — method 20 `SetGamingKBBacklight` (u8[16])
Production composition (Windows service binary-verified, ledger §13.14.4 — `FUN_14000b190` assembly):
| byte | field | notes |
|---|---|---|
| 0 | mode | EC mode id (see 6.3), pass-through |
| 1 | speed | raw (OpenRGB client domain; common values 0–255, brick defaults 0 = slowest→… see note) |
| 2 | brightness | same raw domain |
| 3 | 0 | always 0 in the production composer |
| 4 | direction | **verbatim** (service composer does not emit `dir+1`; §13.4's `dir+1` variant = experimental OpenRGB bridge only) |
| 5–7 | R, G, B | low 3 bytes of the packed color u32 |
| 8 | 0x03 | constant ("on") |
| 9 | device | **1 = keyboard, 2 = lightbar strip, 3 = global/default** (service maps `realdev{0,1,≥2} → {3,1,2}`) |
| 10–15 | 0 | |
Binary evidence: `AcerECKeyboardController.dll` `6d8d75e6…` (OpenRGB plugin — bridge-variant frame with `[3]=dir+1, RGB@[4..6]`), `AcerLightingService.exe` `ed8a02ad…` (*this* layout, ev_1ad4a5bc), live round-trips (§13.11 oddities resolved by the composer decode).

### 6.2 Zone colors — method 6 `SetGamingRgbKb` (u64)
`d[0]` = zone bitmask bit, `d[1..3]` = R, G, B. Keyboard = **4 zones** (bits 1|2|4|8); lightbar reuses method 6 with extended zone ids (`|0x100`/`|0x400`/`|0x800…`, style-dependent). Companion `SetGamingLED` (id 12-byte in) carries zone-enable/reset markers: observed u64 constants `0x00000F0000000008` (KB) and `0xFFF5000000000010` (lightbar style); semantics partial. Evidence ev_89b4e540….

### 6.3 Mode ids & controller notes (EC table — binary consensus, ledger §13.14.6)
Keyboard and strip EC plugins use the **same EC effect-id space**; per-device extras differ:
- Keyboard (AcerECKeyboardController, ev_71c64e02 ctor): `STATIC=0 BREATHING=1 SHIFTING=4 METEOR=6 TWINKLING=7 DIRECT=0xFF` — flags `0x51`/`0x53`/`0x30`; single color per mode; Mode default tail `1, 9, 0, 100, 5, 50` (bounds fields, exact min/max semantics pending mapping against the OpenRGB `Mode` class); ONE zone ("Keyboard Backlight zone") owns all keyboard LEDs, LED count from the controller object.
- Strips (AcerECLightbarController — already decoded, §6.2): `STATIC=0 BREATHING=1 NEON=2 WAVE=3 TWINKLING=7 DIRECT=0xFF`.
- EC id space 5 = unobserved in both plugins (legacy/unused). Direct (0xFF) = per-key/per-LED path, not routed through this 16-B frame on the KB plugin (dispatcher intentionally skips it).
- **Pass-through confirmed**: both plugins + the service composer forward the mode id verbatim — no LUT anywhere app-side.
- **STATIC needs speed 0 (live §13.20.1)**: `kb.set` STATIC with speed≠0 is silently rejected (ack `0000`, register unchanged); mode 0 + `speed 0` sticks and renders (user-verified). Animated modes accept the UI speed verbatim (mode 3 wave confirmed; `mode 3` is valid for the keyboard even though the KB plugin ctor only lists 0/1/4/6/7/0xFF). Callers must normalize: non-animated mode → `speed 0`; animated → speed as given.

Logo LED: separate path — `SetGamingLEDColor` (12): u64 `1,R,G,B,brightness,speed,0,0`; then `SetGamingLEDBehavior` (10): u64 `1,-,real_mode`, `real_mode` via LUT `0→1, 1→3, 2→4` (ev_d6ed6eb6…). Call order: color → Sleep(30) → behavior → Sleep(30).

Read-back: method 21 `GetGamingKBBacklight` (u32 → u8[16]) — **fully solved 2026-10-17 (ledger §13.16): the reply is an echo mirror of the last write + the zone store:**
`[0]` gate (nonzero ⇒ service reports bri 100) · `[1]`=mode echo · `[2]`=speed echo · `[3]`=brightness echo · `[4]`=direction echo · `[5..7]`=16-B frame RGB echo · `[6..8]`=zone-color store (overlapping window; last id‑6 write wins) · `[9]`=on-flag echo (0x03) · rest reserved. Recalibrated live 2026-10-19 (method-20 write mode 1/speed 3/bri 100/rgb C7,3E,14 echoed `00 01 03 64 02 c7 3e 14 … 03`); the earlier per-slot legend was off by one — `spec/daemon-protocol.md` §6 F2 is the authoritative layout. The 16‑B frame's own RGB bytes are **not** mirrored into `[6..8]` — in STATIC the palette comes from zone colors (id 6); `kb.get` remains the online truth query (`kb get`) for lost replies (§6.4).

### 6.4 Not lightbar

`FE1DBBDA…` (`WMBL`/`BL*` buffers) is **`UtilityFunction`**: BIOS passwords/settings/EDID/diagnostics staging — unrelated to lighting (ledger §13.3). Turbo-key LED uses the id-10 family (event-driven, kernel maps the hotkey).

**Ops note (§13.12, live):** zone evals measured ≈ 30–50 ms each (module 30-ms pacing + SMI); a 4-zone op ≈ 0.24 s. Clients should use generous timeouts (we ship 20 s) — real EC stalls are rare but were observed once (minutes-long eval; daemon now isolates + watchdogs). Rule: a write whose reply is lost must be treated as **applied-unknown until re-read** (`kb.get` / `fan.wmodes` are the truth queries).
## 7. Events / hotkeys
Event GUID `676AA15E-6A47-4D9F-A2CC-1E6D18D14026` is already consumed by the kernel input device (`acer_wmi`): id 0x7 = **TurboKey** (toggles turbo + LED), id 0x8 = AC plug/unplug etc. The daemon reads via kernel (uinput/evdev), not raw WMI notify.

## 8. Linux replacement design (MVP → v1)

```
                  ┌──────────────────────────────┐
  CLI ─▲unix sock▲ │  psensed (root daemon)       │     kernel surface
  GUI ─▲same sock▲ │  - profile + fan state model │─┐
       └──────────┴   - 2 s sensor poll cache     │ │
                      - JSON API, rate-limit ~30ms│ ▼
                      └─────────────┬──────────────┴─ platform-profile  (modes, T0)
                                    ├────────────────── hwmon (readings, T0)
                                    ├────────────────── hwmon pwm      (fans, T0')
                                    ├────────────────── psense-wmi     (T1 fallback/superset)
                                    └────────────────── /dev/mem       (T2, opt-in only)
   T0' = stock kernel once booted with force_caps / quirk fix (§3.2)
```

Components:
- **`psensed`** — root daemon: state model (profile, fan modes/speeds), sensor cache, JSON API over `/run/psense.sock`; ≥30 ms spacing between writes (Acer's own service sleeps 30 ms per call); respawn-safe on suspend. Ops: `sensors` `profile.get/set` `fan.*` `kb.*` `memory` (SMBIOS type-17 scan → RAM freq/type, 60 s cached consumers) `sysinfo` (honest system identity for the wsinfo wedge: DMI/BIOS/OS/CPU/RAM/storage/battery/network/devices; 30-s instance cache; root-only — reads `/sys/class/dmi/id/*`; shapes per ledger §13.23) `health` (checkup diagnostics: battery design/full ratio ≥80 % → OK, per-disk `smartctl -H` verdict; root-only; RAM honestly unsupported — 1004 → their "Diagnostic Failed" dialog, ledger §13.24) `battmode.get/set` (battery charge mode through `BatteryControl` 79772EC5 ids 20/21 "BE" — §5.1; **both live-verified**, SET = the agent's two-switch flow with BEGB-committed verdict; mode 2 = Adaptive-learning honestly unadvertised, ledger §13.26) `usbcharge.get/set` (Power-off USB charge switch + battery cut-off threshold 10/20/30 % through `APGeAction` 61EF69EA ids 2/1 opcode `0x04`, EC-verified, ledger §13.29) `wmi.raw` (guid slot: gaming|apge|battery|generic).
- **`psense`** (CLI): `profile set|get|list` · `fan mode auto|turbo|custom|get` · `fan speed cpu|gpu|both <0-100>` · `fan wmode|wspeed|wget|wmodes|wtable` (raw WMI fan chain) · `curve set|show|clear` (userspace temp→PWM scheduler, §3.4) · `kb get|zone|set` (+ mode aliases `static/breathing/shifting/meteor/twinkling/direct`; `--brightness` is the raw register byte 0..255 — their UI scale is 0..5 ×20) · `battmode get|set` · `usbcharge get|set` · `sensors` · `info` · `wmi <guid> <mid> [hex]` (raw escape hatch) — thin client over the daemon; falls back to direct sysfs/WMI if daemon absent (`fan sweep` is direct-only).
- **Rendering rule (§6)**: keyboard color in STATIC lives in the zone store — `kb zone --rgb <r,g,b>` changes the palette, `kb set static` selects the effect/brightness/speed. The effect frame's own RGB bytes are not mirrored into the zone colors (ledger §13.16).
- **`psense-wmi`** — tiny GPL out-of-tree module (ioctl: `wmi_evaluate_method` proxies for GUID4 + 603E9613); only needed while T0 gating persists.
- GUI (later) — same socket.

## 9. Milestone validation plan
1. **M1 ok (2026-10-17, this machine)**: `force_caps=0x1C26` one-shot module reload → `pwm1/pwm1_enable/pwm2/pwm2_enable` present; platform-profile + rfkill intact. Custom-mode sweep (CPU channel): pwm 255→7309 rpm, 128→4418, 64→2409; GPU channel unaffected (fan-id mapping confirmed). Mode writes cause rpm transient dips ⇒ reads debounced ≥2 s in psensed. Persistence shipped: `/etc/modprobe.d/acer-wmi.conf` + `psensed.service` running; curve scheduler verified live (fan follows registered temp→% curve).
2. **M2 ok (2026-10-17, this machine)**: profile ride-along (`tools/m2-profile-ridealong.sh`) — firmware thermal write lands in `intel-rapl-mmio:0` constraint_0: low-power 20 W, quiet 45 W, balanced 70 W, balanced-performance 80 W, performance 100 W. PL2/PL3 (157/246 W), BIOS rapl c0 (65 W), cpufreq, GPU limit: profile-independent. Fan behavior mode untouched by profile writes (orthogonal calls). ⇒ replacement only needs the profile write; no userspace CPU/GPU tuning.
3. **M3b ok (2026-10-17, this machine)**: `psense-wmi` module live (read-back bug fixed, ledger §13.9) + every core surface live-validated: sensors (id 5), profiles via misc (id 23, enum match), battery interface read (79772EC5 id 19), KB zone colors write+read (ids 6/21), fan chain write+read+restore (ids 14/15/16/17, custom-speed register benign-inert under AUTO). `psensed` wires the ioctl surface (`wmi.raw`, `kb.get/zone.set/set`, `fan.wmode/wspeed/wget/wmodes/wtable`) on an isolated worker thread with 25-s watchdog (`wmi busy` fail-fast; ledger §13.12 for the wedge post-mortem + timings: zone eval ≈ 30–50 ms, 4-zone op ≈ 0.24 s). CLI: `psense kb get|zone|set`, `psense fan wmode|wspeed|wget|wmodes|wtable`, `psense wmi <guid> <mid> [hex]`. DKMS packaging: `src/psense-wmi/dkms.conf` + `install-dkms.sh`.
4. **M4**: fan-% sweep — 20→100 % in 5 % steps, log rpm vs % per fan (feed the GUI's speed slider; calibrates EC-mirror `CPUF/GPUF` endianness too). Also live-test **method 18/19 `Set/GetGamingFanTable`** — if it takes a temp→speed vector, fans get an EC-native curve (would obsolete the userspace 2 s interpolation).
5. **M5 lighting (decoded, ledger §13)**: `psense-wmi` module gains whitelisted evaluation of ids 2/6/10/12/20/21 (+13/11 gets); CLI `light rgb <r,g,b> --target kb|lightbar|logo`, `light mode <name>`; visual A/B vs. Windows Predator Sense values; verify `GetGamingKBBacklight` read-back round-trip.
6. **M3 addendum**: same ioctl also unlocks `BatteryControl` (79772EC5 ids 21–23) — charge-limit surface — and `APGeAction`/`AcerGenericMethod` probes. *(§13.15.3 caveat: Predator Sense 5.0.1.463 ships **no consumer** of the 79772EC5/FE1DBBDA surfaces — reads-only, no features built on them until a semantics source shows up. GET probes (ledger §13.22) return the WMIB snapshot + AML-forced flag bytes; SET semantics unknown — probing is parked until the host is on AC and a careful round-trip is agreed.)*
7. **M6 ok (2026-10-18, this machine)**: full-page GUI validation on the **installed tree** (`packaging/install.sh` → `/opt/predator-sense` + `/usr/local/bin/predator-sense`, psensed/Cli installed; menu entry + generated brand icon). Cold boot from the installed path: 0 renderer errors; boot-time lighting apply (service-parity, 5-s delay) writes the active profile (kb.set + zone palette); Lighting page holds the persisted profile selection (ScenarioChanged chain steady); Home (mascot + 3D assets load from /opt), Live Update (empty-state), Monitoring (live panels incl. RAM frequency 4800 via SMBIOS op) all verified. Apps page populated from XDG entries with icons; card click launches the app (`LaunchApp` contract GUI-verified with Firefox). Tutorial gates now per-key KV persisted (§13.21). **wsinfo wedge verified the same day** (§13.23): ports 4449/4343 answer honest DeviceInfoI3d/CareCenter packets — System Info page populated 1:1 with /sys (BIOS V1.20, Fedora Linux 44, i7-13700HX/24, 16 GB DDR5, Samsung 1 TB SSD, RTX 4050, Killer E2600 + CNVi Wi-Fi with colonized IPv6) and the Checkup battery card tracked the physical power state live (97 % Charging on AC → 72 % + "1 h 23 min remaining" after unplug); port 5141 (`QuickAccess`) answers `FunctionQuery: ["USBCharge", "USBChargeSwitch"]` backed by `APGeAction` ids 2/1 opcode `0x04` (§13.29); check-status tiles honest "Unchecked"; no new renderer errors. **Checkup Check buttons verified later the same day** (§13.24): Battery Check → "Good 2026/10/18 11:48:30" (design/full ratio ≥80 %), Storage Check → smartctl PASSED → "Good", RAM Check → honest "Diagnostic Failed — Error 1004" (no Linux runtime diagnostic), Checkup All skips the failing RAM item via their own loop and finishes "Diagnostic finished"; results persist across runs via their KV plumbing (Battery/Storage/RamLastCheckedInfo), Abort path implemented silently.

## 10. Evidence pointers
| Claim | Source |
|---|---|
| GUID4 method ids & bit layouts | `acer-wmi-upstream.c` lines 60–99 / 105–135 / 145–155 / 155–166 / 1500–1620 / 1670–1840 / 2095–2180 |
| `WMBH` full case list, `0x16` DPTF & NPCF branch | `ssdt11.dsl` 4192–4470 |
| `WMAA` + `BR6x` + LCDN switch | `ssdt13.dsl` ~3928 (WMAA), 2440–2600 (NBCI), 3706–3920 (tables) |
| `GGOV/SGOV` + `GPCS` governor table | `dsdt.dsl` 11467–11960 |
| EC MMIO windows (ERAM/EUBC/EMBX…) | `dsdt.dsl` 27991–28620 |
| exe wrappers: class = `AcerGamingFunction`, 2-in/2-out, `VT_UI8` payload | REA: `FUN_14000c840` (SetGamingFanTable), `FUN_14001af20` + `FUN_14003dd50` (profile pipe), `FUN_140020040` dispatcher |
| KB RGB 16-byte payload layout | REA: `AcerECKeyboardController.dll` — `AcerECKeyboardController::SetMode` (ev_b183acf4…; *corrected* layout: d[2]=brightness, d[4]=dir+1, d[9]=device) |
| WMI class GUID/method map incl. all lighting ids | **BMOF decode** `ssdt11 WQAB` → `analysis/reference/gaming.mof.decoded.txt` (pali/bmfdec; supersedes parked FOMB work) |
| Windows lighting payload layouts (16 B frame, zone u64s, logo LUT) | REA evidence ev_a4d20c9f…/ev_b183acf4…/ev_7e10e6d6…/ev_89b4e540…/ev_d6ed6eb6…/ev_fc211d07… — binary sha256s in ledger §13.4/§13.8 |
| UI vocabulary (`fan_custom_auto/speed`, `OPERATING_MODE`, `Scenario_Profile`) | `/tmp/opencode/psapp/dist/main/main.js` |
| Live sysfs / hwmon / WMI devices on this machine | ledger §11.4 |

**Limitations.** ~~`WMBH` ids 1, 3, 6–13, 18–21, 24–25 unknown~~ **solved by BMOF decode (2026-10-17)**: full `AcerGamingFunction` id/signature table in `analysis/reference/gaming.mof.decoded.txt`; remaining unknowns are payload *semantics* (id 18/19 fan-table vector layout, id 2 'SetGamingLED' markers, GetGamingKBBacklight response fields, OC 512-byte structure) plus the KB RGBController mode table — all live-experimentation items once M3's module runs. `WMBK` (`F75F5666`) = `BIOSSetting` (boot sequence/passwords — out of scope). T2 details are desk-derived only (never executed). The `force_caps` mask `0x1C26` was composed from live-observed caps and has been validated end-to-end on this machine (§9.1/M1) — the remaining runtime check is only that rfkill/wireless behave identically after a cold boot with the persisted parameter. All T1/T2 code targets unmodified Acer firmware; behaviour differences across Predator Sense updates are out of scope.
