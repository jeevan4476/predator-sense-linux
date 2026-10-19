# Predator Sense 5.0.1463 → Linux port: WMI/EC protocol analysis
Target laptop: **Acer Predator PHN16-71** (Compass_RTX, ABIOS V1.20; THIS machine runs Fedora, so all `/sys`, DSDT, WMI evidence is live local hardware).
Windows installer analyzed: SHA-256 `f065461f7c0230624640226c75e5a55780626caf844f4957ea6cd0818651d88c` at `/tmp/opencode/predator-sense.zip`.

## 1. Architecture overview

```
Electron UI (app.asar "acerPredatorSense" 5.0.1463)
   │  WebSocket / named pipe (JSON)
   ▼
AcerService.exe (43MB, websocat stack + “treadstone::TsClientCommandProcessor”)
   │  named pipe (namedpipe_function::WMIGetGaming*, WMI*)
   ▼
AcerHardwareService.exe (248KB) ──SUM──► AcerAgentService.exe (751KB, JSON/pipe bridge)
   │  COM WMI  ExecMethod, namespace root\WMI
   ▼
[root\WMI]  class: AcerGamingFunction, APGeAction, APGeEventProvider, …
   │  ACPI _WDG (9 GUID blocks; SSDT11 “WMID” _UID “APGe”)
   ▼
AML WMxx methods  (WMBE/WMBK/WMBG/WMBH/WMAC/WMAA/WMAE/WMBL/WMAB/WMTE)
   │  MTID / WMIB (4 132-byte buffer) @ OperationRegion AGNS = 0x46881000 (0x1188-long shared memory)
   ▼
EC firmware (also referenced: EC0.CTMP/CPUF/GPUF/ETP2/GTMP/BTST “EC RAM” fields)
```
Established by RE of AcerHardwareService.exe, AcerAgentService.exe, AcerECKeyboardController.dll (Ghidra 12.1.4 via REA) & DSDT/SSDT11/SSDT13 decompiles (acpica 20260930).

## 2. Guid → object-ID → AML handler mapping (from _WDG, verbatim from live firmware)

| GUID | obj | device/scope | AML method(s) | feature |
|---|---|---|---|---|
| `61EF69EA-865C-4BC3-A502-A0DEBA0CB531` | AA | SSDT11 WMID/APGe | WMAA (cmd 1=set → AAST, 2=get → AAGT) | **Gaming profile** |
| `1EA0BC57-521E-461B-A7A9-5D36F141A82A` | AE | SSDT11 WMID | WMAE (cmd 1,2,3) | misc gaming setting |
| `79772EC5-04B1-4BFD-843C-61E7F77B6CC9` | BE | SSDT11 WMID | WMBE (0x13–0x17) | **battery health / charge control** (`BatteryControl` MOF ids 19–23; earlier "fan behavior" label was wrong — WMBE case range matches, semantics come from the MOF §13.2) |
| `79772EC6-04B1-4BFD-843C-61E7F77B6CC9` | BF | SSDT11 WMID | (LongRunFunction ids 1–3, `SetLongRunPara`/`SetFunctionIndex`/`SetPeriod`) | LongRun perf telemetry |
| `F75F5666-B8B3-4A5D-A91C-7488F62E5637` | BK | SSDT11 WMID | WMBK (1..0x1B) | **fan group speed / tuning** |

> **Warning: Preceding rows now supersede earlier "lightbar" attributions — FE1DBBDA is NOT the lightbar** (see §13.3).
| `FE1DBBDA-3014-4856-870C-5B3A744BF341` | BL | SSDT11 WMID | WMBL (1..0x10) | **UtilityFunction** — BIOS passwords/settings/EDID/diagnostics (MOF §13.2); *not* the lightbar |
| `77B0C3A7-F71D-43CB-B749-91CBFF5DDC43` | BG | SSDT11 WMID | WMBG (1) | `S3ResumeFunction::GetS3ResumeTime` (u8 in → u16 out) |
| `7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56` | BH | SSDT11 WMID | WMBH (1..25) | **`AcerGamingFunction`** — full gaming method table §13.2 (fans 14–17, misc 22/23, KB backlight 20/21, LED 2/4/10–13, RGB-KB 6/7, fan table 18/19, OC 24/25) |
| `4BB53443-488A-430D-A25C-874660E23BDD` | AC | SSDT11 WMID | WMAC (1..5, *strict set→get pairing*) | **`AcerBiosConfigurationTool`** — Set/GetBiosOptions (2 KiB data), earlier "RGB LED" guess wrong |
| `9F98130E-3B48-40B3-9402-DE8E160F30CC` | AB | SSDT11 WMID | WMAB (1,2) | **`DataTrans`** — Set/GetBIOSSettings (encrypted, 128 B payload); WMAB data block carries compressed MOF `WQAB` |
| `2BC49DEF-7B15-4F05-8BB7-EE37B9547C0B` | DE | DSDT WFDE/“DSarDev” | WMDE (basic dbg/“notify”) | debug/data |
| `1F13AB7F-6220-4210-8F8E-8BB5E71EE969` | TE | DSDT `TestDev` | WMTE (debug notify) | test |
| `603E9613-EF25-4338-A3D0-C46177516DB7` | AA | SSDT13 AWMI | WMAA (device-specific!) | **fan PWM curve tables** |
| `05901221-D566-11D1-B2F0-00A0C9062910` | CC ×2, AB, “00” | per-table dummy blocks | none | legacy/acer_wmi, holds the **3 BMOF FOMB blobs** |
| `676AA15E-6A47-4D9F-A2CC-1E6D18D14026` | – | SSDT11 (flags 8, event) | — | **acer_wmi’s hotkey/keyboard event GUID** |
| `2E6B3CE2-6A58-4AF2-8767-4640CA8A38E3` / `A9D77EF6-55E0-4706-B139-96ACE13F2269` / `A6FEA33E-…` | – | flags 0x08 event blocks | — | WMI events |

_Sysfs `/sys/bus/wmi/devices/`: 19 entries; obj_id column above matches `object_id` files verbatim (verified).

## 3. Userspace-visible WMI class names (consumed by Windows services)
The app addresses classes by **name** (not GUID): every wrapper calls
```
IWbemServices::ExecMethod( <Class>.InstanceName="<…>", <method>, 0, NULL, in, out )
```
with class in **root\WMI**. Class inventory discovered:
- `AcerGamingFunction` — **= GUID4 `7A4DDFE7-…` (DSDT obj `BH` / `WMBH`) per kernel cross-validation §11.1**; methods:
  `GetGamingSysInfo`, `Get/SetGamingFanBehavior`, `Get/SetGamingFanSpeed`,
  `Get/SetGamingMiscSetting`, `SetGamingLED/GetGamingLED`, `SetGamingProfileConfiguration`,
  `SetGamingFanTable` (u64 in; AML cmd id 6..13, exact id only in parked FOMB), `SetGamingKBBacklight (16-B payload)`.
- `APGeAction` — `Get/SetFunction` (return u64), events via `APGeEvent`.
- The earlier working hypothesis (profile=AA/`61EF69EA`, fan=BE, LED=AC, lightbar=BL, table=BK) is outdated: those GUID blocks are siblings on other buses (BL = lightbar, BK = `WMBK` tuning family, `61EF69EA` = kernel WMID_GUID3 device-status).

## 4. Standard TestCase protocol layer (this is how the Fan Table/Profile/RMask calls are formed)
The EXE wraps each call through:
```
CoInitializeEx(0) → CoCreateInstance(IWbemLocator) → ConnectServer(L"ROOT\\WMI")
 → CoSetProxyBlanket(RPC_C_AUTHN_WINNT, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE)
 Enumerate:  "SELECT * FROM AcerGamingFunction" → build "<class>.InstanceName=\"<name>\"" →
 ExecMethod(instance, <Method>, 0, NULL, {VT_UI1|VT_ARRAY / VT_UI8 payload, VT_UI4 cmd}, out{VT_UI4/VLI…})
 … Sleep(30) after each call (rate limit)
```
**I/O pattern per method family (uniform!):**
| direction | in | out |
|---|---|---|
| `GetGaming…` | **VT_UI4 (u32)** = cmd/subcommand | **VT_UI8 (u64)** first word of response buffer (+ more on larger buffers) |
| `SetGaming…` | **VT_UI8 (u64)** = packed payload | **VT_UI4 (u32)** = status (0 success) |
| `SetGamingLED` | **VT_UI1|VT_ARRAY, 12 B** | u32 |
| `GetGamingLED` | (cmd) | **VT_UI1|VT_ARRAY** up to 0x804-B buffer (ECDA window!) |
| `SetGamingKBBacklight` | **VT_UI1|VT_ARRAY, 16 B** | u32 |

The u32 “cmd” for Get, the cmd “selection” for Set is part of the payload. Sub-command enum (from decompiled AML switches, see §5).

## 5. AML-level sub-command table (SSDT11 WMID “APGe”)

`WSMI(Arg1=cmd, Arg2=data)`: `MTID (register @+1) = cmd; WMIB (4 132-byte buffer @+2) = data; WSSP (SYStem strobe) = 0xD0`. The EC has a **hashed, shared, read-modify-write window** at `0x46881000` (0x1188-long AGNS):
```
D2DF(1) MTID(1) WMIB(4 132) ECDA(256) HDIF(63) ODIF(21) CTID(2) LMST(8)
EPMS(8) DCST(8) APUS(8) RFDS(8) ODST(8) HSST(8) PSST(8) TMGB(2) TOPT(1) PSSP(1)
```
`WSSP` is placed into an **I/O port** whose address is the byte stored at AGNS[PSSP] (`OperationRegion (CSPR, SystemIO, PSSP, 0x02)` {`WSSP`}); `WSSP = 0xD0` fires the request.

### WMxx handlers + returned buffer sizes
| AML | CTID tag | cmd(s) | out buffer | bytes |
|---|---|---|---|---|
| WMAA | `"AA"` | 1 → AAST, 2 → AAGT | 4 B / 8 B | profile |
| WMAB | `"AB"` | 1 → ABST, 2 → ABGT | 2 B / 0x84 | AB block (also carries MOF WQAB) |
| WMAE | `"AE"` | 1,2,3 (AAST/AAGT/ABGT re-read) | 2-8 B | misc |
| **WMBE**| `"BE"` | 0x13 BEBI, 0x14 BEGB, 0x15 BESB, 0x16 BEGD, 0x17 BESD | 4/8/4/0x10/4 | **fan behavior family** |
| WMBF | – | – | – | data-only block |
| **WMBK** | `"BK"` | 1,2,3,8,9,0xA,0xB,0xD..0x19,0x1A,0x1B → BKCP/BKMN/BKSN/BKAT/BKSB/BKGB/BKGU/BKSU/BKGS/BKSS/BKGP | sizes 8/0x58/0x30/0x48/4/0x14/0x48/0x48/4/0xC | fan-tuning family!? (BKMN/BKSN = 0x58/0x30 names) |
| WMBL | `"BL"` | 1 BLCP, 2-5 BLSP, 6 BLLB, 7 BLSD, 8 BLGD, 9 BLDR, 0xA BLGP, 0xB,0xC BLCP, 0xD-0xF BLDR, 0x10 → EC0.NWFS | 8/4/4/4/4/4/0x20/… | **lightbar** |
| WMBG | `"BG"` | 1 → BGS3 | 2 B | ? |
| WMBH | `"BH"` | full case list 0x01..0x19 (see §11.2) | 4/8/0x10/0xC/0x202 | **`AcerGamingFunction` (kernel WMID_GUID4) — the gaming dispatch** |
| WMAC | `"AC"` | 1 ACSB(set); **2 needs prior 1 (ACCT!); 3 ACSD; 4 needs prior 3; 5 ACFB + OSMI** | 4/**0x804**/4/**0x804**/5 | **LED: 2 KB ECDA readback!** |
| WMAA@AWMI(SSDT13) | – | `MODF(Arg2[0])`=0 → read `EC0.NPWM`; =1 → `EC0.NPWM = BR6x[ Arg2[4] ]` depending on `\_SB.LCDN`∈{0x60,0x61,0x62,0x63} | – | **fan PWM write via curve tables BR60..BR63** |
| WMTE (TestDev) | – | 1 → PDAT + Notify(WFDE, 0xD0) | – | debug |

## 6. Direct EC data points (already visible in AML — no WMI needed)
- Fan speeds: `EC0.CPUF` (CPU fan, 16-bit, **EC byte order: lo,hi ⇒ swapped in code**), `EC0.GPUF` (GPU fan, same pattern).
- Temps: `EC0.CTMP` (CPU), `EC0.ETP2`, `EC0.GTMP` (GPU); battery: `EC0.BTST`.
These appear as EC0 OperationRegion fields, i.e., **LPC EC registers** — identical info the userspace `"acer"` hwmon exposes today via `fan1_input`, `fan2_input`, `temp1–3`.

## 7. RGB payload (this is the packer, from AcerECKeyboardController.dll decompile)
Function `AcerECGlobalController::SetMode(state, mode, speed, direction, brightness, R, G, B)` logs
`mode=%d, speed=%d, direction=%d, brightness=%d, color= (0X%X,0X%X,0X%X)` and builds **16 B** payload:
```
[0]=mode, [1]=speed, [2]=direction+1, [3]=brightness,
[4]=R?, [5]=G?, [6]=B?, [8]=(state?3:1), [9]=3, [10]= subtype? (see pseudocode), rest 0
```
→ sent via `SetGamingKBBacklight` (VT_UI1 array, contiguous 16 bytes) on class `AcerGamingFunction`.
For the *separate* `SetGamingLED` path the wrapper packs **12 B** (`VT_UI1|VT_ARRAY`), raw EC payload ≈ similar header + RGB zones (needs one more look at the 3-byte header before the RGB bytes).

## 8. BMOF (FOMB) decode — no longer blocking
The compressed MOF blobs (3 files, matching `WQAB`/`WQCC`/`WQCC` in the tables) would bind **class names ↔ GUIDs ↔ parameter types**.
Header: `FOMB` + `u32 ver=1` + `u32 compressed_size` + `u32 uncompressed_size` (14 036 → 104 468 for the big one), then a proprietary LZ variant ("DS\x00\x01" prefix). zlib/lzma/bz2/LZNT1/XPRESS-raw all failed to decode; the decompressor lives in `wbemcomn.dll!MofDecompression`.
**Status 2026-10-17: parked permanently** — the only thing it was needed for (which GUID carries `AcerGamingFunction` and its WmiMethodIds) is resolved by the upstream kernel driver plus the AML case numbers agreeing 1:1 (§11.1/§11.2). Only remaining FOMB value would be cosmetic method/param names.

## 9. artifacts & evidence
- Desktop/background RE artifact summary (Ghidra/REA):
  - `AcerHardwareService.exe` SHA-256 `3a43e7a9703a7222a84780276929db1a2b674a2492d8805a5d975da1df8cf471`
  - `AcerAgentService.exe` (JSON/treadstone pipe)
  - `AcerCentralService.exe` = supervisor launcher (not protocol)
  - `PredatorServiceSoftwareComponent.sys` = airplane-mode driver only (not protocol)
- All command processor ids (kSvcCmd) = served by `treadstone::TsClientCommandProcessor` with dispatch table of 39 entries built by FUN_140004df0 (indexed 1..0x26, e.g., 14=`SetGamingFanGroupBehavior`, 18=`SetGamingFanTable`, 25=`SetGamingProfileConfiguration`, 32=`SetFunction`).
- Live firmware data (this machine):
  - compressed BMOF copies: `/tmp/opencode/bmof_{12,16,18}.bin`
  - ACPI tables dumped: `/tmp/opencode/{dsdt,ssdt*}.dat` + decompiled `.dsl`

## 10. Open questions / TODOs
1. ~~Exact mapping cmd id ↔ exe method~~ **RESOLVED** — see §11 (kernel driver cross-validation; `AcerGamingFunction` = GUID4 7A4DDFE7, obj `BH`/WMBH, method ids 1..25).
2. Remaining unknown: `WMBK` family semantics (BKCP 8 B, BKGB 20 B, BKGU/BKGS 72 B …) and which WMBH ids serve `SetGamingFanTable` (candidates 6..13; only the MOF would say).
3. Lightbar payload fields (WMBL / BLGP 0x20, BLGB 0x100C) — deferred (RGB phase).
4. ~~UI JSON contract~~ — partially read from psapp (`fan_custom_auto`, `fan_custom_speed`, `fan_index`, `fan_name`, `OPERATING_MODE`, `Scenario_Profile`); enough for CLI/daemon vocabulary.
5. `AcerECLightbarController.dll` + `AcerUSBC.dll` quick decompile (payload packing like §7) — deferred.
6. FOMB decode — **parked permanently**; its only purpose (class-name↔GUID binding) is now supplied by the kernel driver (§11.1).

## 11. Authoritative cross-validation: upstream kernel `drivers/platform/x86/acer-wmi.c`
Local copy kept at `analysis/reference/acer-wmi-upstream.c` (torvalds master, 2026-10; 3301 lines).
This resolves the single largest open ambiguity of the whole RE effort (which GUID carries the gaming functions called as one class name by Acer's services), by an independent third implementation (BIOS AML ↔ Acer exe ↔ community doc ↔ kernel driver — all four agree).

### 11.1 GUID identity map (DSDT object ↔ kernel symbol ↔ live sysfs)
| Kernel symbol | GUID | DSDT obj / AML | Role |
|---|---|---|---|
| WMID_GUID3 | `61EF69EA-865C-4BC3-A502-A0DEBA0CB531` | `AA` → `WMAA` | device status / EC-mode enable (`enable_lm`, `ec_raw_mode`); NOT the profile class (earlier hypothesis corrected) |
| WMID_GUID4 | `7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56` | `BH` → `WMBH` | **`AcerGamingFunction`: profiles, fans, sensors, misc/OC, LED** |
| ACERWMID_EVENT_GUID | `676AA15E-6A47-4D9F-A2CC-1E6D18D14026` | event | hotkeys incl. `WMID_GAMING_TURBO_KEY_EVENT=0x7` (Predator key) |
| – | `603E9613-EF25-4338-A3D0-C46177516DB7` | `AA`@AWMI SSDT13 → `WMAA` | fan-PWM preset engine; also data-bound by `nvidia_wmi_ec_backlight` on this machine |
| AMW0_GUID1 | `67C3371D-95A3-4C37-BB61-DD47B491DAAB` | – | legacy AMW0 (absent here) |

### 11.2 `WMBH` full case table (AML cases confirmed = kernel method ids)
| id (dec) | out buffer | kernel function | payload encoding |
|---|---|---|---|
| 1 | BHSK 4 B | – | unknown |
| 2 | BHSK 4 B | SET_GAMING_LED (turbo LED) | u64: value |
| 3 | BHGK 8 B | – | unknown |
| 4 | BHGL **12 B** | GET_GAMING_LED | in u32=1; returns ≤12 B LED state (matches exe `SetGamingLED`/`GetGamingLED` 12-byte `VT_UI1|VT_ARRAY`) |
| 5 | BHGK 8 B | GET_GAMING_SYS_INFO | in u64: b0 = cmd (0x0 supported-sensors bitmap, 0x01 read-sensor w/ b1 = sensor id, 0x02 bat status); out: b0 status, b1.. value, b2..b3 = sensor reading, bitmap in high bytes |
| 6–13 | BHGK 8 B | – | unknown (candidate id space for `SetGamingFanTable`) |
| **14 (0x0E)** | BHGK 8 B | SET_FAN_BEHAVIOR | in u64: b0..b1 fan bitmap (bit0 CPU, bit3 GPU), CPU mode b2[17:16], GPU mode b2[23:22]; out b0 status |
| **15 (0x0F)** | BHGK 8 B | GET_FAN_BEHAVIOR | in u32: fan bitmap; out: b0 status, CPU mode b1[1:0], GPU mode b1[7:6] |
| **16 (0x10)** | BHGK 8 B | SET_FAN_SPEED | in u64: b0 fan id (0x01 CPU, 0x04 GPU), b1 speed % (≤100); out b0 status (0 ok, 1 no-dev, 2 invalid) |
| **17 (0x11)** | BHGK 8 B | GET_FAN_SPEED | in u32: fan id b0; out: b0 status, b1 speed % |
| 18/19 | BHGK 8 B | – | unknown |
| 20/21 | BHSK/BHLK 4/16 B | – | unknown |
| **22 (0x16)** | BHSK 4 B | SET_MISC | in u64: b0 = setting index, b1 = value (see §11.3); AML branch on b0==0x0B also re-programs DPTF (`ODV0` = {0:1, 1:0, 4:2, 5:3, 6:4} + `Notify(IETM,0x88)`) and NVIDIA power banks (`NPCF` M1..M5 tables + `Notify(NPCF,0xC0/0xC1)`) |
| **23 (0x17)** | BHGK 8 B | GET_MISC | in u32: index b0; out: b0 status, b1 value |
| 24 | BHSK 4 B | – | unknown |
| 25 | **BHPK 514 B** | – | unknown (big-data get) |

Fan modes (`enum acer_wmi_gaming_fan_mode`): **0x01 auto, 0x02 turbo (CoolBoost), 0x03 custom**.
Sensor ids: 0x01 CPU temp, 0x02 CPU fan rpm, 0x03 ext temp2, 0x06 GPU fan rpm, 0x0A GPU temp.
Thermal profile values (misc index 0x0B): **0 quiet, 1 balanced, 4 performance, 5 turbo, 6 eco** — identical to UI `OPERATING_MODE {QUIET=0, DEFAULT=1, EXTREME=4, TURBO=5, ECO=6}`.

### 11.3 Platform profile ↔ thermal value (kernel platform-profile mapping)
| platform_profile option | thermal value | UI name |
|---|---|---|
| low-power | 0x06 (ECO) | ECO |
| quiet | 0x00 | QUIET |
| balanced | 0x01 | DEFAULT |
| balanced-performance | 0x04 | EXTREME/Performance |
| performance | 0x05 (TURBO) | TURBO |

### 11.4 Live state on this machine (Fedora 44, PHN16-71 DMI-quirked)
- `acer_wmi` bound via DMI match "Acer Predator PHN16-71" → `quirk_acer_predator_v4` (caps: PLATFORM_PROFILE + HWMON only).
- Working: `/sys/devices/platform/acer-wmi/platform-profile/platform-profile-0/{choices,profile}` (choices = low-power quiet balanced balanced-performance performance; current = low-power).
- Working: hwmon5 "acer" = fan1_input/fan2_input (rpm), temp1–3.
- **Missing: `pwm1`, `pwm1_enable`, `pwm2`, `pwm2_enable`** — the hwmon pwm channel is gated on `ACER_CAP_PWM`, set only by quirks with `.pwm=1` (AN515-58, PH16-72, PT14-51). The write path (`WMID_gaming_set_fan_speed` / `set_fan_behavior`) is fully implemented and identical to what Windows Predator Sense uses.
- Other caps present at runtime: WIRELESS + BLUETOOTH (rfkill0/1), SET_FUNCTION_MODE (GUID3 present).

**M1 result (2026-10-17) — PASSED.** `modprobe -r acer_wmi && modprobe acer_wmi force_caps=0x1C26` on this machine:
- `pwm1/pwm1_enable/pwm2/pwm2_enable` appear; platform-profile (all 5 choices) and rfkill intact.
- Custom-mode speed sweep on the *CPU* channel only: **pwm 255→7309 rpm, 128→4418, 64→2409**; GPU channel unaffected ⇒ channel↔fan-id mapping confirmed (pwm1=CPU, pwm2=GPU).
- Behavior-mode writes (1/0/2) show early rpm transients (dips to 0/89) — firmware ramping; **debounce reads ≥2 s after any write** (implemented in psensed).
- Test script: `tools/m1-fan-test.sh` (auto-restores prior pwm state).

**M2 result (2026-10-17) — PASSED. Profile ride-along:** `tools/m2-profile-ridealong.sh` cycled all 5 platform profiles and snapshotted power observables. The firmware's thermal write lands directly in Intel RAPL MMIO (`/sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw`), one value per profile:

| profile | CPU package PL1 (rapl-mmio c0) | GPU power limit (nvidia-smi) |
|---|---|---|
| low-power | **20 W** | 80 W (unchanged) |
| quiet | **45 W** | 80 W |
| balanced | **70 W** | 80 W |
| balanced-performance | **80 W** | 80 W |
| performance | **100 W** | 80 W |

- Profile-independent: PL2/PL3 short & peak limits (157 W / 246 W), `intel-rapl:0` c0 (65 W, BIOS static), `cpufreq` `scaling_max_freq`, GPU limits ⇒ **the replacement needs only the profile write; the firmware does the rest** (validates spec §3).
- Fan-mode independence confirmed directly: fan1 stayed `custom` + registered curve through all five profile writes (rpm followed the curve, no turbo spikes) ⇒ thermal profile and fan-behavior WMI calls are orthogonal, as designed.
- Test script: `tools/m2-profile-ridealong.sh` (auto-restores original profile).

### 11.5 Zero-code milestone: `acer_wmi.force_caps`
Init applies `interface->capability = force_caps;` when the module param is set (acer-wmi.c line 3216; param documented "Force the capability bitmask to this value"). To keep current functionality plus pwm:
```
CAP_PLATFORM_PROFILE = BIT(10) = 0x400
CAP_HWMON            = BIT(11) = 0x800
CAP_PWM              = BIT(12) = 0x1000
CAP_SET_FUNCTION_MODE= BIT(5)  = 0x20
CAP_WIRELESS         = BIT(1)  = 0x2
CAP_BLUETOOTH        = BIT(2)  = 0x4
mask                 = 0x1C26
```
Boot/test with: `sudo modprobe -r acer_wmi && sudo modprobe acer_wmi force_caps=0x1C26` (or kernel cmdline `acer_wmi.force_caps=0x1C26`; for persisted boot: edit `/etc/modprobe.d/acer-wmi.conf` → `options acer_wmi force_caps=0x1C26`).
Expected: hwmon5 gains `pwm1`/`pwm1_enable`/`pwm2`/`pwm2_enable` (enable: 0=Turbo fans, 1=Custom+`pwm` 0–255, 2=Auto). Then per-fan speed % / mode control = stock kernel, no custom code.

## 12. Direct EC/MMIO map (this BIOS exposes EC state as SystemMemory windows)
Discovered this session from `dsdt.dsl` (not mediated by WMI at all):
| Region | phys base | size | notable fields |
|---|---|---|---|
| `ERAM` | **0xFE708500** | 0x100 | PL1H/PL1L/PL2H/PL2L @0x14–0x17 (power limits), `FANT@0x54`, `CTMP@0x58` (CPU °C), `GTMP@0x59` (GPU), `CPUF@0x5C` 16-bit (RPM, byte-swapped in GGSI), `GPUF@0x6A` 16-bit, `ETP2/3/4/5/6` extra temps, `NPWM@0xF5` (fan PWM duty), `DPLM@` singular not here |
| `EUBC` | **0xFE708B00** | 0x100 | battery block + `PCMV@0xC8`; `PMNL@0xEA, PMNH@0xEB, PPDL@0xEC, PPDH@0xED,` **`LCDN@0xEE`**, `CPUI@0xEF, GPUI@0xF0, MBID@0xF1, ODPA@0xF2, DRID@0xF3, VKID@0xF4` (offsets 0xEA–0xF4 derived by back-counting from `Offset(0xF5)`/`DPLM@0xF5`, `NVDP@0xF8`) |
| `EMBX` | 0xFE708A00 | 0x100 | EC command mailbox region (referenced by EMBY ops) |
| `EROM`/`ERM2`/`ERM4` | 0xFE708900/0xFE708F00/0xFE708400 | 0x100 | misc firmware blocks |
| AGNS (SSDT11) | 0x46881000 | 2+64 KB | WMI (`WSMI`/`WMIB`/`WSSP=0xD0` strobe via I/O port at AGNS[`PSSP`]) **shared OS↔EC mailbox** — the direct sibling of what WMI ACPI evaluates |

`LCDN/CPUI/GPUI` are only ever READ in AML — profiles select a preset bank (`BR60..BR65` temperature→PWM curves in ssdt13, extracted to `analysis/fan-pwm-tables.json`) and per-SKU NBCI DSM tables (`GVA1..GVC6` under PEGP). Writers (if any) are outside AML visibility — treat values as firmware-side state (read-only assumption for MVP; AWMI WMAA can still write `NPWM` through presets).

## 13. Lighting / RGB + full WMI MOF map (2026-10-17)

### 13.1 BMOF decode — the "parked" FOMB is broken open
- The compiled WMI MOF lives in SSDT11 as `Name (WQAB, Buffer (0x36E4))` (previously mislabeled as FOMB-adjacent; note `WMAB` data block also carries the same compressed MOF family). Extracted 14,052 bytes → decoded with **`pali/bmfdec` (`bmf2mof`)**, which handles Acer's compressed `FOMB`-magic variant directly (single-file C, `gcc bmf2mof.c`).
- Result: 176-line plaintext MOF listing **every Acer WMI class, GUID, method id and C signature** (BIOS "Version 2.88"). Persisted copy: `analysis/reference/gaming.mof.decoded.txt` (regenerated byte-exact from session transcript — see 13.7).
- **: the entire earlier decision "FOMB/BMOF decode permanently parked" is obsolete** — one command with `bmfdec` replaces the manual format work.

### 13.2 Authoritative method table (from the decoded MOF)
`AcerGamingFunction` `{7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56}` (= kernel `WMID_GUID4`, AML `WMBH`, cases = method ids 1:1):

| id | method | in → out |
|---|---|---|
| 1 | SetGamingProfile | u64 → u32 |
| 2 | SetGamingLED | **u8[12]** → u32 |
| 3 | GetGamingProfile | u32 → u64 |
| 4 | GetGamingLED | u32 → u8 + u8[11] |
| 5 | GetGamingSysInfo | u32 → u64 (kernel §4 ok) |
| 6 | SetGamingRgbKb | u64 → u32 **(per-zone RGB)** |
| 7 | GetGamingRgbKb | u32 → u64 |
| 8/9 | Set/GetGamingProfileSetting | u64 |
| 10 | SetGamingLEDBehavior | u64 → u32 |
| 11 | GetGamingLEDBehavior | u32 → u64 |
| 12 | SetGamingLEDColor | u64 → u32 |
| 13 | GetGamingLEDColor | u32 → u64 |
| 14/15 | Set/GetGamingFanBehavior | u64 (kernel ok M1) |
| 16/17 | Set/GetGamingFanSpeed | u64 (kernel ok M1) |
| 18/19 | Set/Get **GamingFanTable** | u64 / (u64 out) — *likely the EC-native custom fan curve* (§5 note) |
| 20 | **SetGamingKBBacklight** | **u8[16]** → u32 |
| 21 | **GetGamingKBBacklight** | u32 → u8 + u8[15] (read-back) |
| 22/23 | Set/GetGamingMiscSetting | u64 (kernel ok; DSDT case 0x16 matches id 22 ok) |
| 24/25 | Set/GetCPUOverclockingProfile | 1 B + 512 B structure → (514 B out) |

Other classes (same MOF): `UtilityFunction` (FE1DBBDA ids 1–16), `APGeAction` (61EF69EA = kernel WMID_GUID3: SetFunction u64 / GetFunction), `AcerGenericMethod` (1EA0BC57: SetFunction/GetFunction + GetStorageInformation — NVMe model/serial!), `DataTrans` (9F98130E: encrypted BIOS settings 128 B), **`BatteryControl`** (79772EC5 ids 19–23: health/status + `SetBatteryHealthControl` — charge-limit surface), `LongRunFunction` (79772EC6 ids 1–3), `S3ResumeFunction` (77B0C3A7 id 1), `BIOSSetting` (F75F5666, `WMBK` original binding — boot sequence/passwords — coincides with ledger row "BK" staging), `AcerBiosConfigurationTool` (4BB53443: 2 KiB Data options), event classes `APGeEvent` (676AA15E, `EventDetail[8]`), `SecEvent` (A9D77EF6), `AcerGenericEvent` (2E6B3CE2).

### 13.3 FE1DBBDA correction
`FE1DBBDA-3014-4856-870C-5B3A744BF341` = **`UtilityFunction`** (BIOS supervisor password Check/Set, Get/SetBIOSSettings with staged `Data[4096]`, HDD password, diagnostics, EDID push, LED indicator, second-display, NotifyWifiStatus). The AML `WMBL` switch cases 1..0x10 map **1:1 to these MOF ids**; the named buffers (`BLCP` 8 B / `BLSP` 4 B / `BLGB` 0x100C / `BLGP` 0x20 / `BLLB`-`BLDR` 4 B) are **output-size staging**, not lightbar payloads (`BLGB` 4,108 B = GetBIOSSettings data staging, *not* animation frames as previously guessed). The earlier "lightbar (FE1DBBDA/WMBL)" notes in this ledger and spec §6 are hereby corrected.

### 13.4 Lighting protocol as implemented by Windows 5.0.1.463 binaries (native x86-64, REA/Ghidra)
All contact = WMI COM (`ROOT\WMI`, `SELECT * FROM AcerGamingFunction`, ExecMethod with `gmInput` safe array, `Sleep(30)` pacing after each call — matched Acer's 30 ms rule).

**A. Keyboard backlight + the 4 lightbar strips — method 20 `SetGamingKBBacklight` (16 B):**
`[0]=mode [1]=speed [2]=brightness [3]=0 [4]=direction+1 [5..7]=R,G,B [8]=0x03 [9]=device [10..15]=0`
- byte `d[9]`: **1 = keyboard** (AcerECKeyboardController.dll `SetMode`, sha256 6d8d75e6…, evidence ev_b183acf4…), **2 = lightbar strips** (front/left/right/rear identical packing in AcerECLightbarController.dll, sha 8f2a1eda…, ev_a4d20c9f…: uStack `0x203`), **3 = global/default-reset** (AcerLightingService.exe sha ed8a02ad…, ev_7e10e6d6…).
- byte `[8]=0x03` constant across all three paths (read as "on"; the old `[8]=state?3:1` + `[10]=subcode` claims are retired — `[10..15]` are zero in every observed pack).
- `direction+1`: DLLs add `+1` in the callee (Uint8 `char param_4 + 1`); the service's `SetKeyboardBacklightEffect` receives raw index and sends it at d[4] (verified by instruction stream at 0x14000b271+), so wire value = direction_index + 1 where index starts at 0.
- Call-site C++ signature (both controller DLLs): `SetMode(mode, speed, direction, brightness, r, g, b)`; wire byte[2] = *brightness*, NOT direction. The old spec §6 layout ([2]=direction+1, [3]=brightness, RGB at [4..6]) is **wrong** and superseded.
- Strip RGBController mode values (OpenRGB-shaped classes; no LUT in strip `SetMode` — passed straight through): `STATIC=0, BREATHING=1, NEON=2, WAVE=3, TWINKLING=7, Direct=0xFF` (Direct = passthrough).

**B. Logo LED — AcerECLightbarController `AcerECLogoLEDController::SetMode` (0x180003230, ev_d6ed6eb6…):**
- First `SetGamingLEDColor` (id 12): u64 = `d[0]=1, d[1..3]=R,G,B, d[4]=brightness, d[5]=speed, d[6..7]=0`
- Then `SetGamingLEDBehavior` (id 10): u64 = `d[0]=1, d[2]=real_mode, rest 0` — **mode value translated through LUT at 0x180016020: user 0→1, 1→3, 2→4 (other entries 0)** ("real mode" log field).
- Sequence: color first → `Sleep(30)` → behavior → `Sleep(30)`.

**C. Per-zone colors — method 6 `SetGamingRgbKb` (u64):**
- `ECKeyboard::SetKeyboardLEDBehavior` (AcerLightingService.exe 0x14000b3c0, ev_89b4e540…): **keyboard = 4 zones**, per zone one call with u64 `d[0]=zone bitmask bit (1,2,4,8...)`, `d[1..3]=R,G,B`; lightbar path reuses method 6 with **extended zone ids (`|0x100/0x400/0x800…`)** and style flag (`SetKeyboardLEDBehavior(deviceIndex{1=kb,2=lb}, zone-count{4,2}, colors, brightness, style{0,1})`).
- Companion `SetGamingLED` (id 2) u64 constants observed: KB reset `0x00000F0000000008` (d[0]=8, d[5]=0x0F), lightbar-style `0xFFF5000000000010` (d[0]=0x10, d[6]=0xF5, d[7]=0xFF) — exact field semantics unresolved (looks like zone-enable/reset markers).

**D. Device enumeration/probe:** `CheckDeviceStatus` (`0x180005030`, ev_fc211d07…) builds the device list from hardware-support bitmask + `GetGamingLEDBehavior` (id 11, u32=1 → u64) as a liveness read; returns name list (`AcerECLightBar`, `AcerECLeftLightbar`, `AcerECRightLightbar`, `AcerECLogoLED` …) — "Number of Device:%d, DeviceName:%s".

**Prior-summary corrections recorded:** (1) KB payload layout byte order ([2]=brightness / [4]=dir+1); (2) `AcerHardwareService.exe` (sha 3a43e7a9…) does NOT own the KB backlight — it only drives the Turbo-key LED via id-10-family calls ("Enable/Disable Turbo Key WMI SetGamingLEDBehaviorFunction"); (3) instructions-level read confirmed d[9] and d[8] semantics above.

### 13.5 DSDT↔MOF cross-check
- WMBH switch cases = MOF WmiMethodIds 1:1 (case 5 = `GGSI` EC call = GetGamingSysInfo ok kernel id 5; case 0x16 = SetGamingMiscSetting ok kernel id 22, and its `Arg2[1]==3/4/5` subvalues write `NPCF.AMAT/ATPP/ACBT` from `\_SB.M2*/M3*/M4*` power tables ×0.08 — OC/power-plane side effects, consistent with §5).
- WMBL switch cases 1..0x10 = `UtilityFunction` ids 1:1 (case 3 = `BLGB` 0x100C = 4096-byte BIOS-settings data staging ok).
- `BH*` staging buffers keyed by payload size: `BHSK`(0x04: u32 in getters), `BHGK`(0x08: u64 setters), `BHLK`(0x10: 16-byte KB/strip payload), `BHGL`(0x0C: 12-byte `SetGamingLED`) — sizes match the MOF in-arrays exactly.

### 13.6 Impact for implementation
- Linux cannot ExecMethod from userspace: the missing surfaces (lighting ids 2/6/10/12/20/21, fan table 18/19, OC 24/25, APGe 61EF69EA, BatteryControl 21–23) all need the **M3 `psense-wmi` module** exposing a whitelisted `wmi_evaluate_method` proxy for these classes (kernel acer_wmi caps stay untouched).
- `GetGamingKBBacklight` (21) gives state read-back — first validation step after the module exists (read → mutate → read).
- `SetGamingFanTable` (18/19) — if it accepts a temp→speed vector, fans get an EC-native curve path; decode its u64 next (from AgentService/UWP binaries or live round-trip with the module).

### 13.7 Session-loss note
The 2026-10-17 server restart wiped `/tmp/opencode` (AML dumps, `bmfdec` tree, extracted `gaming.bmof`, PredatorSense 5.0.1.463 binaries, psapp tree). The decoded MOF was regenerated into `analysis/reference/gaming.mof.decoded.txt`. **Re-source required to continue binary RE:** the PredatorSense_5.0.1463 install tree + fresh AML dumps (`acpidump -s` + iasl) — original origin was user-provided; both were under /tmp.

### 13.8 REA evidence index (this section)
`ev_a4d20c9f…` (strip SetMode 16 B pack + log formats), `ev_b183acf4…` (KB SetMode pack, `0x103` device byte), `ev_7e10e6d6…` (service effect packer, d[9] per-state), `ev_89b4e540…` (per-zone method 6 + id-2 u64 constants), `ev_d6ed6eb6…` (logo color+behavior u64 + LUT), `ev_fc211d07…` (device probe/get). Binary digests: see §13.4 headers.

### 13.9 Module read-back root cause + live validation notes (2026-10-17 probes)
*(update: the "unanswered strobe" attribution for WMIB-family getters below is superseded by §13.11 — the strobe is answered synchronously; the zero returns were the module copy bug alone.)*
The first `psense-wmi` probe round-trip returned `AE_OK` with all-zero data for every getter. Attribution chain (all sources saved under `analysis/reference/upstream/`):

- **Root cause = module bug, not EC/AML state.** `wmidev_invoke_method()` (upstream `drivers/platform/wmi/core.c`, master ≈ 7.x) *ignores* the caller's output buffer contents and returns its own allocation in `out.data`/`out.length` — `wmi_unmarshal_acpi_object()` (`drivers/platform/wmi/marshalling.c`) `kzalloc`s fresh memory and sets `buffer->data = data; buffer->length = length` explicitly. `psense-wmi`'s eval ioctl was copying from the *caller-side* kalloc buffer (never touched → always zeros) and never freed `out.data` (leak per ioctl). Fixed in `src/psense-wmi/psense-wmi.c`: copy from `out.data`, guard `ZERO_SIZE_PTR`, `kfree(out.data)`.
- **Consequence for interpreting old results:** `out_used=8/8, 12/12, 16/16` etc. were *real* ACPI object lengths (`out.length` is authoritative); the data payload was ours-zeros. `out_used=8/64` (misc) and `4/64` (battery) were real Buffer sizes of the AML return storages `BHGK`(8)/`BHSK`(4) — proof the right `WMBH` cases ran despite zero data.
- **Core ABI (now code-confirmed, no longer inferred):** `wmidev_evaluate_method` builds params `[instance, method_id, input-buffer]` (core.c:342–358) and invokes `get_acpi_method_name(wblock,'M')` → `'W'+'M'+object_id` e.g. `WMBH`. sysfs `/sys/bus/wmi/devices/<guid>-<id>/<attr>`: `object_id=BH`, `instance_count=1` for the gaming GUID — the `-8` name suffix is just the wmi-bus device counter (core.c `wmi_dev_set_name`), *not* instance/instance-count.
- **WMBH case 5 (GetGamingSysInfo) decode from fresh dump (`analysis/reference/acpi/ssdt11.dsl` @1921/4195):**
  - `Arg1`=method id, `Arg2`=input buffer; case 5 runs *before* the switch: `d[0]` selects where the reply lands: `d[0]==0` → `BHGK[3..4]`, `d[0]==1` → `BHGK[1..2]`, `d[0]==2` → `BHGK[5]` (battery status u32 = `EC0.BTST`); `d[1]` = sensor id.
  - `d[1]==0` → **hard constant 0x0227 = supported-sensor mask** (bits 1,2,3,6,10 = CPU temp, CPU fan rpm, external temp 2, GPU fan rpm, GPU temp) — matches upstream `acer-wmi` sensor enum 1:1 (`ACER_WMID_SENSOR_*`). This is the ready-made "machinery fingerprint" probe: `eval id=5 in=00…0` must return bytes `27 02` at [3..4].
  - Sensor reads are **direct EC0 field reads, no SMI/mailbox**: `EC0.CTMP` (+0x58), `EC0.GTMP` (0x0A), `EC0.CPUF` (+0x5C, 16-bit **big-endian in EC RAM**; AML byte-swaps), `EC0.GPUF`. `GGSI` always `Return(Zero)` (status always OK).
  - EC offsets from `dsdt.dsl` @28161: CTMP=0x58, GTMP=0x59, ETP3/4=0x5A/5B, CPUF=0x5C–5D (BE), etc.
- **All other getters** (`misc 0x17`, fan table `0x18/0x19`, kb backlight `0x15`, …) end in `WSMI(Arg1, Arg2); <ret> = WMIB; Return(<ret>)` — i.e. fire request via `MTID=id, WMIB=input, WSSP=0xD0` strobe then copy whatever `WMIB` holds; the EC response is written into `WMIB` asynchronously (BIOS/SMI side). Zero `WMIB` on unanswered strobe explains those getters' zero returns *independent* of any bug.
- **Live cross-checks at probe time:** `hwmon4` = `acer` driver (acer-wmi) with temp=47000/44000 m°C and fan=1727/1750 rpm changing between reads → the *same* WMBH id-5 call path works from a kernel driver on this machine.

### 13.10 Artifact relocation (per user instruction)
All analysis artifacts now live in-repo: `analysis/reference/acpi/` (fresh `acpidump` tables + decompiled `.dsl`), `analysis/reference/tools/bmfdec/`, kernel sources pinned at `analysis/reference/upstream/` (`wmi_core.c`, `wmi_marshalling.c`, `acer-wmi-7.c` = torvalds master ≈ 7.x pulled 2026-10-17). `/tmp/opencode` is transient only (in-flight downloads → move into the repo once complete).

### 13.11 First validated live results (module fix round 2, 2026-10-17)
All commands via `tools/m3-wmi-eval.py` after the §13.9 fix + `rmmod`/`insmod`.

| call | in | out (real) | decode | cross-check |
|---|---|---|---|---|
| gaming id 5 | `00×8` | `00 00 00 27 02 00 00 00` | supported-sensor mask `0x0227` at bits 39:24 — the AML hard constant | = upstream sensor enum (1,2,3,6,10) ok |
| gaming id 5 | `01 01 00…8` | `00 2C …` | CPU temp = 44 °C at bits 8:23 | hwmon temp1 44000 m°C ok |
| gaming id 5 | `01 02 00…8` | `00 B8 06 …` | CPU fan RPM = 1720 (u16 LE at bits 8:23) | hwmon fan1 1720 rpm ok |
| gaming id 21 (kb-read) | u32 `1` | 16 B `00 00 05 64 00 01 00 AE C7 00 …` | KB state baseline; layout pending (plausibly [2]=mode-ish 5, [3]=0x64=100 → brightness); read layout ≠ 16 B *write* layout — resolve by set/read round-trip | — |
| gaming id 23 | u32 `0x0B` | u64 `0x600` | status 0 / **value 6 = ECO** (upstream profile enum QUIET 0 / BAL 1 / PERF 4 / TURBO 5 / ECO 6) | platform-profile current state ok |
| battery guid id 19 | u32 `0` | Buffer(4) `00 00 01 00` | `GetBattInfoInterface` raw (bit 16 set; semantics pending battery-MOF decode) | — |

**Synchronous SMI proved.** `misc-get` returned a valid response *on the very first call* → `WSSP=0xD0` strobe runs the SMI and the EC fills `WMIB` *within* the WMBH invocation; AML's immediate `WMIB` copy receives the fresh answer. The "stale/next-call" response theory is retired. Sensor getters additionally bypass the mailbox entirely (direct `EC0` fields — `GGSI`). Module `out.data` fix was the only defect; kernel/EC plumbing has no known gaps.

**Validation deltas vs spec:** spec §4 stamped (layout as decoded, incl. big-endian `CPUF`), §5 id-23 layout + profile enum added. Next: set/read round-trip for lighting (method 6 zone colors) to root the KB read-layout. — *closed in 13.11 round 2 below; integration + timings in 13.12.*

**Round 2 (2026-10-17, method-6 zone colors + getters):**
- **Method 6 write path VALIDATED on hardware:** four calls `d0=zone-bit(1/2/4/8), d1=R, d2=G, d3=B` with `FF 00 00` turned all four keyboard zones **red visually** (user-confirmed). `Psense-wmi` module + `WSMI` mailbox + EC = full write chain works live.
- **`GetGamingKBBacklight` (21) read-layout** (baseline → after red write): `00 00 05 64 00 01 00 AE C7 00…` → `00 00 05 64 00 01 FF 00 00 00…`. Round-2 analysis: `[2] = 0x05` (current mode id), `[3] = 0x64` (brightness 100), `[5..7] = RGB color 1` (baseline `01 00 AE` → `FF 00 00` after our write), `[8..10] = RGB color 2` (baseline `C7 00 00` → zeroed after write — mode 5 is apparently a two-color effect). Read layout ≠ 16 B write layout. Color-2/mode semantics to settle via `AcerECKeyboardController.dll` decode (binaries pending) — hypothesis logged, not yet binary-verified. *(Superseded in §13.12: the true layout is `[5]=const flag, [6..8]=RGB`; factory color = cyan-teal `(00, AE, C7)`.)*
- **Fan-table read (19):** AML case 0x13 calls **`OSMI(Arg1)` — the input buffer is NOT passed to the EC at all**; response = whatever the EC staged in `WMIB` (8 B staging header). Live reply byte0 = `1`. Your `in=0x1` is ignored by design.
- **Fan-speed get (17) returns 0 in AUTO mode** → consistent with "custom-speed register empty" (fans governed by firmware curve); mode switch to CUSTOM (id 14) + speed write (id 16) is the round-trip that should make the register non-zero — queued as the next validation.

**Round 3 (2026-10-17, fan behavior + speed round-trip — CPU fan):**
- id 15 baseline (in u32 `0x0009`, both fans): `00 41 …` = bits 9:8 = CPU AUTO(1) · bits 15:14 = GPU AUTO(1) — read-layout as upstream, live ok.
- id 14 set `d0=0x01, d2=0x03` (CPU→CUSTOM): BHSK status `00 00 00 00` = success; id 15 re-read `00 43` = CPU bits 9:8 = **3 (CUSTOM)** ok.
- id 16 set u32 `01 70 00 00` (fan 1, "0x70"): 4-byte input accepted; **rpm dropped 1796 → 1085** — physical effect on hardware ok.
- id 17 `fanspeed-get 0x01` after set: `00 70 …` — register round-trips byte-exact ok. Scale = **percent 0–100** (upstream interpolates pwm 0–255 → 0–100); our 0x70=112 was over-range and the EC echoed it regardless — daemon clamps to 0–100.
- id 14 restore (CPU→AUTO): BHSK status bytes 0000 (success); `fanspeed-get` **still** reports `0x70` after the switch; rpm read 1084 (≈ same as custom — ambiguous; idle auto at 47 °C could match). Discriminator closed in round 4: id-15 re-read `00 41` = both AUTO, rpm back to 1799 (≈ pre-test idle) — **restore applied; the custom-speed register persists benignly (inert under AUTO), matching upstream's `restore-mode` semantics.**

### 13.12 Daemon integration round (2026-10-17): `psensed` WMI ops live + the "wedge" post-mortem

**New surface (all live-validated on the first daemon battery):** `psensed` gained `/dev/psense-wmi` ioctl ops (`wmi.raw`, `kb.get`, `kb.zone.set`, `kb.set`, `fan.wmode/wspeed/wget/wmodes/wtable`) through a `WmiCtl` ctypes harness (`_IOWR('P',1,48)` = `0xC0305001`, native `=6I3Q` struct); CLI gained `psense kb get|zone|set`, `psense fan wmode|wspeed|wget|wmodes|wtable`, `psense wmi <guid> <mid> [hex]`. Fan write chain validated end-to-end *through the daemon*: id-14 CPU→CUSTOM, id-16 40 %, id-15 read-back `00 43`, restore → `00 41` + rpm 1799. Zone colors: `kb zone` × 1 and × 4 all `status 0` boards-confirmed.

**Timings (schema for §6):** single zone eval through daemon+CLI = **0.114 s** total wall (python startup ≈ 0.06 s → eval ≈ 40–50 ms incl. the module's 30 ms pacing); 4-zone op = **0.237 s** (~30 ms pacing + ~20–30 ms SMI/EC per eval). Eval latency is *not* the problem.

**The "wedge" (first daemon battery) — what we know:**
- Symptom: `kb zone` request timed out client-side (5 s) although LEDs did change; every later request got `timed out`, then `[Errno 11]` (connect EAGAIN, `listen(4)` backlog full); daemon stayed alive.
- Forensics at +10 min: process `S`, wchan `-`, kernel stack = plain `select` (idle accept loop); **dmesg clean** — zero ACPI/EC errors, module healthy.
- Re-test minutes later: identical 4-zone op = 0.237 s, fan ops instant. Same process, same code path.
- **Conclusion:** one zone-6 eval genuinely stalled in-kernel for minutes (old daemon blocked synchronously in its ioctl), then completed normally. Kernel did not wedge (clean dmesg, later calls fine). Trigger unknown; low-confidence hypotheses: EC contention with a concurrent acer-wmi hwmon poll (user-space temperature monitors read hwmon4 periodically), or cold-start strobe/SMI state. NOT reproducible in 3 subsequent runs.
- **Mitigation shipped regardless:** `psensed` re-architected — WMI ops run one-at-a-time on a dedicated worker thread; main `select` loop never blocks on a kernel eval (`listen(128)`, self-pipe completion, 25 s watchdog replies `wmi eval wedged` while further WMI ops fail fast `wmi busy`; hwmon/profile ops keep answering). CLI WMI verbs use a 20 s timeout. A repeat of the minutes-long eval can no longer take the socket down, and hwmon ops degrade gracefully.
- **Operational note (user-visible consequence of the wedge):** the wedged session's `fan.wmode custom` write *did* land (EC consumed it; only the reply was lost) — CPU fan remained in CUSTOM at 40 % until explicitly restored. Lesson for the spec: **write ops whose reply is lost must be treated as APPLIED-UNKNOWN until re-read** (`fan.wmodes`/`kb.get` are the direct truth queries); the `wmi busy` reply now makes undelivered-write ambiguity rare but the rule stands.

**Side datapoints queued for the binaries:**
- ~~kb-read `[5..7]` color-slots seemingly inconsistent~~ — **SOLVED by the daemon-integration round:** the user's post-amber read `00 00 05 64 00 01 FF 78 00 00…` re-roots the frame: `[2]=mode(5)`, `[3]=brightness(0x64)`, `[5]=constant flag (0x01)`, **`[6..8]=R,G,B`** — amber `(FF,78,00)` ok, red `(FF,00,00)` ok, black revert `(00,00,00)` ok, factory baseline `(00,AE,C7)` = cyan-teal ok. The old `[5..7] color1 / [8..10] color2` interpretation was an off-by-one misparse; `C7` was color-1's blue channel. Remaining read-frame unknowns: `[9..11]` (suspect speed/dir for moving effects) and `[4]` — both exercised by a mode-effect `kb.set` + `kb.get` round-trip, decode pending `AcerECKeyboardController.dll`.
- `psense wmi` raw input for misc getters (id 23) must be the **4-byte** u32 (`0b00000000`); 3-byte inputs are a construction error.

### 13.13 Predator Sense 5.0.1.463 binaries landed (2026-10-17, user-downloaded from official Acer CDN)

Zip: `analysis/reference/Predator Sense_Acer_5.0.1463_W11x64_A.zip` — sha256 `f065461f7c0230624640226c75e5a55780626caf844f4957ea6cd0818651d88c`, extracted to `analysis/reference/predator-sense/PredatorSense_5.0.1463/`. Source: Acer support page PHN16-71 → `global-download.acer.com` CDN link (acerid=638858095496061843).

Key binaries under `AgentService/driver/`, sha256 (all match the §13.4–13.6 recorded build → provenance closed):

| file | sha256 | decoder role |
|---|---|---|
| `AcerECKeyboardController.dll` | `6d8d75e6444c8282b7df90970ae5f49b3b48a36b7ba8327e92742bf811811826` | KB mode table, SetMode pass-through confirm, read frame `[4]`/`[9..11]` |
| `AcerECLightbarController.dll` | `8f2a1eda90c378af81b7476b8ce6ff0c1dc8eb6ae69b41172309fc782af39f88` | strip SetMode/zone-id semantics |
| `AcerLightingService.exe` | `ed8a02ad3de2ca53f76d283128d0828fd81c3f0f69b8ece2cd48e75c774ea0d4` | id-6/12/20 call orchestration, id-2 u64 constants |
| `AcerHardwareService.exe` | `3a43e7a9703a7222a84780276929db1a2b674a2492d8805a5d975da1df8cf471` | misc/profile façade, fan chain |
| `AcerCentralService.exe` | `dea0624b342e10c6fc21b0bfa1244f61c7e7ca9959fd7f816eb3b8ab4d212017` | battery interface (79772EC5 19–23)? |
| `AcerAgentService.exe` | `cc69f8e6dd7fc8c59f68b6900d1ca25be31444966a376e4e5d6879a09be77f35` | userspace agent |
| `PredatorServiceSoftwareComponent.sys` | `94a01fe68563aa078fc9a3eed0a13dce63f26bb955b27e0987c45eb2824c53ec` | kernel-side WMI stub — OC ids 24/25 + id-2 semantics candidates |
| `SunrexUSBKeyboard.dll` | `f02e26d1f831988ef7fdefee776502002fbfef1225e91f15fb73444d8304414f` | USB-kb fixture helper (low priority) |

Open decode targets (queued): KB mode table + read `[9..11]`; `SetGamingFanTable` (18/19) EC-staging meaning; id-2 u64 constants; logo LUT confirm; battery-interface (`00 00 01 00`) semantics; OC ids 24/25 (blocked in whitelist until decoded).

### 13.14 Binary decode round 1 (2026-10-17, Ghidra 12.1.4 via REA)

**Scope:** `AcerECKeyboardController.dll` + `AcerLightingService.exe` (+ `.sys` triage + INIs). All pseudocode/assembly evidence below is retained by REA with the cited Evidence IDs.

#### 13.14.1 `PredatorServiceSoftwareComponent.sys` triage
Not a WMI component. KMDF **"Acer Airplane Mode Controller"** (strings: `Acer Airplane Mode Controller device`, `AcpiNotifyCallback NotifyCode: %d`, FileVersion 1.0.0.6). No gaming-WMI logic, no OC tables. — ev (session-bound list_strings result). OC ids 24/25 decode moves to `AcerHardwareService.exe` / GPU-INI path.

#### 13.14.2 Shipped configs (text evidence)
- `AgentService/driver/RGBDevice.ini`: 21 RGB device hwids; `EC\ACPI1 → AcerECKeyboardController`, `EC\ACPI2 → AcerECLightbarController`; all USB devices `UsagePage=FF02/FF01`. Confirms the EC path = exactly the two OpenRGB EC plugins.
- `AgentService/driver/Predator PHN16-71.ini` (and siblings): **GPU OC offset tables** per PCI hwid (`Quiet/Default/Extreme=0`, `Turbo=100` core, `RAM_Turbo=200`) — these are the app values behind OC method ids 24/25. No lighting config anywhere else (grep for mode names across .ini/.json = negative).
- Bundle also ships a full **`OpenRGB.exe`** — the PredatorSense lighting stack is an OpenRGB-bridge (see below).

#### 13.14.3 `AcerECKeyboardController.dll` = OpenRGB EC keyboard controller (provenance closed)
Exports: `CheckDeviceStatus`, `CreateAcerECGlobalControllerClassInstance`, `CreateAcerECKeyboardControllerClassInstance`, `CreateRGBController_AcerECGlobalClassInstance`, `CreateRGBController_AcerECKeyboardClassInstance`. Strings: `ROOT\WMI`, `SELECT * FROM AcerGamingFunction`, `gmInput/gmOutput/gmReturn`, `SetGamingKBBacklight`, mode names `Direct/STATIC/BREATHING/SHIFTING/METEOR/TWINKLING`, log class `"AcerECKeyboardController::SetMode():"`.

**RGBController ctor `FUN_180007be0`** (ev_71c64e02) — six Mode structs built with `value` fields (= EC mode ids), flags `0x51` (0x53 for SHIFTING, 0x30 for Direct), and a constant tail `min_speed=1, max_speed=9, 0, 100, 5, 50` (two `Mode` dword slots: `0x100000001`, `0011(9)`, `0`, `100`, `dword{5,50}`) shared by STATIC/BREATHING/SHIFTING/METEOR/TWINKLING:

| mode | `value` (EC id) | flags | colors |
|---|---|---|---|
| Direct | 0xFF | 0x30 | — |
| STATIC | 0x00 | 0x51 | 1 |
| BREATHING | 0x01 | 0x51 | 1 |
| SHIFTING | 0x04 | 0x53 | 1 |
| METEOR | 0x06 | 0x51 | 1 |
| TWINKLING | 0x07 | 0x51 | 1 |

**Dispatcher `FUN_1800093f0`** (ev_5905cf74) — `RGBController_AcerECKeyboard::SetMode(index)`: takes `modes[index]` (stride 0x68), reads `value` at +0x20 → if `value != 0xFF` calls the controller SetMode with `(value, speed=+0x40, brightness=+0x44, direction=+0x48, colors→R,G,B bytes of `Mode` color block)`. **No LUT — EC id passes through verbatim.** Direct (0xFF) is deliberately skipped here (handled by the per-LED path).

**Zone setup `FUN_180008fc0`** (ev_5905cf74): a single `"Keyboard Backlight zone"` zone; LED count read from the controller object (`DAT_180014b90 = *(u32)(controller+0x20)`).

**Controller `AcerECKeyboardController::SetMode` (`FUN_180001aa0`)** (ev_5905cf74): packs the 16-B frame **`[0]=mode, [1]=speed, [2]=brightness, [3]=direction+1, [4..6]=R,G,B, [8]=0x03, [9]=0x01, [10..15]=0`** and calls the WMI wrapper (`ExecMethod "AcerGamingFunction"/"SetGamingKBBacklight"` side, `Sleep(30)` after). The **AcerECGlobalController::SetMode** variant (same fn family, ev_5905cf74) differs only in `[9]` = 3 (global) / 1 (keyboard, when `*obj==0`).

Warning: NOTE — this plugin's frame (RGB at `[4..6]`, `dir+1` at `[3]`) is the **experimental OpenRGB-bridge layout**. The *production* composer in the Windows service (§13.14.4) uses `RGB` at `[5..7]`, `direction` at `[4]`, `[3]=0` — the live-validated layout. Two senders coexist in the bundle; our kernel/CLI mirrors the production one.

#### 13.14.4 `AcerLightingService.exe` = production orchestrator + WMI composer
Class prefix `OpenRGBClient::` — the service hosts/bridges its own OpenRGB device objects; WMI calls via `TsWMI` (`ExecMethod("AcerGamingFunction", …)`; method name strings for ids 2/6/20/21 present: `SetGamingLED`, `SetGamingRgbKb`, `SetGamingKBBacklight`, `GetGamingKBBacklight`).

**Production composer `ECKeyboard::SetKeyboardBacklightEffect` (`FUN_14000b190`)** (ev_1ad4a5bc): signature `(ctx, realdev, mode, color(u32), speed, brightness, direction)`; 16-B frame from assembly (accepting addr math):
```
[RSP+0x30]=frame: [0]=mode (R14B)   [1]=speed (stack arg5)  [2]=brightness (arg6)
                  [3]=0 (BL==0)     [4]=direction (arg7)    [5]=color&FF  [6]=(color>>8)&FF  [7]=(color>>16)&FF
                  [8]=0x03          [9]=device {realdev==0 → 3 (global), ==1 → 1 (keyboard), else → 2 (strip)}
                  [10..15]=0        (16-B buffer zeroed by `MOVUPS XMM0`)
```
Special path `(realdev==0 && mode==0)` → resets via `SetGamingLED`-channel calls `(dev=1,len=4,mode=0)` + `(dev=2,len=2,mode=1)` then returns. **`Sleep(30)` confirmed service-side** (composer + LEDBehavior paths).

**Mapper `OpenRGBClient::OpenRGBSetMode` (`FUN_140013900`, 332 lines, ev_1ad4a5bc)**: incoming `(device_index, mode_value, speed, brightness, direction, color, colortype)`; `realdev = remap[device_index]` at `param_1+0x80`; clamps speed/brightness in Mode fields (+0x28/+0x2c min/max) and validates direction per Mode flags (`flags&0xe`, `&0x6`, `&0x2` gates, maxes 6/4/2). Generic branch stores `direction-1` into its Mode mirror; passes `direction` **verbatim** to the composer arg7. Special-cases device names `"AcerEC"`, `"AcerECLogo"`, `"FrontLightbar"→zone1`, `"RearLightbar"→zone4`; fallback log `"EC Device set STATIC mode!"`. Log line: `Real Device index=%d, mode value=%d, speed=%d, brightness=%d, direction=%d, color=(0X%X,0X%X,0X%X), colortype=0x%X` (field order corroborated by the composer arg order in assembly; Ghidra vararg capture imperfect).

**Threshold/restore path `OpenRGBClient::RestoreStaticEffect` (`FUN_1400117b0`, ev_1edc00e8)**: reads saved profiles (count `FUN_14000b0f0`), name-matches `"AcerEC"`, replays STATIC/DIRECT effects (only `active_mode < 2`), calling `SetKeyboardLEDBehavior(realdev, ledcount, colors[], brightness, devtype{FrontLightbar→1, RearLightbar→4, else 0})` — i.e. **the service restores saved state via id-2 `SetGamingLED` channel, never re-reading mode/speed/dir from the EC**.

**GET parser `OpenRGBClient::GetECKeyboardBrightness` (`FUN_1400159c0`, ev_1ad4a5bc)**: 16-B reply buffer in; **brightness = `reply[3]`**; **`reply[0] != 0 → report 100`**; logs every byte (`TsWMI::GetGamingKBbacklightFunction() output[%d]=0x%X`). Byte `[2]` is not interpreted here.

**Reply `[4]`/`[9..11]` verdict:** searched the service for any other consumer of the GetGamingKBBacklight 16-B buffer — none; the UI obtains mode/speed/dir from saved profiles, not the EC. Combined with AML (`WMBH` case 0x15 = `WSMI` + `WMIB→BHLK` copy, no AML-side transform — ssdt11 `ssdt11.dsl` case 0x15), **`[4]`/`[9..11]` are firmware-composed bytes with no Windows consumer → treat as RESERVED** in the protocol (`kb.get` maps only `[2]` mode-echo, `[3]` brightness, `[5]`=const01, `[6..8]` RGB).

#### 13.14.5 id-2 `SetGamingLED` wrappers (ev_9afcbf5a)
`ECKeyboard::SetKeyboardLEDBehavior` (`FUN_14000b3c0`, 15 KB):
- Inputs `(ctx, realdev?, len_param, colors_arr, brightness, mode…)`. `mode==0` → u64 constant `0x0000000F00000008` (`bytes [4]=0x0F`); `mode!=0` (on/restore) → u64 `0xFFF5000000000010` (`bytes: [0]=0x10, [4]=0xF5, [5]=0xFF`) — sent raw as the `SetGamingLED` u64 input (method literal `"SetGamingLED"`, WQL `SELECT * FROM AcerGamingFunction`).
- Color-carrying variant (mode==4 / sub-shapes on param_3 3/4/7): 16-B array `0xff…` with **bit flags derived from per-slot color presence** (`|1 |4 |0x10 |0x40` per color slot nonzero) — per-LED/per-segment behavior staging for MAG/Pre-Key/USB-kb effects (`"Update MAG_OFF/MOD effect"`, `"Update Pre-Key effect"` logs, `SetGamingRgbKbSettingFunction Zone%d` u64s with `|0x200`, `+0x20000000000`, `0x200000000000` constants → **strip zone ids carry `0x200/0x400/0x800` prefixes on byte5** — consistent with §6.2).
- id-2 remains whitelist-blocked; semantics now reference-grade (proof-of-concept capable if a `-danger` flag is added later).

#### 13.14.6 KB mode ids: 5-vs-0 resolution LOCKED
- EC table (binary consensus across both EC plugins): `STATIC=0, BREATHING=1, (strips: NEON=2, WAVE=3), (kb: SHIFTING=4), METEOR=6, TWINKLING=7, DIRECT=0xFF`. Unobserved: `5` (not used by either plugin — legacy/unused id).
- Prior §13.12 note "`[2]=5` with mode 5=STATIC" — **correction:** our earlier daemon wrote `mode=5` because of a misread of the UI-space mapping; `[2]=5` is therefore the EC's echo of *our own* write, not evidence that 5=STATIC. The EC echo of the last-written frame's `[0]` is the mechanism. Pending live probe (§13.15): write `mode=0` + `kb.get` → expect `[2]==0`, keyboard visually STATIC amber; write METEOR/TWINKLING to fingerprint animated ids visually.
- Spec §6.1/§6.3 updated accordingly.

### 13.16 Live probe round 3 (2026-10-17): the GetGamingKBBacklight reply is an echo mirror — layout SOLVED

Probes with the corrected production write frame (`[4]=dir verbatim`, ledger §13.14.4), all via daemon + new CLI aliases:

| action | write frame `[0..9]` | `kb.get` reply `[0..9]` |
|---|---|---|
| `kb set static --rgb 255,120,0` | `00 00 64 00 00 ff 78 00 03 01` | `00 00 00 64 00 00 ff 78 00 03` |
| `kb set static --rgb 0,255,0` (ack `0000`) | `00 00 64 00 00 00 ff 00 03 01` | `00 00 00 64 00 00 ff 78 00 03` ← color NOT echoed |
| `kb set static --brightness 50` | `00 00 32 00 00 ff 78 00 03 01` | `00 00 00 32 00 00 ff 78 00 03` ← `[3]`=bri echo |
| `kb set static --rgb 0,0,255` (ack `0000`) | `00 00 64 00 00 00 00 ff 03 01` | `00 00 00 64 00 00 ff 78 00 03` ← color NOT echoed |
| `kb zone --rgb 0,0,255 all` (id 6 ×4, ack 0) | u64 `{08h,00,00,ff,…}` | `00 00 00 64 00 00 00 00 ff 03` ← `[6..8]` = zone color |
| `kb set static --rgb 0,255,0 --speed 5` | `00 05 64 00 00 00 ff 00 03 01` | `00 05 00 64 00 00 00 00 ff 03` ← `[1]`=speed echo |

**Complete reply mapping (live + service-parser cross-checked):**

| reply byte | field | source |
|---|---|---|
| 0 | validity gate (0 observed; `GetECKeyboardBrightness` treats nonzero → report 100) | EC |
| 1 | **speed echo** (last 16-B write `[1]`) | EC |
| 2 | **mode echo** (last 16-B write `[0]`) | EC |
| 3 | **brightness echo** (last 16-B write `[2]`) | EC |
| 4 | spacer (write `[3]`=0) | EC |
| 5 | **direction echo** (last 16-B write `[4]`) | EC — explains the old "[5]=const 0x01" (was our `dir+1` byte) |
| 6–8 | **zone-color store** (LAST id-6 zone write wins; 16-B frame RGB does NOT feed it) | EC |
| 9 | **on-flag echo** (write `[8]`=0x03) | EC |
| 10–15 | 0/reserved | EC |

Key consequence: **the 16-B frame's RGB bytes are not applied to the keyboard's zone store** — ack is `0000` but the read (and presumably the visual) keeps the previous zone color. In STATIC the rendering palette = the id-6 zone colors (this is exactly how PredatorSense models the 4-zone keyboard: colors via zone writes, effect via the 16-B/LEDBehavior path). The 16-B RGB bytes matter for non-zone consumers (strips/logo/global) or animated-global effects — unresolved; treat as optional.

Also resolved from this round:
- Old §13.12 observations fully explained: `[5]=0x01` was the dir echo of our `dir+1` legacy writes; `[2]=5` was the mode echo of our legacy `mode=5` write; `[9..11]` unknowns were `[1]/[5]` speed+dir echoes — nothing unexplained remains.
- `psensed` `kb.get` parser had stale offsets (`rgb` = `[5..7]`): **fixed** to `[6..8]` + `dir`/`flag9` fields (needs daemon restart to load).


### 13.15 Fan-table / misc / battery round (2026-10-17, `AcerHardwareService.exe` + AML + MOF)
#### 13.15.1 Fan-table ids 18/19 (ev_f9af0777)
- `treadstone::TsClientCommandProcessor::wmi_set_gaming_fan_table` (`FUN_14000c840`): the u64 is a **verbatim pass-through** of the app payload (`ExecMethod "SetGamingFanTable"`, `Sleep(30)` paced); no interpretation service-side.
- MOF (authoritative): id 18 `SetGamingFanTable([in] uint64 gmInput, [out] uint32 gmOutput)`; id 19 `GetGamingFanTable([out] uint64 gmOutput)`. id 19 has **no u32 input** in the MOF — the 8-byte reply is the entire declared output.
- AML: `WMBH` case 0x12 (18) = `WSMI`; case 0x13 (19) = `OSMI(Arg1)` (`MTID=Arg0; WSSP=0xD0`) then `BHPK = WMIB; Return (BHPK)` — **`BHPK` is `Buffer(0x202)`** (514 B) staging, but the WMI layer truncates to the MOF-declared u64 → **live-verified 2026-10-17: `psense wmi gaming 19 --out 522` → `out_used=8`, reply `0100000000000000`** — a marker/staging selector, NOT a curve payload. The 514-B table never escapes via method 19.
- Conclusion: `SetGamingFanTable` u64 = a **selector/commit token**, not per-byte curve data. Custom-curve MVP stays on the userspace interpreter (spec §3.4); a future "EC preset curve" feature will drive the `WMAA` (603E9613) MODF path with the BR60–65 tables already extracted (`analysis/fan-pwm-tables.json`) — those *are* the real EC-side curves. The id-18 u64 semantics stay unresolved pending the UWP app's composer (not in this bundle).

#### 13.15.2 Misc/Profile (ev_fef24812)
- `wmi_set_gaming_misc_setting` (`FUN_14000e310`) + `wmi_get/set_gaming_profile_configuration` (`FUN_14000de50`, kSvcCmdWMISetGamingProfileConfiguration): again u64/raw-value pass-through — the app-side u64 layout for `SetGamingMiscSetting` (id 22) is not in this binary. Get (id 23 u32 · value-bits-in 15:8) remains live-validated (§13.11).
- Turbo-key plumbing present here (`Enable/Disable Turbo Key WMI SetGamingLEDBehaviorFunction input 2.86: …` + `SetGamingMiscSettingFunction input`) — the Turbo hotkey toggles an LED-behavior u64 *and* a misc sync event; useful model for §7 event handling, no new method surface.

#### 13.15.3 Battery (79772EC5) & battery-boost event
- No binary consumes the `79772EC5…` GUID (grep across the whole bundle: zero hits for `79772EC5`/`FE1DBBDA`); no MOF is shipped or registered from INFs. Battery UI = **AC/Battery-Boost event informers only** (`WmiEvent::Battery_Boost: %u`, `Check ACStatus and Battery boost`).
- Keep the existing boundaries: battery interface = whitelist **reads-only**, `00 00 01 00` id-19 read already validated (§13.11), semantics remain UNRESOLVED (spec §5 note: no further decode source available from Predator Sense 5.0.1.463).

#### 13.15.4 OC ids 24/25 (MOF text, reference-only)
id 24 `SetCPUOverclockingProfile([in] uint8 OCProfile, [in] uint8 OCStructure[512], …)` / id 25 `GetCPUOverclockingProfile([in] uint8 Reserved[4], [out] uint8 ReturnOCProfile, [out] uint8 OCStructure[512])`. GPU-side OC offsets for PHN16-71 live in `Predator PHN16-71.ini` (`Turbo=100` core / `RAM_Turbo=200` VRAM offsets, per PCI hwid). Whitelist keeps 24/25 excluded — OC write access blocked by design.

### 13.17 UWP/Electron GUI decode round 1 (2026-10-17): the Predator Sense UI payload landed
The 344 MB `UWP/5c20d4e8e3e24d0b8180c9e906196964.appx` (in-bundle sha256 verified at download) is **Electron, not XAML/UWP**. Extracted (repo-only, per relocation rule):
- `analysis/reference/predator-sense/PredatorSense_5.0.1463/UWP/asar-extract/app/resources/app.asar` sha256 `d62b93a4…` (122,323,811 B) → `asar-out/` (159 MB unpacked, via `npx @electron/asar`; the ENOENT storms listed are stray `app.asar.unpacked` node-gyp references, harmless — sibling `app.asar.unpacked` dir now also extracted, 32 MB).
- GUI structure: `dist/widgets/main/index.html` + `styles.4ff4983a2c9326e4.css` (155 KB, the whole theme: dark `#000000` base, Predator teal accent `#00c8ec`, `#f44336` red alerts, Material-ish palette) + ~30 webpack chunks. Fonts: **`Predator-Bold/Regular.otf`** + Noto fallbacks. Images incl. `light_kbzone.svg` (4-zone keyboard overlay), `light_kbzone3.svg`, per-key JP/UK/US maps, `btn_mode_normal|hovers|select` sprites, `BootLogo/`, `robot/fighter.glb` (3D mascot) in `app.asar.unpacked` = 16 MB glb.
- IPC vocabulary greps: `cpuFanSpeed`, `gpuFanSpeed`, `setLighting` invoke names found in chunks; `assets/i18n/en.json` is an empty scaffold (string defaults live elsewhere/in chunks).
- Value for the GUI phase: styles.css → Qt QSS port + Predator fonts + sprite/event SVGs = close-to-pixel look; `light_kbzone.svg` = in-UI live keyboard preview.

### 13.18 Live observation: thermal-profile writes re-colorize the keyboard (firmware-side link)
User observation (2026-10-17, GUI skeleton, platform-profile writes via daemon → ids 22/23 misc path): switching profile **low-power → quiet visibly changed the keyboard backlight color (green → amber)** with no explicit kb WMI write from the daemon at that moment.

Interpretation: the EC/firmware carries a **per-profile default keyboard palette** (same PredatorSense theming idea as Windows). Our id-20/6 writes are later/stronger overrides; the firmware re-applies its profile palette during profile changes (likely alongside the DPTF/NPCF reprogramming in `WMBH` case 0x16, ssdt11 §2).

Consequences:
1. The GUI/CLI KB state and profile state are NOT independent on this firmware — after a profile change, the in-app color state (and `kb.get` mirror) should be **re-read** beforeKB refresh logic assumes last-written colors.
2. This is a NEW hardware behavior not described in the BMOF — treat as observed fact, unverified mechanism (the profile→palette table is presumably another `WMBH` case/EC page; mapping it would need a targeted probe round: `kb get` immediately before/after each profile switch).

GUI bug fixes shipped this round (not RE): `profile.set`/`fan.mode`/`fan.speed` returns carry **no `status` key on success** — daemon error convention = presence of `error` key; Qt skeleton's success detection corrected accordingly.

### 13.19 Electron clone route (2026-10-17): the PredatorSense renderer + `ddsc` shim boots on Linux
Decision (user): "use what Predator Sense used itself" → **exact clone**: run the original Angular renderer (`asar-out/dist/widgets/main`, 114 MB, chunked, `index.html` + `styles.4ff4983a2c9326e4.css`) as an Electron app from the repo, replacing Acer's Windows main/preload with a shim.

Key renderer architecture (from `preload/ddsc.js` + stale `main.js` decode):
- Renderer's ONLY backend bridge = **`window.ddsc.<module>.<func>(...)`**. Their preloader connects to an **MQTT-over-WSS broker** (`wss://localhost:15150/mqtt`, aedes + websocket-stream, HTTPS pfx auth) and asks PWARuntime for `getAllFuncs({href})`; each listed func becomes an MQTT `ddsc` call. app root is served over HTTPS express (`https://localhost:6888|<port>/` + `composeParameters()` for query params).
- **Our shim** (`src/psense-electron/`): `preload.js` builds the same `window.ddsc` object directly from `ddsc-table.json` (inventoried 126 functions over `{appCenter:10, info:73, logIt:4, pssdk:7, scenario:7, util:25}` — inventory = every `ddsc.x.y(` occurrence in the chunks), routed via `ipcRenderer.invoke('ddsc-dispatch', module, fn, args)`; `main.js` hosts the original BrowserWindow config **verbatim** (1168×780, min 500×780, `frame:false`, bg `#002E40`, `nodeIntegration:true`, `webviewTag:true`, `webSecurity:false`, show-after-ready); `backend.js` implements dispatch → psensed socket ops + local scenario store (`~/.config/predator-sense-linux-scenario.json`) + Electron Notification/screen/local stubs; unknown funcs log loudly and return null.
- Original startup URL params (composeParameters, from main.js): `theme=<vfs.theme>&wssport=<port>&Planet9&isCNIP&Enable3d&EnableAvatarVideo&EnableAvatarApng&fps&reCreateHome&sku&devTool&showWhenReady` — shim passes `{theme:"dark", wssport:"0", Enable3d/Avatar*:0, fps:-1, sku:""}`.
- App state model: **scenario blob** (`scenario.getScenario/setScenario/saveScenario`, `profiles[]`, `active`) initialized per-page via `scenario.getInitialProfile("MUI_DAILY_USE")`-style template calls (returned `.name` is an i18n key), pssdk key/value device-data store is call-broadcast-driven (`ddsc.broadcast(funcName, data)` on writes).
- Renderer still loads `shared_assets/js/mqtt.min.js` (harmless, unused) and their preload was REPLACED (no broker attempt).
- First-boot milestone E1 = original UI opens; unknown-func log lines drive incremental mapping of Home/Fans/Lighting pages.

### 13.20 Lighting UI end-to-end (2026-10-18): EC static/speed contract + GTe/ScenarioChanged store semantics — UI→EC loop closed
Working session round driving the Pulsar Lighting page via `PS_CLICKS` synthetic mouse events + per-second capture sequence (`seq_*.png`), with `PS_TRACE=1` dispatch logging.

#### 13.20.1 EC: STATIC requires speed 0 (differential test, user visually confirmed)
- `kb.set {mode:0(SSTATIC) speed:3}` → ack `0000` but **register does NOT change** (reply stays old wave state). `kb.set {mode:0 speed:0 …}` → reply `[1]=00 [2]=00` — mode echoes and **user confirms Static renders** ("Orange/red static"):
  - STATIC (mode 0) + zone palette writes (`kb.zone.set` ×4 orange→red) = user-verified end-to-end.
  - reply layout re-verified: `[1]=speed echo, [2]=mode echo, [3]=brightness, [5]=dir, [6..8]=zone store` (§13.16 layout holds).
- `kb.set {mode:3 speed:3}` (WAVE) → user confirms **color sweep runs**; reply `[1]=03 [2]=03` — animated modes accept their UI speed verbatim; only the STATIC/animated divide is validated (mode 2 NEON untested on this machine).
- Consequence for the mapper: for non-animated modes (0/DIRECT) force `speed 0` — the EC silently rejects mode 0 with speed≠0. `psense` CLI default `--speed 0` is why every §13.16 probe worked; the GUI mapper (their payloads always carry speed 3) needed the normalization.
- Also: mode-3/DOES echo arrives only for the LAST completed write — an abandoned daemon call (client timeout) still runs to completion later and becomes "the last write". Never abandon a kb op mid-flight when testing.

#### 13.20.2 Renderer store semantics: LIGHTING = profile-shaped model, scenario broadcasts drive the UI
- `pssdk.getUpdatedDataParam(funcName, {device:N})` is a QUERY: the LIGHTING store keeps the **profile-shaped model** `{GlobalEffect, devices[]}`; the `vo` DP wrapper calls `refreshParam({device:this.device})` per device tab (chunk `class SP.refreshParam` + `vo extends SP` at ~1254200/1261169).
- Their writes are per-device entries and their broadcasts carry the ENTRY (`vo.setData` → `broadcast(fn.LIGHTING, entry)`), but the STORE must hold the model — a flat single-entry store breaks every re-derivation (page falls back to the profile default).
- **The UI selection reverts if the scenario object is stale**: `get LightingData(){ var e=this.profileLight.GlobalEffect; … }` — the Global KB page's selection derives from **`pss.CurrentProfile.lighting.GlobalEffect`** (chunk ~1991300), i.e., from the RENDERER's in-memory scenario object, NOT from the pssdk store.
- `class GTe extends vo { constructor(t){ super(t,"ScenarioChanged",null,null); this.refresh() } refresh(){ this._data = yield this._ddsc.scenario.getScenario() } broadCastDataChanged(){ this._ddsc.broadcast("ScenarioChanged", this._data) } }` — the renderer's scenario copy updates from EITHER `scenario.getScenario()` replies OR the **`broadcast_XSenseApp {eventType:"ScenarioChanged", param:[<whole scenario>]}`** topic. Settled contract for the shim: any backend scenario mutation must publish `ScenarioChanged` with the whole scenario object. With `mergeLightingEntry` (per-device merge into the model) + `persistLightingModel` (write the merged model into `s.profiles[active].lighting`) + the `ScenarioChanged` publish in `saveScenario()`, clicking **Static** in the UI holds the selection (verified 9 s, seq captures; two identical `setDeviceData STATIC` writes arrive — their confirm/re-apply loop after the scenario re-derivation — harmless).
- The click payload shape (GA event confirms `lighting_global_effect`): `{device:0, effect:"STATIC", speed:3, duration:3, direction:1, brightness:5, color:"#00aec7", random:true, LEDs:[], dyEffect:"WAVE", music_effect:1, subindex…}` — `device:0` = GLOBAL (LIGHTING_DEVICE.GLOBAL=0). Their AREA-page `onApplyEffect_v2` **rewrites `"STATIC" → WAVE`** for non-LOGO modes (`NotSkipStatic()`)— an app-level rule, not an EC one; our Global page never went through that path (payload stays STATIC).
- `getDynamicLighting` must return **null** on this platform: any truthy value triggers the "lighting controlled by Windows Dynamic Lighting" takeover dialog and disables the panels (they poll it in `Check_WinSettingChange`/page init).
- Shim tooling added: `PS_CLICKS="x,y,dwell;…"` (Electron `sendInputEvent` mouse injection — no xdotool needed), sequence captures `debug/seq_*.png` after each click (0.4/1/2/4 s + final), `TOUR_STOP=<tab>` stops the tour on a page, `PS_TRACE=1` logs every `ddsc <module>.<fn>` dispatch (706k-line storms = 1 Hz pump; grep LIGHTING/scenario only).
- Known unchanged behavior: personal-settings tour capture still shows Home (router race at 4.5 s waits) — non-blocking.

### 13.21 Monitoring + App Center pages live (2026-10-18); XDG-backed App Center; RAM/DMI
- **Monitoring page fully live**: GPU/CPU panels (temps, usage, fan rpm, freq, min/max tracks), System panel (temp, RAM 6.7 GB 43 %), all from our 1 Hz `UPDATE_MONITOR_DATA`.
- **RAM Frequency = SMBIOS**: newDaemon op `memory` walks `/sys/firmware/dmi/tables/DMI` (type 17): populated DIMMs → `configured MT/s` (fallback `speed`); PPHN16-71: 1×16 GB, 4800. The Electron monitor builder caches it 60 s and sets `RAM_FREQUENCY` (their "MHz" = MT/s). Memory-type byte table corrected to SMBIOS codes (26=DDR4, **34=DDR5** — first firmware restart needed for the label-only fix). Net rates: `/proc/net/dev` deltas gate ≥500 ms; wifi = `w*`, eth = `e*` prefixes (lo/docker/veth excluded) — ping-verified ~24 KB/s deltas (earlier 0.0 Kbps was a wrong gateway IP in the test, not a shim bug).
- **App Center = XDG library (Linux mapping of their Windows appCenter)**:
  - object contract: `{id, name, display, linkTargetParsingPath, packageInstallPath, iconKey, categories, appUsageInfo{usageCount,lastInvoked}}` — `linkTargetParsingPath` is the matching key everywhere (their `checkPinApp`, pin includes-matching); `packageInstallPath` REQUIRED as a string — their WSINFO scan does `.toLowerCase()` on it when probing acerliveart/alterview (crashed originally).
  - scan = /usr/share/applications, /usr/local/share/applications, `%H/.local/share/applications`, snapd/flatpak export dirs; `.desktop` parser keeps `Type=Application`, drops NoDisplay/Hidden, localized `Name[en*]` override; dedupe by id.
  - `getAppIconDataUri(app)` → data-URI (svg|png; xpm skipped) from hicolor/Adwaita/pixmaps/flatpak-theme index; failing icon → null placeholder.
  - `LaunchApp(app)` → exec `.desktop Exec` with field-codes stripped, detached child. **GUI-confirmed: clicking a card spawned Firefox** (their `ExcuteApp` path).
  - filter enums (decoded): sort `Go={Popularity0,Alphabet1,LastUsed2,InstallationDate3}`, filter `Xn={All0,Preload1,Game2}`; `getAppCenterFilterByType` → `{filterBy:0, SortBy:0}` (their own defaults `{filterBy:1, SortBy:0}` BUT Linux has no PreloadList — All keeps cards visible); setX persists KV; Scenario-dialog filter variant separate.
  - `get/setPinApps`, `get/setUserApps` persist whole app objects via KV (`~/.config/predator-sense-linux-info.json`); `getAllAppUsageInfos` → [] (usage tracking not wired — sort-by-popularity falls back to display compare); `getAllWidgetApps` → [].
  - labeling: the "MUI_APP_CENTER_…" raw keys were resolved by actually providing the enums (label = `"MUI_APP_CENTER_"+FilterByType[filterBy]`).
- **Onboarding/tutorial gating is per-key now**: `util.getTutorialShow(key)` / `setTutorialShow(key, val)` → KV `tutorial.<key>` (their overlay flows: App Center intro guarded by `getTutorialShow(Lo.appcenter)` → set true after first open; Home has a separate New Features Guide overlay). Overlays observed in GUI and manually dismissed.





### 13.22 Packaging + installed-tree validation + battery/misc probe notes (2026-10-18)
- **Packaging shipped** (`packaging/`): `install.sh` (full/--unit/--gui/--remove), `psensed.service` unit template, `predator-sense.desktop`, `gen-icon.py` (brand icon composited from their own `light_area_coverlogo@2x.png` on a dark tile; committed PNG artifact), `predator-sense.spec` + `make-tar.sh` (RPM path, optional — install.sh is the primary). Layout: CLI → `/usr/local/bin/psense`, daemon → `/usr/local/sbin/psensed`, unit → `/etc/systemd/system/psensed.service`, GUI → `/opt/predator-sense` (bundled electron 44.9) with launcher `/usr/local/bin/predator-sense`. GUI dir is chowned to the invoking sudo user (personal-box posture: app writes `~/.config/predator-sense-linux-*.json` and the PS_* debug dir next to itself).
- **Installer bug fixed the same day**: `--gui` froze psensed for a consistent copy and never restarted it — now it snapshots `is-active` BEFORE the stop and restarts afterwards. (Observed live: the first verification boot ran with the daemon stopped; the GUI pumps sensors via its own readAcOnline/sysfs fallback so the session still rendered — the daemon-refusing signature was the missing `/run/psense.sock`.)
- **Boot-time lighting apply (service parity)**: their flow applies at the AcerHardwareService; ours now applies the ACTIVE scenario profile's lighting 5 s after the shim's pump starts (`backend.js startPump` → `applyLightingWrite(profile.lighting)` — STATIC goes through the zone palette, then the 16-B frame). GUI-confirmed from the installed tree: kb.set + zone.set at +5 s. This is a self-heal for drift (EC register survives reboots, so normally a no-op diff); without it the boot's `INITIAL_LIGHTING` desktop message did NOT reach the EC — decoded chain: `CheckSupportLighting` → `dataModel.InitialLighting()` only creates vo wrappers (`InitialLighting(t,e)` calls **no** `getUpdatedData` — verified: the boot's `getUpdatedData` burst is exactly the 12 non-lighting keys of the dataModel ctor). The EC apply at boot is service-side semantics, renderer-side is display-only. Ledger §13.20's "boot wave re-apply" was in effect a pass-the-buck from an earlier direct write session — the semantics are now explicit.
- **EC register echo semantics re-confirmed (CLI round-trip)**: `kb.get` reply slots mirror the LAST COMPLETED write (`[1]=speed [2]=mode [3]=brightness): after `kb set 0 --speed 0` the reply showed `mode=0 speed=0`. An abandoned-but-completed write's echo can precede the next get (this is why a stale WAVE echo appeared after boot until the CLI round-trip re-anchored the state). `--brightness` is the RAW register byte (0..255, their UI 0..5 ×20); CLI help updated.
- **BatteryControl (79772EC5) probed read-only** (all 4 GETs live): id 19 = Buffer 4 (`BEBI`, AML forces byte[2]=1) · id 20 = Buffer 8 (`BEGB`, AML forces byte[1]=1) · id 22 = Buffer 16 (`BEGD`, forces byte[0]=1) · id 23 = Buffer 4 (`BESD`, forces byte[0]=1). All live bytes returned 0 (idle states). The SET side (id 21 = `BESB = WMIB` + flag) has **no decoded payload semantics** — and per §13.15.3 the Windows bundle never calls this GUID. DECISION: charge-limit probing parked to the AC-power session (needs a careful set/observe/restore round-trip with battery monitoring; no need for exact-clone parity since their app doesn't use it).
- **Gaming misc opcodes (SSDT11 `WMBH` case 0x16/0x17) decoded**: opcode = `Arg2[0]` of the staged buffer. `0x0B` = operating mode: SET maps `Arg2[1]` 0/1/4/5/6 → DPTF `ODV0` 1/0/2/3/4 + `Notify(IETM,0x88)` (+ on dGPU present writes `NPCF.AMAT/ATPP/ACBT` from `M1*/M2*/M3*` power tables — OC/power-plane side effects); GET `0x0B` already live-validated = profile (§13.11). winKey/backlight-30s/boot-sound/LCD-overdrive opcode numbers are NOT in any binary we hold — their pssdk service composer builds the u64 and the misc u64 layout remains the last undecoded surface. Consequence: Scenario→Advanced Settings stays an EMPTY page = parity with a null-capability profile (their page gates on `HWSupport.LCDOverdrive.data`/`GPUMode`/DustDefender/eSIM/Customer Logo providers; our `getSupport*` all return null — the exact clone behaves like a machine with no capabilities claimed).
- **Fan tab dials = monitor RPM live** (`monitorData.CPU_FANSPEED/GPU1_FANSPEED` — the 4138/4146 on the fan-tab capture is a real load ramp from the capture runs, not a mapping bug). Fan Mode buttons feed from `supportedFanMode` provider; Max/Custom correctly AC-gated in their layer (grey while on battery).
- **RAM frequency = SMBIOS op** (`memory` — daemon walks `/sys/firmware/dmi/tables/DMI` type 17): GUI Monitoring now shows 4800 MHz (their "MHz" = MT/s), 1 populated DIMM. Memory-type label fix (34=DDR5) required the daemon restart — installed post-restart, label returns DDR5 correctly.
- **XDG App Center icons**: GNOME apps carry icons in **Adwaita** themes more often than hicolor — the icon index scans hicolor+Adwaita+AdwaitaLegacy × sizes × apps/mimetypes + pixmaps + flatpak export dirs; Firefox/Brave/ChatGPT/Files etc. resolve (png+svg data-URIs verified in the standalone harness).
- **Checkup page renders** (hero Check-All, Battery + RAM cards, Optimize Battery panel): RAM usage live from `monitorData.RAM_USAGE` (45.8%); battery card shows "Unchecked" / 0% — its `wdi.BatteryValue`/`BatteryUsageprcentage` come from the **wsinfo provider** (`info.getBatteryLastCheckedInfo` + the 5141 DeviceInfo channel our wedge answers with the EC-bypass error 1007). Real Checkup features (battery calibrate, RAM/storage checks, QuickClean) are Windows-agent features — honest empty state for now; the honest Linux path later = daemon-side `smartctl`/memtest surfaces wired to their Check actions (a follow-up, not pseudo-data).
- **System Info sub-page** matches the SKU header ("Predator PHN16-71") — fields `BiosVer/OSVer/Processor/RamList/StorageArray/GraphicArray/MEDIAArray/NetWork` come from the renderer's wsinfo adapter methods (`getSMBIOSInfo`/`getOSInfo`/`getSystemInfo`/`getStorageInfo`/`getDeviceManagerInfo`/`getNetworkInfo`) which delegate to the 5141 `DeviceInfoI3d` object — an undecoded-but-ours-to-fill protocol: the renderer's real adapter (`DeviceInfoI3d.OS.OSEdition`, `DeviceManager[].ClassName=="Display"/"MEDIA"`, `MotherBoard`, `Storage`, `Network`, `BatteryHealthy`…) and the SIMULATOR adapter fixture shapes (`readData("os").OSEdition` etc.) are both IN our bundle (@~840k/@~855k) — the reply-envelope parse for the wedge is the next decoding target; honest Linux data (SMBIOS, dmidecode, lspci, os-release, network ifaces) folds into the same wedge answers.

### 13.23 wsinfo / DeviceInfoI3d protocol DECODED + honest-data wedge LIVE on all three ports (2026-10-18)
- **Packet contract** (renderer `main.8ed9dc924c527068.js`): enum `ho` @821189 — `AuthPacket=1, RequestPacket=2, ResponsePacket=3, ErrorPacket=9`. `Version:1` everywhere. Flow: AuthPacket(1) handshake ("Handshaking successed") → `{"PacketType":2,"Command":"FunctionQuery"}` → ours replies `PacketType:3` echoing the **request Session** with `Data` (array of supported commands) + `ServiceVersion` → then per-command Get (`Action:"Get"`) → ResponsePacket. Errors = `{"PacketType":9,"ErrorCode":1007}` (renderer logs `BIOS returned error: EC bypass request.`). `Action:"Notify"` bypasses the SessionCheck (QS base @824412, SessionCheck @827830; wsinfo class @1237490). Command enums: DeviceInfoI3d = `x2` @760877 (SystemInfo/SMBIOS/DeviceManager/MotherBoard/OS/Storage/StorageVolumes/Network), CareCenter = `Zi` @761223 (BatteryStatus/BatteryHealthy/CheckBattery/CheckStorage/CheckMemory/BatteryCalibration/QuickCleanup/CleanDisk/BatteryAdaptiveCharging/BatteryBoost).
- **Wedge (main.js)**: ports 4449 (DeviceInfoI3d) + 4343 (CareCenter) rewritten into wsinfo servers on the Linux shim (5141 QuickAccess keeps its EC-bypass 1007). FunctionQuery replies: 4449 → `Data=[SystemInfo,SMBIOS,DeviceManager,MotherBoard,OS,Storage,Network]`; 4343 → `Data=["BatteryStatus"]`. Every named Get → ResponsePacket with an honest `Result` from the daemon `sysinfo` op; unknown commands → 1007. Battery additionally receives the 30-s `Action:"Notify"` push on 4343. `sysinfoData()` in main.js wraps the dispatch with in-flight dedupe (renderer fires 4 GETs in parallel).
- **Data source — new psensed op `sysinfo`** (`backend.js HANDLERS.psense` → `daemonCall("sysinfo")`; serial/UUID handlers also switched to it; 30-s instance cache + root-only op because of `/sys/class/dmi/id/*`). Notes: Python 3.14 dropped `socket.ioctl` → `fcntl.ioctl(fd, 0x8915, ifreq)` for IPv4; `/proc/net/if_inet6` is little-endian quirky — reverse each 4-hex group, join with `:`, skip `fe80` (shipped colonized full form `08ef:0000:0000:…`); pci.ids match via kernel modalias `pci:vvvvvvvvdddddddd…` → vendor `[9:13]`, device `[18:22]` compared lowercase, `#`-comment blocks skipped; audio MEDIA device from `/proc/asound/cards`; GPU name from `nvidia-smi` (RTX 4050 OK) with lspci fallback.
- **Result shapes** mirror the SIM fixture blocks (@809794–810923) so the renderer binds with zero changes: `os{OSEdition,OSBits,OSVersion,OSBuildNumber}` · `storage[{Model,Type,TotalSizeMB,UsedSizeMB,Serial,LogicalDisks[{Drive,TotalSizeMB,UsedSizeMB}]}]` · `network[{Name,IPv4,IPv6,MACAddress}]` · `SystemInfo{CPUName,CPUCores,RAMSizeMB,RAMType}` · `SMBIOS/MotherBoard{ProductName,BIOSVersion,BIOSVendor,…}` · `DeviceManager[{ClassName,DeviceName,DriverVersion,Manufacturer,HardwareID}]` (`Display/MEDIA/DiskDrive/Processor`).
- **LIVE verification, installed tree (`/opt/predator-sense` cwd, daemon restarted with the colon fix)** `[seq]` captures + logs:
  - Log flow green: 3× "Handshaking successed"; 4449 `GetFunctionQuery SUCCESSED … SystemInfo,SMBIOS,DeviceManager,MotherBoard,OS,Storage,Network` → all four system GETs answered PacketType 3; 4343 BatteryStatus Get answered + Notify pushes; 5141 FunctionQuery → ErrorPacket 1007 (observed `BIOS returned error: EC bypass request.`) = intended parity.
  - **System Info page populated 1:1 with /sys** (`debug/seq_4_final.png`): Predator PHN16-71 · BIOS V1.20 (INSYDE) · OS "Fedora Linux 44 (Workstation Edition)" · i7-13700HX / 24 · Memory 16 GB [DDR5] · Storage 1001 GB SAMSUNG MZVLB1T0HBLR-000L7 [SSD] · Graphic NVIDIA GeForce RTX 4050 Laptop GPU · Audio1 "Intel – HDA Nvidia" / Audio2 "hda-dsp – sof-hda-dsp" · Network1 Killer E2600 (MAC 74:D4:DD:**:**:**, redacted) · Network2 CNVi Wi-Fi IPv4 192.168.1.** (RFC1918 pool, redacted), IPv6 (mangled form redacted — was a triple-broken rendering of the link-local address, personal), rand MAC 2E:79:B2:**:**:** (GNOME randomization — expected). **(Amend 2026-10-18, §13.27-day: that IPv6 string was triple-broken in `psensed` — per-hextet `[::-1]` reversal (fe80→08ef is the give-away), the fe80 skip therefore never fired, no RFC 5952 compression; the value rendered was a mangled form of the *link-local* `fe80::ebf3:6dc7:ade6:5bc5`. Fixed: /proc/net/if_inet6 parsed as display-order nibbles, link-local skipped on the raw string, output via `ipaddress.IPv6Address` (RFC 5952). This network has no global v6 today — the field is now honestly empty until one exists.)*
  - **Checkup battery card tracked the physical power state across the session** (`debug/seq_4_final.png` second run): on-AC earlier = ~97 % Charging → after unplug = **72 % + "1 hours 23 minutes remaining"** (RemainingSeconds live from /sys). Best possible proof the 4343 channel carries real data, not fixtures; RemainingSeconds is correctly `-1` while on AC.
  - Storage card "354 GB remaining, 626 GB total", RAM Usage 56.8 % (ddsc monitor path); Battery/Storage/RAM health tiles honest **"Unchecked" / "Last checked on: -"** (CheckBattery/CheckStorage/CheckMemory not advertised — Windows-agent features).
  - Renderer noise unchanged: pre-init `GetCountry` TypeError (line 80, before any wsinfo traffic) and "NaN MB releasable disk space" (renderer-initial QuickCleanup calc for an unadvertised feature) — no new TypeErrors from the wedge (grep ERROR=0).

### 13.24 Checkup Check-buttons LIVE: honest Battery/Storage diagnostics + RAM failure posture (2026-10-18)
- **Check-dialog protocol decoded** (shared dialog component `K9`, `Command` = CheckBattery|CheckMemory|CheckStorage|CheckAll): start = `Action:"Set"` (battery/ram) or `{Action:"Set",Param1:<DiskIndex>}` (storage, index from CareCenter CheckStorage list); cancel = `Action:"Abort"`; completion is driven ONLY by an `Action:"Notify"` packet whose **`Data`** (not Result) carries `{Progress, EstimatedSeconds, HealthStatus}` — `Progress==100 && EstimatedSeconds==0` → dialog finishes, persists `LastCheckedInfo` KV itself (`setBattery/Storage/RamLastCheckedInfo`, epoch-seconds STRING timestamps), `Health==1` → warning-list; reps in the K9 template: **Health 0 → "Good", else → Attention Required**, `HealthStatus` sanitized to ∈{0,1,-1} by their wsinfo class; adapter forwards **every** `Action:"Notify"` packet unconditionally into `checkObservable` (after the BatteryStatus/BAC/BatteryBoost special cases), and ALL ErrorPackets too — BUT their `ResponsePacketHandler` checks `Action=="Set"` FIRST, meaning a PacketType 9 reply that carries `Action:"Set"` is swallowed into a silent auto-Get (found live: first RAM attempt stuck at "Checking… 0%" — error replies must omit the Action field). Adapter ACK of `Action:"Set"` triggers their auto re-GET of the same command — the wedge uses this to refresh the tiles' `CheckStorage` list.
- **CareCenter advertising widened**: FunctionQuery Data = `BatteryStatus, CheckBattery, CheckMemory, CheckStorage` (burst GETs arrive via their GetAll; all four answered — Storage list shape `{DiskName,DiskIndex,MediaType,TotalSizeMB,Healthy,DriveLetters}` mirrors the sim fixture; MediaType enum = `Ov` @762380: HDD=3, SSD=4, NVME=6). `getStorageLastCheckedInfo` KV list drives 15-min replay (`isWithin15Minutes` + `LastActivityTime`), so a check once done reads back from KV like theirs.
- **psensed `health` op (root)**: battery = design-vs-full ratio ≥80 % → 0 else 1 (charge-vs-energy µAh/µWh quanta — ratio is unit-based honest; this battery reports 102 % factory tolerance + 466 cycles); storage = per-disk `smartctl -H /dev/<n>` verdict → PASSED 0 / FAILED 1 / unknown −1 (§13.23-style /sys/block enumeration, media code from `queue/rotational`+nvme); ram honest `{health:-1}` — no Linux runtime memory diagnostic exists (Windows Memory Diagnostic analog; memtest is boot-media territory). `smartctl`+`nvme` are installed on this host (pre-req satisfied).
- **Live-verified on the installed tree** (`/opt/predator-sense`, daemon `health` op live; logs `health*.log`, [seq]):
  - **Battery Check** → ACK Set + Notify(100/0/0) → dialog "Battery Health Status: **Good** 2026/10/18 11:48:30", side tile flipped to Good + timestamp instantly (their KV persistence + the Set-triggered list re-GET).
  - **Storage Check** (Param1 0 → smartctl `PASSED` → health 0) → "**SAMSUNG MZVLB1T0HBLR-000L7 Health Status: Good** 11:51:00"; tile Good; KV persisted ACROSS processes (next run's page showed it).
  - **RAM Check** → PacketType 9 / ErrorCode 1004 (no Action field!) → dialog "**Diagnostic Failed — Error 1004**" (their own error template), tile stays honest "Unchecked". This is the honest substitute for the unreachable Windows Memory Diagnostic.
  - **Checkup All** → battery Good → RAM 1004 **skipped by their own CheckAll loop** (`9==PacketType && CheckAll → next item`) → storage Good → "Diagnostic finished — All hardware is good…" summary (their template; RAM simply remains Unchecked in the tiles).
  - Renderer noise = only the pre-existing GetCountry line; Abort path implemented (`Progress 95/EstimatedSeconds 1` → their cancel branch closes silently, unpersisted) — not exercised live (our checks complete instantly).
- Honest-mapping notes: check details (`BatteryFullRaw/BatteryDesignRaw/BatteryRatioPct/BatteryCycleCount`) are ours (renderer binds none of them — the check `Battery` `Result` is stored-but-unbound); the tile "Good" verdict descends from our true capacity-ratio/smartctl outputs only. QuickCleanup/CleanDisk/BatteryCalibration/BatteryAdaptiveCharging remain unadvertised (Windows-agent features; §13.22 posture unchanged).

### 13.25 Battery charge mode (CareCenter `BatteryHealthy`) DECODED END-TO-END + honest EC-backed implement (2026-10-18)
- **Correction to §13.15.3**: the "no binary consumes the 79772EC5…" statement was scoped to a PredatorSense-bundle grep. The CareCenter service component **`AcerCCAgent.exe`** (shipped inside the same installer, `analysis/reference/predator-sense/PredatorSense_5.0.1463/AcerCCAgent/`) is the real charge-mode consumer — its `OnGet/OnSetBatteryHealthyPacket` (`i3d::ACCAgentSvis`, QuickAccess framework rebadge) never touches `79772EC5`.
- **The hardware surface is the misc family we already own** (`AcerGamingFunction` `7A4DDFE7…`, `WMBH`):
  - **GET** — method id **23** `GetGamingMiscSetting`, `gmInput` = u32 opcode **`0x02`**; out `[0]=SMM status`, `[1]=mode`. REA chain: log-string xref → `FUN_14033bc50` (`FUN_14033ddf0(param_1, 2, &out)` — the literal `2` opcode; wrapper tail parses `gmOutput`, `*out = (value>>8)&0xFF`). Same out layout as the thermal GET (§5), complementing the GGSI read side (`\_SB.PC00.LPCB.EC0` sensors / `BTST` family).
  - **SET** — method id **22** `SetGamingMiscSetting`, `gmInput` = u64 `(value<<8)|2` → bytes `[0]=0x02, [1]=0/1/2`. REA chain: log-string xref (`OnSetBatteryHealthyPacket` at `0x14038c8d6`) → setter wrapper `FUN_14033b490`; failure log pair `"() enable/disable optimized battery charging failed, error = "`.
  - **AML verdict (ssdt11.dsl `WMBH` case 0x16/0x17 @4192–4476)**: `0x02` rides the generic `WSMI(Arg1,Arg2)` staging (`MTID`/`WMIB` + I/O port `0xD0` SMM round trip); **no DPTF `ODV0` / `NPCF M1..M5` side effects at opcode 0x02** (those branches fire only for profile writes `0x0B`). So charge-mode writes are exactly as risky as the Windows app's own click.
- **Embedded protocol manual extracted** from the CC agent (the full CareCenter JSON contract, 16 commands) → **`analysis/reference/predator-sense/ccagent-protocol-manual.json`**. New facts beyond the renderer: `BatteryHealthy Get Result` = `Value 0|"Optmized Battery Charging enabled" (their typo) / 1 Full / 2 Adaptive-learning`, Set `Param1` same enum; `BatteryAdaptiveCharging` Get = `{AdaptiveCharging,Start{Hour,Minute},Stop{Hour,Minute}}` + Notify `{EventId}` (+ `sendStopBAC` sends `{Action:"Set",AdaptiveCharging:false}`); `CheckMemory Get Result` = `{TotalMemoryMB,NumberOfBanks,TestInProgress,HealthStatus}` (**main.js RAM GET aligned to this shape**, honest filler from DMI: totals+banks, `TestInProgress:false`, `HealthStatus:-1`); `BatteryStatus Notify` = Get shape (wedge already matches); QuickCleanup/CleanDisk/BatteryCalibration/BatteryBoost shapes recorded for future work.
- **Renderer contract** (primary bundle): `Zi.BatteryHealth→"BatteryHealthy"`; GET reply consumed as `this.BatteryHealthy = t.Result.Value` (init `-1`); SET request = `sendRequestPacket(Zi.BatteryHealthy, v)` → `{PacketType:2,Action:"Set",Param1:v}` (generic builder @825513); **every FunctionQuery-listed command is auto-GET on connect** (`FunctionArrayUsage.forEach(sendRequestPacket)`); Set-ACK (`Action:"Set"`) triggers their auto re-GET — the wedge ACKs exactly like CheckBattery. Charge-mode cards bind `BatteryChargeMode` = **default `[Optimized, Full]`**; the AI-Smart card (and the whole BAC scheduler panel) appears only when the backend `getFeature()` string contains `ABC`/`BAC` — **we do not emit those flags**, so mode 2 stays honestly invisible (its scheduler = their service's learning loop; no Linux equivalent). The `updatePersonalsettingsArray()` tail condition mentioning `BatteryHealthy` decompiles to a no-op expression (terser artifact) — the Personal-Settings Battery section is unconditional.
- **Wedge shipped**: FunctionQuery 4343 now advertises `BatteryHealthy`; handler maps GET → `battmodeGet`, SET (Param1 ∈{0,1}) → `battmodeSet` + ACK, failure → **PacketType 9 / 1004 without Action** (§13.24 GOTCHA). `psensed`: `battmode.get` (id 23 in `02000000`), `battmode.set {0|1|2}` (id 22 u64) with built-in EC read-back (`reported` echoed; module allow-mask `gaming 0x00FFFFFC` already covers ids 22/23 — **no kernel change needed**). `sysinfo.ram` gained `banks` (DMI DIMM count) for the CheckMemory shape. backend.js routes `battmodeGet/battmodeSet`.
- **Live verification — GET ok / SET not validated (read-only-honest)**:
  - GET: `psense battmode.get` → `{"status":0,"raw":"0003000000000000","smm_status":0,"value":3,"known":false}` — the EC answers the opcode-0x02 GET live; value **3 = "never set" on this EC** (renderer shows no selected card — honest unbound state, incl. while charging on AC).
  - GUI loop: FunctionQuery advertises `BatteryHealthy` → their auto-GET fires on boot AND periodically (~45–60 s) → `{Result:{Value:3}}` consumed (`case Zi.BatteryHealthy: this.BatteryHealthy = t.Result.Value`). Personal Settings → "Battery & Charge" renders both honest cards (Optimized [Recommended] 80 % / Full) with **no AI-Smart card** (feature flags `ABC`/`BAC` not emitted) and no selection ring (value 3 never binds).
  - SET: GUI click "Optimized" → `{Action:"Set",Param1:0}` → wedge → daemon `battmode.set` → id-22 u64 `0200000000000000`: `status:0`, out = 4-byte **input echo** `02000000` (BMOF `gmOutput` = u32 scalar) — the SMM never overwrote the response; read-back stayed `0003` across a double-invoke test, a 12 s poll and repeated attempts → **the misc opcode-0x02 SET does not commit on this EC**. Wedge replied honest 1004 packet (no `Action` field — §13.24 GOTCHA). EC state unchanged, so no restore needed.
- **Decode refinement (post-verdict, REA)**: the UI enum {0,1,2} is NOT the WMI-level enum. `OnSetBatteryHealthyPacket` (`FUN_14038ccf0`, acc_agent.cpp) drives a **two-switch hardware interface** (vtable+0x58), per requested mode:
  | UI target | calls | failure logs |
  |---|---|---|
  | 0 Optimized | `(1,4,0)` · `(1,1)` | "disable adaptive charging failed" · "enable optimized battery charging failed" |
  | 1 Full | `(1,4,0)` · `(1,1,0)` | "disable adaptive charging failed" · "disable optimized battery charging failed" |
  | 2 Adaptive | `(1,1,0)` · `(1,4)` | "disable optimized … failed" · "enable adaptive charging failed" |
  i.e. two independent switches — optimized (cmd 1 on/off), adaptive (cmd 4 on/off): Optimized = optimized ON + adaptive OFF; Full = both OFF; Adaptive = optimized OFF + adaptive ON. Success schedules a **1-s delayed reply** (async ack; failure paths compare against constant `0x3ea`=1002 — service-side, not EC-read).
  Moreover `OnGetBatteryHealthyPacket` (`FUN_14038c560`) computes Value ∈ {0,1,2} **from the agent's own tracked flags** (`local_126/124/121/123`) — the Windows GET is service-state, not an EC read. Consequences: (a) their card binding can never observe the raw EC byte (the unset-3 state never leaks in their UI), (b) our EC-backed GET is a *different but more honest* source.
- **Provenance note**: the two-switch flow means the misc id-22 opcode-0x02 SET likely only arms service-side state on a Windows sidecar, while the actual EC commit may ride the **`BatteryControl` 79772EC5 BE\* surface** (§13.15.3 parked). "BatteryControl" strings exist in the agent (COM by class name) — the "Windows bundle never calls this GUID" scoping in §13.15.3 covered `AcerHardwareService.exe` only, not `AcerCCAgent.exe`. Unresolved: which method/payload the vtable+0x58 lands on (Ghidra lost the vtable xrefs; observed arities `(1,4,0)/(1,1)/(1,4)/(1,1,0)` suggest BESB-style `[in] WMIB+flag` tuples).
- **Wedge fixes shipped this session**: (1) **5141 QuickAccess `FunctionQuery` → honest EMPTY list** — their Personal-Settings page dereferences `FunctionArrayUsage` unguarded (`get isBrightness(){return -1!=this.wsinfo.getQAFunctionArray().indexOf("AdaptiveBrightness")}`) and the old EC-bypass 1007 left it undefined → 70 614 repeated `TypeError … indexOf` and a permanently blank settings route; the empty list hides every QA-driven toggle honestly and stops QA GET bursts. Verified: page renders, **zero renderer errors**. (2) `battmodeGet/battmodeSet` daemonCall timeout raised to 15 s (periodic auto-GET queued behind 8–12 s `kb.zone.set` repaint bursts in the serialized WMI worker → spurious honest-1004s). (3) CheckMemory GET aligned to the embedded manual shape `{TotalMemoryMB,NumberOfBanks,TestInProgress:false,HealthStatus:-1}` + `sysinfo.ram.banks` (DMI DIMM count) — shape shipped, tile re-render not separately captured.
- **Honest posture**: `battmode.get` = live EC truth (the only honest source available). `battmode.set` = decoded iron-level attempt; **does not commit on this EC — keep off any "working features" list**; retained as the AC-session probe baseline (§13.15.3: careful set/observe/restore with battery monitoring — the machine's AC-power precondition was observed live mid-session, `ACMode:true`). *(Continued and superseded by §13.26: the two-switch surface was found, decoded and live-verified on the AC session the same day.)*
- Cosmetic leftovers on the settings page (pre-existing, do-not-chase): Bluelight toggle + `MUI_undefined` select strings — the terser-destroyed USBCharge visibility gate (dead no-op at the tail of `updatePersonalsettingsArray`) makes the Power-off USB Charger row render though unimplemented.



### 13.26 The charge-mode EC surface FOUND + LIVE-VERIFIED: `BatteryControl` BE\* family (79772EC5 ids 20/21; BAC data 22/23) (2026-10-18, AC session)
- Context: §13.25 proved the misc id-22 opcode-0x02 SET cannot commit and the misc-0x02 GET byte stays 3. The user put the laptop on AC mid-session → the parked BE\* probes (§13.15.3) became possible. Engine allow-mask for the battery slot already covers ids 19-23 (incl. id 21 writes) — no kernel change.
- **Wrapper chain (REA)**: the CC agent's two-switch interface (§13.25 table) resolves to **`BatteryControl` / `SetBatteryHealthControl`** — vtable math exact: slot `+0x58` (`0x1404b2410`−`0x1404b23b8` = 0x58) contains `FUN_14033cd20`, the id-21 WMI wrapper (COM by class name `BatteryControl`; method-name string constants at `0x1404965a8/0x1404966e8/0x1404967b0/0x140496830/0x140496880` with wrapper cluster `0x14033af33..0x14033d510` = GetBattInfoInterface(19)/Get+SetBatteryFunctionData(22,23)/GetBatteryHealthControlStatus(20)/SetBatteryHealthControl(21)).
- **BMOF shapes** (`analysis/reference/gaming.mof.decoded.txt` line 54-61):
  - id 19 `GetBattInfoInterface([in]u32 uBatteryInfoIndex, [in]u32 uBatteryNo → u32)` — live: idx 0 → `0x181`, idx 1 → `0x1`.
  - id 20 **`GetBatteryHealthControlStatus([in]u8 uBatteryNo, u8 uFunctionQuery, u8 resv[2] → u8 uFunctionList, u8 uReturn[2], u8 uFunctionStatus[5])`** — in 4 B, out 8 B.
  - id 21 **`SetBatteryHealthControl([in]u8 uBatteryNo, u8 uFunctionMask, u8 uFunctionStatus, u8 resv[5] → u16 uReturn)`** — in 8 B, out 4 B.
  - id 22 `GetBatteryFunctionData([in]u8 uFunctionMask, u8 resv[3] → uReturnCode[2], uBACStartTime[2], uBACStopTime[2], uBACStatus, resv[9])` — **the BAC schedule record = the manual's `BatteryAdaptiveCharging` Get `{AdaptiveCharging,Start,Stop}`**. Live: `returnCode 1, 00:00, off` (never configured).
  - id 23 `SetBatteryFunctionData([in]u8 uFunctionMask, u8 uBACSwitch, u8 resv[6] → u16 uReturnCode)` — parked (no write yet).
  - AML `WMBE` (ssdt11 @3902, CTID `"BE"`): pure WSMI staging per case 0x13-0x17, semantics in SMM.
- **Tuple → bytes mapping**: agent call `(1, mask, status)` = MOF `(uBatteryNo=1 [BAT1], uFunctionMask, uFunctionStatus)`; optimized = mask 1, adaptive = mask 4; status 1=on / 0=off.
- **Live proof (battery on AC, charging throughout; sysfs monitored — no charge-behavior disturbance observed)**:
  - BEGB baseline `03 00 00 00 00 00 00 00` (list 3, all statuses 0);
  - id 21 `[1,1,1,0×5]` → `uReturn=0`, BEGB → `03 00 00 01 …` (function 1 ON) — repeated, stable;
  - id 21 `[1,1,0,0×5]` → `uReturn=0`, BEGB back to zeros — verified restore, repeatable;
  - status array identical at `uFunctionQuery` 1 and 4 (global, query code does not segregate);
  - id 21 `[1,4,1]`/`[1,4,0]` → **`uReturn=1` (EC rejects the adaptive function)** — live confirmation of why the renderer hides AI-Smart behind its `ABC/BAC` feature gate;
  - misc gaming-23 op-02 stayed `0003` while optimized was enabled → **the misc opcode-0x02 GET byte 1 IS the function-list register (3), not the mode store** — which is exactly why a list cannot be written and §13.25's misc SET could never commit.
- **Adopted semantics (honest)**: BEGB `status[0]==1` → Value 0 (Optimized); all-zero → Value 1 (Full = this EC's actual default behavior); adaptive unsupported on this unit.
- **Implementation shipped**: `psensed` `battmode.get` = BEGB (misc02 parity byte dropped the same day — §13.27); `battmode.set {0|1|2}` = the agent's two-switch sequence with a BEGB `committed` verdict (mode 2 honestly reports the EC rejection); main.js Setting-ACK condition = `r.committed`. CLI unchanged.
- Verification records (same day, after §13.27's eval-gap fix):
  - CLI: `battmode.get` 0.13–0.52 s (function_list 3, status array, value mapping); `battmode.set 0` → `committed:true, reported:0` in 0.65–0.90 s and BEGB `0300000100000000`; `battmode.set 1` → `committed:true, reported:1` and BEGB back to zeros; Optimized↔Full round trip twice, state restored after each.
  - GUI (Personal Settings → Battery & Charge): Optimized-card click → `battmode.set` 0.64–0.65 s ACK → renderer auto-GET → card re-render (radio pixel-check `(0,199,235)` selected); Full-card radio click → same, value 1; baseline restored. The card hotspot is the radio circle (`AwI`): Optimized verified at `(429,231)` (title click `(640,232)` also worked); Full verified at `(429,305)` — the title click `(640,305)` did NOT register a SET.
  - Screenshots: `docs/shots/battmode-optimized-selected.png`, `docs/shots/battmode-full-restored.png`.
  - Honest posture update: **battery charge mode is a working feature** — GET live EC truth, SET EC-committed and EC-read-back-verified; mode 2 (AI Smart) still unadvertised, EC rejects function-4 writes (`uReturn 1`).

### 13.27 SMM deferral of near-simultaneous WMI evals (cross-GUID Ud Ud same-GUID) + the universal eval-gap fix (2026-10-18)
- Trigger for discovery: after wiring the BE\\* ops (§13.26), EVERY named `battmode` op took 15–22 s while identical manual `wmi.raw` evals were 0.01–0.17 s — same worker thread, same fd, same bytes. Instrumented build (per-eval timing in `op_wmi`, journal-visible) split the op: `begb` (battery-20) fast; the **`gaming`-23 eval that followed it 1–2 ms later took 16 640 ms**.
- Isolation ladder (raw pairs through the daemon, battery-21 toggles): pairs at inter-eval deltas of ~180 ms+ (two CLI processes, incl. `sleep 0.03`) were fast at ALL gaps (0.03–0.8 s; 0.50–1.26 s pair totals = spawn overhead + sleeps); content-order tests A `(1,4,0)→(1,1,1)`, B `(1,1,0)→(1,4,0)`, C `(1,4,0)→(1,1,0)` all fast (~0.3 s). The stall appeared ONLY when two evals ran inside **one op** (deltas ≈ 1–2 ms): `besb(4,0)` fast → `besb(1,1)` **14 324 ms**; earlier `misc02` 16.6 s; op totals clustered 15.2/16.6/21.7–21.8 s (NOT a fixed timeout — a "wait for the SMM's next periodic service window" signature).
- **Mechanism (empirical)**: an eval issued ~<150 ms after the previous one (any GUID pair — battery→gaming, gaming→battery, and *within* family: battery-21→battery-21, presumably also gaming-6→gaming-6) gets deferred by the SMM to its next periodic window — costs 5–22 s. Deltas ≥ ~180 ms are served immediately. Exact threshold not bisected (between ~5 and ~150 ms); chosen guard margin covers it.
- **Retro-explanation locked**: the session-long anomalies finally resolve — historical `kb.zone.set` "8–12 s bursts" = multiple gaming-6 zone writes ~30 ms apart inside one op (WRITE_GAP=0.03 did nothing to help — the *second* write deferred); the "2 fast + 1 slow" burst pattern; part of the old 15 s `daemonCall` timeouts. After the fix `kb.zone.set` completes in 0.26 s.
- **Fix (psensed `WmiCtl.eval`)**: worker-thread-only eval path → class-level `last_family`/`last_eval_t`; sleep so any eval starts **≥ EVAL_GAP = 0.25 s** after the previous eval, and **≥ FAMILY_GAP = 0.5 s** total across a GUID-family switch. Deploys: 4 sudo installs this session (diagnostic timing build → family-gap → universal gap + misc02 removal).
- `battmode.get` lifecycle: misc02 parity byte **removed** (a gaming eval after the BEGB read would always defer 5–22 s); GET now = one battery-20 eval, 0.13–0.52 s.
- Post-fix verification: get 0.13–0.52 s; set 0.65–0.90 s (`committed:true` both directions); kb ops 0.26 s; GET after a kb write pays the 0.5 s family gap ("begb: 515 ms") — expected, cheap; full GUI verification in §13.26.
- Kept: per-eval timing logs (`battmode.timing …` ≥50 ms) + `wmi op … started` journal lines — cheap telemetry that made this diagnosis possible; trim only if journal noise matters.
- SMM-deferral open questions (parked): does the ~periodic window relate to the EC's own scan cycle; is the deferral per-GUID-pair or global; exact threshold; interacts with /sys notes in §13.25 (misc-0x02 semantics unchanged).

### 13.28 GUI service-layer: the BATTERY_BOOST mode gate, FAN_CONTROL custom wiring, redundant-lighting caches (2026-10-18)

**Trigger:** user reports — Scenario plates won't switch modes; Fan Control custom can't
reach max rpm; lighting effect/area changes feel slow (3–4 s); CPU% and frequency readouts
differ from `top`.

**1. Scenario mode gate — BATTERY_BOOST (fixed; live-verified).**
The renderer's gate is `dataModel.batteryBoost.getData() → LockMode(gt.BatteryBoost)`
(logged verbatim as `[mode]plugAC:<ac>,Battery:<boost>,Lock:<type>` every ~5 s and after
any adaptor change). Our store seeded `BATTERY_BOOST: 0` and never refreshed it →
`Battery:0` → the vendor bundle path `0==batteryBoost → LockMode` locked **all four**
plates with no visible affordance. Contract: `ccagent-protocol-manual.json` `BatteryBoost`
(Get → `{status}` 1=enabled / 0=disabled, service-decided); the vendor banner text pins
the policy — "Mode switching is available when the battery life is at least 40% capacity".
Fix: honest `batteryBoostStatus()` in the shim = AC OR battery ≥40 %; pump refresh inside
the early-return signature + `setIfChanged` emit. Live: gate reads `Battery:1`.
Click→write chain (needs the test harness — see 3 below): Performance plate →
`setDeviceData ["OPERATING_MODE",4]` → platform `balanced-performance`; Turbo plate →
`["OPERATING_MODE",5]` → platform `performance`; Home banner relabels live from the pump
emit (mode 5 displays as "Turbo" in their enum naming). Plate→mode map = their enum
QUIET=0 DEFAULT=1 EXTREME=4 TURBO=5 ECO=6 → our MODE_TO_PROFILE (2-fan value parity with
the repo spec §5). Balanced-after-other-plate clicks: the UI switches but no
`setDeviceData` landed through the synthetic path (the topmost node at that point has no
`<button>` ancestor — the synth clicked an inner div and Angular's binding didn't fire);
a proven end-to-end path exists for the Performance/Turbo plates and the daemon side is
mode-agnostic (`profile.set` validates against platform choices) — real user clicks route
at DOM trust level, where this nuance doesn't exist.

**2. FAN_CONTROL custom — wiring shipped (fixed; live-verified).**
Vendor enum `FAN_MODE{Auto=0, Max=1, Custom=2}`; custom payload = per-fan entries
`{fan_custom_auto, fan_custom_speed %, fan_index, fan_name}` (vendor DEFAULT_SCENARIO
shape; the 3-entry default has a dup-index GPU/GPU2 pair — first-per-index wins).
Old code handled only mode 0/1 and logged Custom "not wired yet" — that is the exact
"custom can't reach max rpm" symptom (nothing was applied). New wiring: `fan_index`
0→cpu fan1, 1→gpu fan2; auto=1 → per-fan `fan.reset`; auto=0 → per-fan `fan.speed {pct}`
(clamped 0–100). Live: Custom plate → `mode:2` payload ×2 (vendor re-sends) → both
fans reset (honest EC-auto for the default auto=1 payload); `fan.speed 100 --fan both`
(the exact op) → rpm CPU 7539 / GPU 6514 @ pwm 255 → restore via Auto plate (`mode:0`
→ `fan.reset` ok). The Material sliders commit on real drag only; the synthetic path can
set neither value nor commit — CLI verifies the same daemon call instead.

**3. Diagnostic harness — webview input routing (repo-only tooling).**
The shell hosts pages as `<webview>` guests (`useWebView=useEmbedded&&isDesktopApp`).
`sendInputEvent` into the host never crosses the webview boundary (only tab-bar clicks,
measured live). The harness now resolves each point into the owning guest (rect probe +
`getWebContentsId` + `webContents.fromId`, local coords, host fallback) and optionally
dispatches a DOM `.click()` (`PS_CLICK_SYNTH`, route for points whose topmost node
doesn't carry a `<button>` ancestor). Harness-only; real input unaffected.

**4. Lighting latency: measured + caches shipped (no WMI surface change).**
Timings (journal `_tm`): isolated effect write = 1 eval, 0.01 s (0.2–0.27 s if landing
inside the gap); full area repaint = 4 zone evals + kb.set ≈ 1.0–1.3 s; their page
re-sends the WHOLE LIGHTING object on every interaction — and the un-mapped "Zoom"
default fell back to a full STATIC repaint each time. Shipped in the shim:
- zone-palette cache: only zones whose color actually changes are written;
- kb-frame cache: identical `mode|speed|bri|dir|color` → skip the eval entirely.
Live: repeated identical payload → "skipped (no WMI evals)", journal empty for 30 s.
Honest limit (in-code): an external EC writer desyncs both caches; different payloads
always write; caches reset per process.
Daemon: `EVAL_GAP 0.25 → 0.20` (§13.27 measured ≥ ~180 ms unaffected; 20 ms margin kept
over the verified-safe line) — **effective after the next service restart**.

**5. CPU%/frequency readouts — no defect:**
- The app's CPU % = all-core aggregate busy% (backend `cpuBusyPct()` over the 1 s pump
  window, /proc/stat deltas). `top`'s default view is per-core instantaneous rows:
  one busy core = 100 % there, ~4 % aggregate on 24 cores. Metric semantics, verified both
  directions live.
- Frequency: live sample 800 → 4699 MHz per-core swings (normal P/E-core + turbo
  behavior); psensed's own draw 0 ticks / 10 s — the daemon sleeps between ops;
  the GUI's heavy painter is the vendor 3D scene (Electron), same as the vendor build.

### 13.29 Port 5141 `QuickAccess` (`AcerQAAgent.exe`) RE, live `APGeAction` probes, and `USBCharge` wiring (2026-10-18)

**1. Artifacts & REA evidence IDs:**
- Target binary: `analysis/reference/predator-sense/PredatorSense_5.0.1463/AcerQAAgent/AcerQAAgent.exe` (PE32+ x86-64, service version `"1.1.13"`).
  - REA `inspect_binary_layout`: `ev_3d28e9035e4d4066d1cd0d0a3ed9201ab0ec756676e3336d4b1f17e2e68f8c9e` (`.text` VMA `0x140001000` / file `0x400`, `delta = 0x140000c00`; `.rdata` VMA `0x14039c000` / file `0x39ae00`, `delta = 0x140001200`).
  - REA `binary_overview` (Ghidra 12.1.4): `ev_4302561442474208d7d6460f69896e4057ab42c7216520e3745f0fa37d65df40`.
  - REA `inspect_with_objdump` disassembly: `ev_de9ec69812a785ec3ae7020475ba52d614ac1520e7a962fcb6b2ef043dd0aca0`.
  - REA `analyze_function` (`FUN_14038aa30` `FunctionQuery` packet entry): `ev_567c5618633fbf3de4d3da74d400445c663b5a57133a3892ef7b284d5eb6c839`.
  - REA `analyze_function` (`FUN_1402ea8e0` `BuildCapability`): `ev_a35334f6743d2df62289e1416ef6fc9081b71f4f9f7d6cd20885a49022634183`.
- Extracted embedded 25-command QuickAccess JSON manual (`.rdata` file offset `0x4beae0`..`0x4c1fc2`): persisted at `analysis/reference/predator-sense/qaagent-protocol-manual.json`.
- Renderer bundle (`dist/widgets/main/main.8ed9dc924c527068.js`):
  - REA `analyze_web_bundle`: `ev_52b9479edbce64cd7d199a81c04802cf9ded54cd8239ef3e3bfc373799c615ec`.
  - REA `trace_application_feature` (`FunctionQuery`): `ev_771ee7e03c48e88ad5a82a87f7b8030df8d7802cc3592d69fa95e768c3ba671f`.

**2. Complete `AcerWMI` C++ vtable (`0x1404d6418`, file offset `0x4d5218`):**
All WMI calls in `AcerQAAgent.exe` route through `[r13+0x28]` (`AcerWMI*`). Note that `AcerQAAgent.exe` opens WMI class `APGeAction` (`61EF69EA-865C-4BC3-A502-A0DEBA0CB531`, DSDT `WMAA` / `CTID="AA"`), `BatteryControl` (`79772EC5-...`, `WMBG`), and `AcerGamingFunction` (`7A4DDFE7-...`, `WMBH`):

| Vtable offset | Function VA | WMI class & method | Input / Output decode | Caller / Command |
|---|---|---|---|---|
| `+0x00` | `0x1400910a0` | dtor | scalar deleting destructor | – |
| `+0x08` | `0x140309c00` | `InitWMI` (`0x140305a50`) | connects `root\wmi` | `BuildCapability` |
| `+0x10` | `0x140308970` | `APGeAction::GetFunction(0x0207)` | `b0`=status, `b1`=`(out>>8)&0xff` (current fan/usage mode) | `OnGetSystemUsageControlPacket` (`0x140360eb0`) |
| `+0x18` | `0x1403088f0` | `APGeAction::SetFunction(0x07 \| (dl<<16))` | `dl` ∈ `1..4` (1=Normal, 2=Silent, 3=Performance, 4=Turbo) | `OnSetSystemUsageControlPacket` (`0x1403613e0`) |
| `+0x20` | `0x140308830` | `APGeAction::GetFunction(0x07)` | `b0`=status, `(out>>16)&0x0f` = mode capability bitmask | `BuildCapability` `[rdi+0x09]`, `OnGetSystemUsageModesPacket` (`0x1403619c0`) |
| `+0x28` | `0x1403087d0` | `APGeAction::SetFunction(0x07 \| (dl==1?0x100:0x200))` | DustDefender start/stop | `OnSetDustDefenderPacket` (`0x1403582c0`) |
| `+0x30` | `0x140308760` | `APGeAction::GetFunction(0x0307)` | `b0`=status, `b3`=`(out>>24)&0xff` = status | `OnGetDustDefenderPacket` (`0x140357c20`) |
| `+0x38` | `0x1403086f0` | `APGeAction::GetFunction(0x0107)` | `b0`=status, `b3`=`(out>>24)&0xff` == 1 → supported | `BuildCapability` `[rdi+0x03]` (`DustDefender`) |
| `+0x40` | `0x140308680` | `APGeAction::GetFunction(0x04)` | `b0`=status (`[rbx+2]`), `b1`=switch (`0x0f`=on, `0x1f`=off, `[rbx+1]`), `b2`=threshold % (`[rbx+0]`) | `BuildCapability` `[rdi+0x02]`, `OnGetUSBChargeSwitchPacket` (`0x140363320`), `OnGetUSBChargePacket` (`0x140363950`) |
| `+0x48` | `0x140308630` | `APGeAction::SetFunction(0x04 \| (dl<<8) \| (r8b<<16))` | `dl`=`0x0f` (on) / `0x1f` (off), `r8b`=threshold % (`10`/`20`/`30`) | `OnSetUSBChargeSwitchPacket` (`0x1403635f0`), `OnSetUSBChargePacket` (`0x140363c70`) |
| `+0x50`..`+0x68` | `0x140307de0`..`0x140306bc0` | `BatteryControl` ids 20..23 | Smart battery health & BAC schedule (same as `AcerCCAgent.exe`, §13.26) | unused in QA `FunctionQuery` |
| `+0x70` | `0x140306b50` | `APGeAction::GetFunction(0x0102)` | `b0`=status, `b1`==1 | unreferenced in `AcerQAAgent.exe` |
| `+0x78` | `0x140306b00` | `APGeAction::SetFunction(0x1103 \| (dl<<24))` | SIM mode write | `OnSetSIMControlPacket` (`0x14035cf20`) |
| `+0x80` | `0x140306a90` | `APGeAction::GetFunction(0x1102)` | `b0`=status, `b1`=SIM mode | `OnGetSIMControlPacket` (`0x14035c860`) |
| `+0x88` | `0x140306a20` | `APGeAction::GetFunction(0x1202)` | `b0`=status, `b1`!=0 (SIM card present) | `OnGetSIMCardPacket` (`0x14035c350`) |
| `+0x90` | `0x1403069b0` | `APGeAction::GetFunction(0x20001 \| (r8b<<8))` | `r8b`=0 touchpad, 1 keyboard lock; tests `out & 0x20000` | `OnGetTouchpadPacket` (`0x140361fa0`), `OnGetKeyboardLockPacket` (`0x14035ac80`) |
| `+0x98` | `0x140306960` | `APGeAction::SetFunction(0x02 \| (dl<<8) \| (r8b?0x20000:0))` | Device lock write | `OnSetTouchpadPacket` (`0x1403624b0`), `OnSetKeyboardLockPacket` (`0x14035b190`) |
| `+0xa0` | `0x140306910` | `APGeAction::SetFunction(0x000100ffffffff01 \| (dl<<40))` | App event notify (`SenseAppStatus`) | `OnSetSenseAppStatusPacket` (`0x140360440`) |
| `+0xa8` | `0x1403068c0` | `APGeAction::GetFunction(0x05)` | Audio/VOIP capability check | `BuildCapability` |
| `+0xb0` | `0x140306880` | `AcerGamingFunction::GetGamingMiscSetting(0x09)` | `b0`=status, `b1`=display mode cap bitmask | `BuildCapability` `[rdi+0x1a]`, `OnGetDisplayModeCapabilityPacket` (`0x1403575b0`) |
| `+0xb8` | `0x140306840` | `AcerGamingFunction::GetGamingMiscSetting(0x02)` | `b0`=status, `b1`=display mode (`1`/`2`/`4`; `3` rejected) | `OnGetDisplayModeSwitchPacket` (`0x140356c20`) |
| `+0xc0` | `0x140306080` | `AcerGamingFunction::SetGamingMiscSetting((val<<8)\|0x02)` | Display mode write | `OnSetDisplayModeSwitchPacket` (`0x140357140`) |

**3. Kernel module allow-mask fix (`src/psense-wmi/psense-wmi.c`) & live read-only probe results on PHN16-71:**
- `pswmi_allow[PSWMI_GUID_APGE]` was `0x00000003` (`BIT(0)|BIT(1)`), which inadvertently blocked `WmiMethodId(2)` (`APGeAction::GetFunction`, `BIT(2)` = `0x04`). Updated to `0x00000007` and reloaded `psense-wmi.ko`.
- Probing `AcerGenericMethod::GetFunction` (`1EA0BC57-...`, `CTID="AE"`, `guid="generic", mid=2`) returned `0xe1`/`0xe3`/`0xe4` across all opcodes — SMM requires `CTID="AA"` (`APGeAction`, `guid="apge", mid=2`).
- Live read-only `APGeAction::GetFunction` (`guid="apge", mid=2`) results on PHN16-71:
  - `0x04` (`USBCharge` / `USBChargeSwitch`): **`u64 = 0x00000000001e0f00`** (`b0=0x00` OK, `b1=0x0f` Enabled, `b2=0x1e` = `30%` battery cut-off threshold).
  - `0x05` (VOIP/Audio): `u64 = 0x00000000000000e1` (`b0=0xe1` unsupported).
  - `0x07` (`SystemUsageCap`): `u64 = 0x0000000000000000` (`(out>>16)&0x0f == 0` → 0 modes; Predator uses `OPERATING_MODE` on `pssdk`).
  - `0x0102` (unreferenced cap): `u64 = 0x0000000000000100` (`b0=0x00, b1=0x01`).
  - `0x0107` (`DustDefenderCap`): `u64 = 0x00000000000000e1` (`b0=0xe1` unsupported).
  - `0x0207` (`SwitchFanTableStatus`): `u64 = 0x0000000000000000` (`b0=0x00, b1=0x00`).
  - `0x0307` (`DustDefenderStatus`): `u64 = 0x00000000000000e1` (`b0=0xe1` unsupported).
  - `0x1102` (`SIMControl`) & `0x1202` (`SIMCardPresent`): `u64 = 0x00000000000000e1` (`b0=0xe1` unsupported).
  - `0x20001` (`TouchpadLockState`) & `0x20101` (`KeyboardLockState`): `u64 = 0x00000000000000e2` (`b0=0xe2` unsupported).
- Live read-only `AcerGamingFunction::GetGamingMiscSetting` (`guid="gaming", mid=23`) probes:
  - `0x09` (`DisplayModeCapability`): `u64 = 0x0000000000000700` (`b0=0x00, b1=0x07`).
  - `0x02` (`DisplayModeSwitch`): `u64 = 0x0000000000000300` (`b0=0x00, b1=0x03` — rejected by `AcerQAAgent.exe` `0x140356eca`, and unused by the renderer which uses `pssdk` `GPUModeCap`).

**4. Wiring & concurrency fixes (`psensed`, `psense`, `backend.js`, `main.js`):**
- Added `usbcharge.get` and `usbcharge.set` to `src/psensed` (`APGeAction` methods 2 and 1, pre-reading `GetFunction(0x04)` on partial writes to preserve the partner byte and verifying commit via post-write read-back) and `psense usbcharge [get|set]` to `src/psense`.
- Wired port `5141` (`QuickAccess`) in `src/psense-electron/main.js` to advertise `FunctionQuery: ["USBCharge", "USBChargeSwitch"]` (`ServiceVersion: "1.1.13"`) when `usbcharge.get` reports `status === 0`, and handle `Get`/`Set` for `USBChargeSwitch` (`boolean`) and `USBCharge` (`10 | 20 | 30`).
- **First-launch clobber guard**: in `main.8ed9dc924c527068.js`, `wsinfo.firstLanding()` runs before `wsinfo.getDiskCleanSetting()`; if `info.getDiskCleanSetting()` returns `null`, `firstLanding()` assumes a factory-first boot and overwrites `USBChargeSwitch` to ON, `USBCharge` to `"30%"`, and `BluelightShield` to `0`. Seeded `DiskCleanSetting` default in `backend.js` `KV_PAIRS` to `{FileSizeMB:"100",LastAccessedDay:"30",ForceDelete:false}` so `firstLanding()` logs `[WSINFO] Not First Launch AP` and never clobbers hardware state.
- **Cross-service WMI-busy retry + coalescing**: `PersonalSettingsComponent.ngOnInit` fires `updateQAData()` (`usbcharge.get` on port 5141) and `updataBatteryChargeMode()` (`battmode.get` on port 4343) in the same millisecond, and `getAllUsageValue()` fires `USBCharge(Get)` + `USBChargeSwitch(Get)` back-to-back. Added 1 s / in-flight coalescing on `usbchargeGet` in `backend.js` and a 250 ms retry loop on `/^wmi busy:/` inside `daemonCall` so concurrent WMI requests across `4343`/`5141`/`pssdk` serialize cleanly without `ErrorCode: 1004`.
- **Live GUI verification**: `docs/shots/personal-settings-usbcharge.png` — Personal Settings → Battery & Charge now renders **Full Battery Charging** (selected), **Power-off USB Charger** toggle **ON**, and **Charge Limit While Using Batter Power** dropdown at **`30%`**, with zero `ErrorPacketHandler` entries in the log.

### 13.30 Keyboard backlight "breaks when the app closes" + wrong CPU clock/usage readouts (2026-10-18)

**Evidence:** `AcerAgentService.exe` objdump (REA `ev_de16d5504d421f03a0f9fac9b472b8f523d1b3521cb6f5dceb592bbc9276f171`), `AcerHardwareService.exe` (`ev_c520e6ae8f88582030134ea250c48588e197a130e5718a72187ac7d131702bb8`), renderer bundle `main.8ed9dc924c527068.js` (`ev_52b9479edbce64cd7d199a81c04802cf9ded54cd8239ef3e3bfc373799c615ec`), vendor `dist/main/main.js` (`setDataWithoutScenario` @ ~93950, `PSSdk.setLightingLEDs` @ ~99534), `AcerLightingService.exe` composer `0x14000b190` (§13.14.4).

**1. Keyboard backlight: root cause.**
- `applyLightingWrite()` applied **both** halves of a whole-profile lighting object: first `GlobalEffect` (WAVE, `kb.set mode=3`), then every `devices[]` entry (Area STATIC: 4× `kb.zone.set` + `kb.set mode=0`). The renderer's `applyProfile → SwitchToProfileLightMode(lighting.mode, …)` applies **one** side only (`Rr.GLOBAL=0` → `LightingMap.get(GLOBAL).setData(GlobalEffect)`, else per-device `setDataWithoutScenario`). The backend's 5 s boot apply therefore always finished on STATIC. Whichever writer ran last won the race, and the EC kept that state after the app closed (the EC does not revert on its own). Live, pre-fix: `kb.get` after close = `00 00 00 64 00 01 00 ae c7 03` (STATIC teal) although the active profile is Global WAVE; journal 21:03:33 shows the 6-eval sequence `kb.set, kb.zone.set ×4, kb.set`.
- `mergeLightingEntry()` never updated `lighting.mode`. Vendor `setLightingLEDs` sets `mode=0` for `device 0` and `mode=1` for `device ≥1`, so a user switch to Area was never persisted. It also wiped zone `LEDs` when an animated Area entry omitted them (their `extractEffect` deletes `LEDs`).
- `pssdk.setDataWithoutScenario` was a store-only stub. In vendor main.js it is `this.setData → adapter.setDeviceData` (a hardware write with no scenario save). Area-mode profile restore and the Global music/screen mapping go through it.
- Brightness scale: the renderer uses `BrightnessMin = 1` (`IsTurnOffBrightness(e){return e==this.BrightnessMin}`), and `AcerAgentService` `0x140042df2..0x140042e57` maps UI 1..5 → EC 0/25/50/75/100. Ours used `×20`, so "off" was 20 %.
- Profile↔lighting link (§13.18) re-probed live with the app closed: `profile.set quiet` → `kb.get` unchanged → restore unchanged (`00000064000100aec703…` each time). In this firmware state, a thermal-profile write does not touch the kb register. No cache invalidation added; the §13.18 observation stays unexplained.
- Considered and **not** shipped: a daemon-side kb persist/restore. There is no evidence that the EC loses state across reboot or suspend, and a restore on resume would overwrite Fn-hotkey brightness changes. (Note: the `gsd-power … failed to set dim kbd backlight` journal lines come from UPower's KbdBacklight object with an empty `NativePath`, meaning no LED class device. That is harmless and unrelated.)

**Fixes (`src/psense-electron/backend.js`):** `applyLightingWrite` picks the GlobalEffect or devices side by `lighting.mode`; `mergeLightingEntry` sets `mode` and preserves `LEDs`; `setDataWithoutScenario` applies LIGHTING to hardware (OPERATING_MODE/FAN_CONTROL deliberately stay store-only, because `applyProfile` replays the profile's stored `opMode` on every launch and our plate writes don't update it); brightness `(b−1)×25`.
**Live verification:** GUI boot trace `boot: applying profile lighting (MUI_DAILY_USE)` → `lighting write: effect=WAVE mode=3 speed=3 bri=100 dir=1` (single `kb.set`, 0.51 s, no STATIC follow-up). After `pkill -x electron`: `kb.get raw 00030364000100000003…` = mode 3 WAVE, speed 3, bri 100. The state persists with the app closed.

**2. CPU usage: root cause.** `cpuBusyPct()` ran **twice per tick**: once in `buildMonitorData` and again ~15 ms later (after `nvidia-smi`) for the `CPU_USAGE` store. The second call measured a ~15 ms window and reset the baseline for the next second. The regex also summed only 5 of the 8 host columns (no irq/softirq/steal), and `CPU_USAGE` was published only when the sensor signature changed. Fix: one `cpuSample()` per tick, taken before the awaits; all 8 columns summed (guest time is already inside user/nice); `CPU_USAGE` published every tick; an in-flight guard stops overlapping ticks from double-sampling.

**3. CPU clock: root cause.** `CPU_FREQUENCY = Math.max(per-core scaling_cur_freq)`. `AcerAgentService` (`0x14002711a..0x1400271c6`, `0x1400273b2`) instead computes a package figure from the `_Total` PDH counter (`% Processor Performance / 100 × MaxClockSpeed`). On the 24-thread i7-13700HX, max() follows whichever single thread just boosted. Separately, `CPU_CORE_FREQUENCY` was in lexicographic readdir order (`cpu0, cpu1, cpu10…`), so array index ≠ core number. Fix: index by core number; aggregate = per-core clock weighted by that core's busy ticks in the same 1 s window (all idle → mean).

**Live A/B (scratch `cpu_compare.js`, same machine and window):**

| condition | new usage | old usage (store) | new clock | old clock (max) |
|---|---|---|---|---|
| idle | 4–8 % (steady) | 3–13 % (jitter) | 830–1140 MHz (one 2558 spike while cores boosted) | 1450–4100 MHz |
| 4 busy threads / 24 | 18–19 % | 16–25 % | 2730–3300 MHz | 3300–3401 MHz |

Expected load figure: 4/24 = 16.7 % + ~3 % base ≈ 19–20 % ok. `vmstat` reads higher (`100−id` = 22–35 %) because it counts iowait (wa 15–17 % here) as busy; ours treats iowait as idle, the top/Windows convention.

**Deployment:** repo only until `backend.js` is copied to `/opt/predator-sense/`. The daemon is unchanged.

### 13.31 GPU idle clock verification & UI Mode plate highlight fix (2026-10-18)

**1. GPU 210 MHz Core Clock Verification:**
- Direct hardware reading via `nvidia-smi --query-gpu=clocks.current.graphics,clocks.current.memory,clocks.max.graphics,power.draw,pstate --format=csv`:
  - `clocks.current.graphics: 210 MHz`
  - `clocks.current.memory: 405 MHz`
  - `clocks.max.graphics: 3105 MHz`
  - `power.draw: 1.93 W`
  - `pstate: P8` (deep idle power-saving state)
- On NVIDIA mobile GPUs (Ada Lovelace RTX 40-series on PHN16-71), 210 MHz is the standard idle base clock in P8 state to keep power draw under 2 W. Under 3D load, it transitions to P0 and scales up to 2000–3100 MHz.

**2. UI Mode Plate Highlight Defect & Fix:**
- **Evidence:** Renderer `main.8ed9dc924c527068.js` (`ev_52b9479edbce64cd7d199a81c04802cf9ded54cd8239ef3e3bfc373799c615ec`) offset `1834119` (`currentMode`), offset `1848964` (`QRe` plate template `r.currentMode == e`), and vendor `dist/main/main.js` offset `99330`.
- **Root Cause:**
  - In `main.8ed9dc924c527068.js`:
    ```javascript
    get currentMode() {
        return this.IsDC ? this.pss.CurrentProfile.dcMode
            : this.pss.IsLockStauts ? this.pss.dataModel.operatingMode.getData()
            : this.pss.CurrentProfile.opMode;
    }
    ```
  - When AC is connected, the UI determines which mode button to highlight (`r.currentMode == e`) exclusively from `CurrentProfile.opMode`.
  - When the user clicked Quiet (`0`), Performance (`4`), or Turbo (`5`), `setDeviceData("OPERATING_MODE", data)` called `applyPssdkWrite("OPERATING_MODE", data)` $\to$ `profile.set` (successfully changing the hardware state), but `backend.js` only set `pssdkStore.set("OPERATING_MODE", data)`. It never updated `scenario.profiles[scenario.active].opMode` and never broadcast `ScenarioChanged`.
  - Consequently, `CurrentProfile.opMode` remained stuck on `1` (Balanced), causing Balanced to stay highlighted in the UI despite the underlying hardware having changed mode.
- **Fix (`src/psense-electron/backend.js`):**
  - Updated `HANDLERS.pssdk.setDeviceData`: when `k === "OPERATING_MODE"` (or `"FAN_CONTROL"`), updates the active profile's `opMode` (and `LastOpMode` if not Turbo) and calls `saveScenario()`, exactly matching vendor `dist/main/main.js` offset `99330`.
  - Updated `pumpOnce()`: when external profile changes occur (e.g. physical Turbo key or `psense profile set`), `backend.js` synchronizes `CurrentProfile.opMode` and broadcasts `ScenarioChanged` so external mode switches also update the UI highlight.
- **Verification:** Unit test via `node` simulated `setDeviceData("OPERATING_MODE", 4)` and verified that `s.profiles[s.active].opMode` immediately becomes `4` and `ScenarioChanged` is emitted.

### 13.32 Pulsar Lighting: Animated Modes (Breathing, Shifting, Meteor, Twinkling) and Interactive Modes (Music, Screen Mimic) Resolution (2026-10-18)

**1. Reported Issue:**
- In Pulsar Lighting, selecting `breathing`, `shifting`, `meteor`, `twinkling`, `music`, or `screen mimic` resulted in complete loss of backlight ("no backlight will come" / LEDs completely dark).

**2. Evidence:**
- `AcerLightingService.exe` assembly composer `0x14000b190` & mapper `0x140013900` (`FUN_140013900`, REA `ev_1ad4a5bc`, §13.14.4):
  ```
  [RSP+0x30]=frame: [0]=mode [1]=speed [2]=brightness [3]=0 [4]=direction
                    [5]=color&0xFF [6]=(color>>8)&0xFF [7]=(color>>16)&0xFF
                    [8]=0x03 [9]=device (1=keyboard)
  ```
- Vendor Angular bundle `main.8ed9dc924c527068.js` (`ev_52b9479edbce64cd7d199a81c04802cf9ded54cd8239ef3e3bfc373799c615ec`):
  - Offset `1262266` / `1263035`:
    ```javascript
    switch(a) {
        case me[me.SCREEN]: e = me[me.NEON]; break;
        case me[me.MUSIC]: switch(t) {
            case ji.sunrex_Wave: case ji.sunrex_Spectrum: e = me[me.WAVE]; break;
            case ji.sunrex_Neon: case ji.sunrex_Rock: e = me[me.NEON]; break;
            case ji.sunrex_Lightning: case ji.sunrex_Matrix: e = me[me.BREATHING]; break;
            case ji.sunrex_Digital: e = me[me.NEON];
        }
    }
    ```
  - Offset `1545883` (`extractEffect`):
    ```javascript
    extractEffect(e) { var i = Object.assign({}, e); return delete i.LEDs, i; }
    ```
  - Offset `1514946` / `dist/main/main.js` offset `95056` & `125814`:
    `e.ddsc.appCenter.SetInteractiveLighting(effId, bri)` with `effId=9` for Screen, `effId=1..8` for Music.

**3. Root Cause:**
- **Single-color animated modes (`BREATHING` 1, `SHIFTING` 4, `METEOR` 6, `TWINKLING` 7):**
  - In `src/psensed`, `kb.set` parses `rgb = args.get("rgb", [0, 0, 0])` and places `r, g, b` into `frame[5..7]`.
  - In `src/psense-electron/backend.js`, `applyLightingEntry` previously called `daemonCall("kb.set", { mode, speed, brightness: bri, dir: dirNum })` without passing `rgb`!
  - `WAVE` (3) and `NEON` (2) worked because they are autonomous rainbow/spectrum cycling modes in the EC firmware that do not require an RGB payload.
  - However, `BREATHING`, `SHIFTING`, `METEOR`, and `TWINKLING` are single-color animated effects that animate the color passed in `frame[5..7]`. Because `backend.js` omitted `rgb`, `psensed` defaulted to `[0, 0, 0]`, instructing the EC to animate with zero intensity (pitch blackness).
- **Interactive modes (`SCREEN` and `MUSIC`):**
  - `KB_EFFECT_IDS` had no entry for `"SCREEN"` or `"MUSIC"`.
  - Unmapped effects fell back to `STATIC` (mode 0) with empty `LEDs` (because `extractEffect` stripped `LEDs` and `SCREEN`/`MUSIC` lack zone definitions), turning the keyboard completely off.
  - `appCenter.SetInteractiveLighting` was a no-op stub (`() => null`).

**4. Implementation & Fix (`src/psense-electron/backend.js` and `src/psense`):**
- **RGB frame extraction:** Added robust color parser `parseRgb(c)` accepting `#RRGGBB`, `RRGGBB`, `rgb(r,g,b)`, or array. In `applyLightingEntry`, RGB is extracted from `src.color` or `src.LEDs`, falling back to `#00aec7` (`[0, 174, 199]`), and passed in `daemonCall("kb.set", { mode, speed, brightness: bri, dir: dirNum, rgb })`.
- **Screen & Music mapping:**
  - `SCREEN` maps to `NEON` (mode 2) matching vendor bundle offset `1262266` for Sunrex 4-zone keyboards.
  - `MUSIC` maps `src.music_effect` via `MUSIC_EFFECT_MAP` (`sunrex_Wave`/`Spectrum` $\to$ `WAVE` 3, `sunrex_Neon`/`Rock`/`Digital` $\to$ `NEON` 2, `sunrex_Lightning`/`Xlight`/`Rain` $\to$ `BREATHING` 1).
  - Implemented `appCenter.SetInteractiveLighting([effId, bri])` to map screen sync (9) and music effects (1..8) to corresponding hardware modes with user-selected brightness.
- **Cache hygiene:** When entering an animated mode, `kbZonePalette.clear()` ensures returning to STATIC mode always re-applies all 4 zone colors. Included `rgb` in `frameSig` so color edits to animated effects are never falsely skipped.
- **CLI update:** Added `neon: 2` and `wave: 3` to `KB_MODES` in `src/psense` so all vendor modes can be tested and invoked directly from the CLI.

**5. Verification:**
- Tested all 6 effects via Node IPC dispatch:
  - `BREATHING` $\to$ `mode=1 rgb=0,174,199` $\to$ EC frame `010364000000aec7030100...`
  - `SHIFTING` $\to$ `mode=4 rgb=255,136,0` $\to$ EC frame `0403640001ff8800030100...`
  - `METEOR` $\to$ `mode=6 rgb=0,255,0` $\to$ EC frame `060464000000ff00030100...`
  - `TWINKLING` $\to$ `mode=7 rgb=255,0,255` $\to$ EC frame `0703640000ff00ff030100...`
  - `SCREEN` $\to$ `mode=2 rgb=0,174,199` $\to$ EC frame `020364000000aec7030100...`
  - `MUSIC` $\to$ `mode=3 rgb=0,174,199` $\to$ EC frame `030364000000aec7030100...`
  - `appCenter.SetInteractiveLighting` $\to$ `mode=2 rgb=0,174,199`
- Checked `journalctl -u psensed`: all ops completed with status 0, pacing preserved. `psense kb get` confirms active mode reflections.

---

### 13.33 Battery Power Architecture: Operating Modes, Mode Switch Key, and Fan Eco Policy

**1. Question & User Issue:**
1. Why can modes not be changed when on battery power in the GUI, even though Quiet (Eco) and Normal (Balanced) should be available?
2. Why does the physical Mode button on the keyboard cycle through all modes?
3. In fan control, why is Custom fan control disabled on battery power, and can it be enabled?
4. What other battery behaviors/settings exist in PredatorSense?

**2. Evidence & Ground Truth:**
- Vendor Angular bundle `main.8ed9dc924c527068.js` (`ev_52b9479edbce64cd7d199a81c04802cf9ded54cd8239ef3e3bfc373799c615ec`):
  - Offset `1276174` (`IsDC` definition):
    ```javascript
    get IsDC() { return this.apps.ACDCModeSet && this.IsUnplugAC; }
    ```
  - Offset `1506372` (`onBatteryPowerMode` and `IsDisableOperatingBtn`):
    ```javascript
    onBatteryPowerMode(t) {
        return this.common.IsDC ? [Ye.ECO, Ye.DEFAULT] : t.filter(e => e != Ye.ECO);
    }
    IsDisableOperatingBtn(t) {
        if (t != Ye.DEFAULT && t != Ye.ECO && (this.IsLowBattery || this.IsUnplugAC)) return true;
        ...
    }
    ```
  - Offset `1508762` (`PRESS_TURBO_BUTTON` handler):
    ```javascript
    case ee.PRESS_TURBO_BUTTON:
        if (this.common.IsUnplugAC) {
            ue == Ye.DEFAULT ? ge = Ye.ECO : ue == Ye.ECO && (ge = Ye.DEFAULT);
        } else {
            // Cycle through QUIET -> BALANCED -> PERFORMANCE -> TURBO
        }
    ```
  - Offset `1520690` / `1522779` (`app-fan-control` disabled logic):
    ```javascript
    ("disabled", i.currentMode == i.OPERATING_MODE.QUIET || i.currentMode == i.OPERATING_MODE.ECO || i.IsTurboLock)
    // Banner text: "Fan control has been disabled in Eco mode." / "Quiet mode."
    ```
  - Offset `1834289` & `1840483` (`OEM_SETTINGS` definitions):
    - `ACDCModeSet`: Enables split AC vs DC mode profiles.
    - `ModeSwitchKey` / `ModeSwitchKeyUI`: Unlocks Mode Key customization (Cycle Switching vs Turbo Toggle).
    - `windowsMenuKey`: Enables Windows key disable toggle in Settings.

**3. Root Cause Analysis:**
- **Mode Switching on Battery (Question 1):**
  - In `backend.js`, `getOEMSettings()` previously lacked `ACDCModeSet: true`.
  - As a result, `this.common.IsDC` evaluated to `false` even when running on battery (`IsUnplugAC == true`).
  - When `IsDC == false`, `onBatteryPowerMode(t)` filtered out `Ye.ECO` and displayed the standard AC plates (`QUIET`, `BALANCED`, `PERFORMANCE`, `TURBO`).
  - However, `IsDisableOperatingBtn(t)` checked `if (t != Ye.DEFAULT && t != Ye.ECO && this.IsUnplugAC) return true;`. This disabled `QUIET` (0), `PERFORMANCE` (4), and `TURBO` (5). Since `BALANCED` (1) was already selected, every clickable option was disabled!
- **Physical Mode Switch Button (Question 2):**
  - On Windows, `AcerAgentService` intercepts the mode key scan code and executes the JavaScript logic above: when on battery, it only toggles between `DEFAULT` $\leftrightarrow$ `ECO`.
  - On Linux, the hardware EC firmware / ACPI handler directly catches the key event and cycles through all available kernel `platform_profile` entries. Unless an input daemon specifically grabs the scancode and enforces policy, the firmware cycles through Quiet, Balanced, Performance, Turbo.
- **Fan Control on Battery (Question 3):**
  - In PredatorSense, Custom fan control is **not** disabled simply because the laptop is on battery.
  - Rather, fan control is disabled **whenever the mode is ECO or QUIET** (`i.currentMode == QUIET || i.currentMode == ECO`). In ECO/Quiet, the EC firmware locks fan speeds to an acoustic silent curve.
  - In **BALANCED / NORMAL** mode on battery, Custom fan control (and Max/Auto) is fully enabled!
- **Additional Settings (Question 4):**
  - `ModeSwitchKey` and `ModeSwitchKeyUI` expose the configuration card in Settings for the Mode key.
  - Battery Boost threshold ($40\%$): Performance and Turbo modes require $>40\%$ battery even if plugged into low-wattage USB-C.
  - Extreme/Turbo hardware lockout on battery: Intended to prevent battery brownout / cell degradation under high current draw (over 140W peak).

**4. Implementation & Fixes:**
1. **`ACDCModeSet: true` in `OEM_SETTINGS`:**
   - Set `ACDCModeSet: true`, `ModeSwitchKey: true`, `ModeSwitchKeyUI: true`, and `windowsMenuKey: true` in `OEM_SETTINGS` (`src/psense-electron/backend.js`).
   - When unplugged, `IsDC` becomes `true`. The UI presents the DC-specific modes: **ECO** (Quiet) and **BALANCED** (Normal).
   - Both modes are fully clickable, update `CurrentProfile.dcMode`, and persist cleanly.
2. **`KV_PAIRS` default for `SwitchKey`:**
   - Seeded default `SwitchKey: 0` (Cycle Switching) so `getSwitchKey` / `setSwitchKey` queries succeed cleanly without unhandled shim warnings.
3. **`scenario.setProfile` single-argument signature support:**
   - Updated `HANDLERS.scenario.setProfile` to handle both `[name, data]` and `[profileObject]` signatures. This ensures `CurrentProfile` saves from `setDCMode` and scenario mutations succeed without schema errors.
4. **DC Mode synchronization:**
   - In `HANDLERS.pssdk.setDeviceData` and `pumpOnce()`, synchronized `CurrentProfile.dcMode` when `acOn === false` so the GUI highlights ECO vs BALANCED accurately.

---

### 13.34 Battery Mode Switching (Eco $\leftrightarrow$ Balanced): `setDataWithoutScenario` Hardware Write Path & Pump Race Fix

**1. Symptom:**
- User reported inability to change mode from Eco to Balanced on battery power in the GUI.
- Clicking the Balanced mode button did not transition the hardware profile or the active plate selection reverted back to Eco.

**2. Evidence & Root Cause Analysis:**
- In the vendor bundle `main.8ed9dc924c527068.js` (offset `1839523` and `1520909`), mode switching behaves fundamentally differently on AC vs DC:
  - On **AC power**:
    `setACMode(t)` calls `operatingMode.setMode(t)`, which dispatches `pssdk.setDeviceData("OPERATING_MODE", t)`. In `backend.js`, `setDeviceData` applies `applyPssdkWrite("OPERATING_MODE", t)` immediately to `profile.set`.
  - On **DC (Battery) power**:
    `setDCMode(t)` calls:
    1. `EnableDCMode(e)` $\to$ `s.operatingMode.setModeWithoutScenario_And_RefreshUI(e)` $\to$ dispatches `pssdk.setDataWithoutScenario("OPERATING_MODE", e)`.
    2. Schedules `ExitEco(e)` / `EnableEco()` on a 1.9-second delayed timer (`this.delay_apply_lighting = 1900`).
- **The Defect in `backend.js`**:
  - `HANDLERS.pssdk.setDataWithoutScenario` previously had an explicit guard that only called `applyPssdkWrite` for `"LIGHTING"` (skipping `"OPERATING_MODE"` under the assumption that only `applyProfile` startup calls used it).
  - Because `applyPssdkWrite("OPERATING_MODE", e)` was skipped:
    - `/sys/firmware/acpi/platform_profile` in the Linux kernel remained in `"low-power"`.
    - Meanwhile, `backend.js`'s background pump tick runs every **1.0 second** (`pumpOnce`), polling `profile.get`.
    - At 1.0 second, `pumpOnce` detected that the hardware profile was still `"low-power"` (`m = 6`). Seeing `p.dcMode !== 6`, `pumpOnce` immediately overwrote `p.dcMode = 6` in scenario state and broadcast `ScenarioChanged`!
    - The GUI renderer received `ScenarioChanged` and reverted its plate highlight back to Eco before the 1.9-second `ExitEco` timer could even fire.
    - And if `this.IsEnableEco` was already false in the vendor component, `ExitEco` was skipped entirely.

**3. Implementation & Fix:**
- Updated `HANDLERS.pssdk.setDataWithoutScenario` in `src/psense-electron/backend.js`:
  ```javascript
  if (k === "OPERATING_MODE") {
      pssdkStore.set(k, data);
      try {
          const s = loadScenario();
          const p = s?.profiles?.[s.active];
          if (p) {
              const m = Number(data);
              if (readAcOnline() === false) {
                  p.dcMode = m;
              } else {
                  p.opMode = m;
                  if (m !== 5) p.LastOpMode = m;
              }
              saveScenario();
          }
      } catch (e) { log("scenario dcMode save failed:", e.message); }
      emit(k, data);
      await applyPssdkWrite(k, data);
      return null;
  }
  ```
- Now, when the user clicks Balanced (`1`) or Eco (`6`) on battery power:
  1. `setDataWithoutScenario` immediately executes `applyPssdkWrite("OPERATING_MODE", data)`.
  2. The daemon sets the kernel platform profile (`/sys/firmware/acpi/platform_profile`) to `balanced` (or `low-power`) within milliseconds.
  3. `CurrentProfile.dcMode` is updated and saved.
  4. When `pumpOnce` ticks, `profile.get` returns `balanced` (matching `dcMode = 1`), eliminating the race condition completely.
---

### 13.35 Physical Mode Switch Key Architecture: `acer_wmi.cycle_gaming_thermal_profile` & Battery Safety Clamp

**1. Context & User Requirement:**
- Physical keyboard "Mode" button cycles through profiles on Linux.
- In PredatorSense Settings, the user can configure the key behavior: "Cycle Switching" vs. "Turbo On/Off".
- Furthermore, on battery power, higher performance profiles (Performance, Turbo) must not be engaged to protect the battery pack from excessive C-rate discharge and voltage sag.

**2. Kernel Driver Evidence (`acer_wmi`):**
- Modern Linux kernels (6.8+) implement thermal profile switching directly inside `drivers/platform/x86/acer-wmi.c`.
- Exposes sysfs parameter: `/sys/module/acer_wmi/parameters/cycle_gaming_thermal_profile` (read/write by root):
  - `'Y'`: Physical mode key cycles through thermal profiles sequentially (`quiet` $\to$ `balanced` $\to$ `balanced-performance` $\to$ `performance`).
  - `'N'`: Physical mode key toggles between `performance` and the previous non-turbo profile.
- Maps 1:1 to the PredatorSense `SwitchKey` vendor enum:
  - `0` (`$l.CycleSwitch`): `'Y'`
  - `1` (`$l.TurboOnOff`): `'N'`

**3. Implementation:**
1. **Daemon ops (`src/psensed`):**
   - Added `switchkey.get`: reads `/sys/module/acer_wmi/parameters/cycle_gaming_thermal_profile` and returns `mode: 0` (Y) or `1` (N).
   - Added `switchkey.set`: writes `'Y'` or `'N'` to `/sys/module/acer_wmi/parameters/cycle_gaming_thermal_profile` with root permissions.
2. **CLI interface (`src/psense`):**
   - Added `psense switchkey [get|set] [cycle|turbo]`.
3. **Backend & GUI sync (`src/psense-electron/backend.js`):**
   - Implemented `HANDLERS.info.setSwitchKey` and `getSwitchKey` to persist setting and synchronize `/sys/module/acer_wmi/parameters/cycle_gaming_thermal_profile` via `daemonCall("switchkey.set")`.
   - In `pumpOnce()`: Added battery safety clamp. When unplugged (`acOn === false`), if a keypress or kernel event lands on `balanced-performance` (`4`) or `performance` (`5`), `pumpOnce` immediately clamps the mode back to `balanced` (`1`), safeguarding the battery cells and keeping GUI state synchronized.





### 13.36 EC-native keyboard animation WORKS — "drops backlight" was a frame-layout bug; live probe session (2026-10-19, PHN16-71)

**Supersedes:** the "4-zone keyboard EC method 20 drops backlight if not zone-animated"
interpretation (§13.32 resolution follow-ups, pulsar plan doc) and explains why animated
modes kept misbehaving after the §13.32 RGB fix.

**1. Live experiments (all through `psense wmi gaming` ⇄ psensed, socket group-accessible):**

| # | Write (method, u64-in) | Ack | `kb.get` echo → decoded state |
|---|---|---|---|
| B | id 20, controller layout `01 03 64 03 c7 3e 14 00 03 01` (mode 1 BREATHING, speed 3, bri 100, dir+1=3, RGB c7/3e/14 @ [4..6]) | 0 | `00 01 03 64 00 c7 3e 14 00 03` → **[1]=mode 1, [2]=speed 3, [3]=bri 100, [5..7]=frame RGB EXACT**. User-confirmed: keyboard BREATHES orange at full brightness, backlight NOT dropped. |
| A | id 6, multi-zone mask `0f c7 3e 14 …` (mask 0x0F instead of single bits) | 0 | echo color slots moved once (~×0.86 of written) then froze: green probe `0f 00 ff 00 …` → **no echo change at all** ⇒ multi-bit mask fan-out is a NO-OP (or writes a hidden slot); not usable. Per-zone single-bit writes (1/2/4/8) remain mandatory. |
| S | id 20, controller layout mode 0 speed 0 `00 00 64 00 c7 3e 14 00 03 01` | 0 | `00 00 00 64 00 00 3e 14 00 03` → [1]=mode 0, [2]=speed 0, [3]=bri 100; frame-RGB echo slot partially zeroed in STATIC (display comes from the id-6 zone store, so visual correctness unaffected). |

**2. EC state readout (kb.get, method 21) — live-calibrated slot map:**
`[1]=mode, [2]=speed, [3]=brightness, [4]=direction, [5..7]=16-B frame RGB,
[6..8]=zone-store RGB (overlapping echo window; after id-6 zone writes the visible
color sits here), [9]=0x03 on-flag`. The old parse ([2]=mode, [6..8]=rgb) was off by
one — §13.32's "kb get confirms active mode reflections" verification actually read the
SPEED byte as the mode (e.g. `01036400…` echoed as "mode 3").

**3. Root cause of the "backlight drop":**
- All prior animated writes used the `AcerLightingService.exe` composer layout
  (`[3]=0, [4]=dir, RGB @ [5..7]`, §13.14.4) — that composer targets the strip/lightbar
  path. The EC keyboard device consumes the `AcerECKeyboardController.dll::SetMode`
  layout: `[0]=mode [1]=speed [2]=brightness [3]=direction+1 [4..6]=RGB [7]=0 [8]=0x03
  [9]=device` (§13.14, §13.22).
- With the old layout every byte landed one slot late: EC RGB=(dir, r, g) (near-black),
  and the blue channel hit the on-flag byte ⇒ black/dropped backlight even with a valid
  RGB payload (§13.32's fix put rgb at [5..7] — still shifted). Static mode never showed
  the bug because STATIC's visuals come from the zone store, not the frame RGB.
- Conclusion: **the EC animates BREATHING/SHIFTING/METEOR/TWINKLING natively on this
  4-zone keyboard**. One method-20 write replaces the whole userspace animation loop
  (which measured ~0.3 core: 26 fps target self-throttled to ~18 zone-write evals/s ×
  ~15-20 ms kernel-busy each via SMM).

**4. Wiring (`src/psensed`, 2026-10-19):**
- `_kb_frame()` builds the controller layout for ALL method-20 writes; `kb.set` forces
  speed=0 for STATIC/DIRECT (§13.20).
- `kb.effect.set` maps `BREATHING→1, SHIFTING→4, METEOR→6, TWINKLING→7` (plus alias
  `NEON→SHIFTING`) to ONE EC-native frame; `WAVE`/`RAINBOW` and reactive `SCREEN`/`MUSIC`
  stay on the software engine (`DaemonLightingEngine`). `kb.effect.get` reports which
  engine owns the active effect (`engine: ec-native | software`).
- `kb.effect.stop` / `kb.zone.set` / `kb.restore(stop)` retire the EC frame with a
  mode-0 write (`_kb_ensure_static`) — the EC's frame registers persist across daemon
  restarts, so a stale animation must never keep running over fresh zone colors.

**5. Not yet live-verified:** WAVE/NEON brightness on the strip ids (left on the software
engine — unnecessary), direction+1 clamping for directional effects (SHIFTING/METEOR —
visual check pending), and whether the EC applies the frame's brightness byte globally in
animated modes (test B used bri 100).
