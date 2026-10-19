"""psensed_gpu_oc — OEM INI GPU Overclocking Engine for psensed.

Reads per-model OEM INI configurations (e.g. Predator PHN16-71.ini) extracted
from Predator Sense AgentService/driver, maps system ACPI platform_profile / thermal
modes to GPU core and memory clock offsets, and safely applies them via NVML or nvidia-settings.
"""

import configparser
import ctypes
import glob
import os
import re
import shutil
import subprocess
from typing import Any, Callable, Dict, Optional, Tuple


def detect_model(dmi_root: str = "/sys/class/dmi/id") -> str:
    """Read laptop model name from sysfs DMI."""
    for fn in ("product_name", "board_name"):
        p = os.path.join(dmi_root, fn)
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    val = f.read().strip()
                if val:
                    return val
        except OSError:
            pass
    return "Unknown"


def detect_gpu(pci_root: str = "/sys/bus/pci/devices") -> Optional[str]:
    """Detect NVIDIA GPU PCI vendor/device ID in Windows HWID format:
    e.g. PCI\\VEN_10DE&DEV_28E1&SUBSYS_170F1025 or PCI\\VEN_10DE&DEV_28E1.
    """
    try:
        for dev_path in glob.glob(os.path.join(pci_root, "*")):
            try:
                v_path = os.path.join(dev_path, "vendor")
                c_path = os.path.join(dev_path, "class")
                d_path = os.path.join(dev_path, "device")
                if not (os.path.isfile(v_path) and os.path.isfile(c_path) and os.path.isfile(d_path)):
                    continue

                with open(v_path, "r", encoding="utf-8") as f:
                    ven = f.read().strip().lower().replace("0x", "")
                if ven != "10de":
                    continue

                with open(c_path, "r", encoding="utf-8") as f:
                    pci_class = f.read().strip().lower()
                # 0x03xxxx: Display controller (VGA / 3D controller)
                if not pci_class.startswith("0x03"):
                    continue

                with open(d_path, "r", encoding="utf-8") as f:
                    dev = f.read().strip().lower().replace("0x", "")

                sub_dev, sub_ven = "", ""
                try:
                    sd_path = os.path.join(dev_path, "subsystem_device")
                    sv_path = os.path.join(dev_path, "subsystem_vendor")
                    if os.path.isfile(sd_path) and os.path.isfile(sv_path):
                        with open(sd_path, "r", encoding="utf-8") as f:
                            sub_dev = f.read().strip().lower().replace("0x", "")
                        with open(sv_path, "r", encoding="utf-8") as f:
                            sub_ven = f.read().strip().lower().replace("0x", "")
                except OSError:
                    pass

                if sub_dev and sub_ven:
                    # Windows subsystem ID format: <subsystem_device><subsystem_vendor>
                    return f"PCI\\VEN_{ven.upper()}&DEV_{dev.upper()}&SUBSYS_{sub_dev.upper()}{sub_ven.upper()}"
                return f"PCI\\VEN_{ven.upper()}&DEV_{dev.upper()}"
            except OSError:
                continue
    except Exception:
        pass

    # Fallback to lspci if sysfs failed
    if shutil.which("lspci"):
        try:
            res = subprocess.run(["lspci", "-nn", "-d", "10de:"],
                                 capture_output=True, text=True, timeout=2)
            m = re.search(r"10de:([0-9a-fA-F]{4})", res.stdout)
            if m:
                return f"PCI\\VEN_10DE&DEV_{m.group(1).upper()}"
        except Exception:
            pass

    return None


_DEFAULT_DETECT = object()


class GpuOverclockManager:
    """Manages OEM GPU overclocking offsets across thermal modes."""

    # Default fallback profiles for common Acer Predator models if INI missing
    BUNDLED_FALLBACKS = {
        "Predator PHN16-71": {
            "turbo_core": 100,
            "turbo_mem": 200,
            "default_core": 0,
            "default_mem": 0,
        }
    }

    def __init__(
        self,
        ini_path: Optional[str] = None,
        model: Any = _DEFAULT_DETECT,
        gpu_id: Any = _DEFAULT_DETECT,
        profile_dir: Optional[str] = None,
        apply_fn: Optional[Callable[[int, int], Tuple[bool, Optional[str]]]] = None,
    ):
        self.apply_fn = apply_fn
        self.model = detect_model() if model is _DEFAULT_DETECT else (model or "Unknown")
        self.gpu_id = detect_gpu() if gpu_id is _DEFAULT_DETECT else (gpu_id or None)
        self.profile_dir = profile_dir
        self.current_mode = "default"
        self.current_core_offset = 0
        self.current_mem_offset = 0
        self.applied = False
        self.error: Optional[str] = None

        self.profile_data: Dict[str, int] = {
            "turbo_core": 0,
            "turbo_mem": 0,
            "default_core": 0,
            "default_mem": 0,
        }
        self.supported = False

        if not self.gpu_id:
            self.supported = False
            self.error = "No NVIDIA GPU detected"
            return

        self._load_profile(ini_path)

    def _find_profile_file(self, ini_path: Optional[str]) -> Optional[str]:
        if ini_path and os.path.isfile(ini_path):
            return ini_path

        search_dirs = []
        if self.profile_dir:
            search_dirs.append(self.profile_dir)

        search_dirs.extend([
            "/etc/predator-sense/models",
            "/usr/share/predator-sense/models",
            os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "analysis", "reference", "predator-sense", "PredatorSense_5.0.1463",
                "AgentService", "driver"
            ),
        ])

        candidates = [
            f"{self.model}.ini",
            f"Predator {self.model}.ini" if not self.model.startswith("Predator") else f"{self.model}.ini",
        ]

        for sdir in search_dirs:
            if not os.path.isdir(sdir):
                continue
            for cand in candidates:
                fp = os.path.join(sdir, cand)
                if os.path.isfile(fp):
                    return fp

        return None

    def _load_profile(self, ini_path: Optional[str]):
        profile_path = self._find_profile_file(ini_path)
        matched_section = None

        if profile_path and os.path.isfile(profile_path):
            cp = configparser.ConfigParser(inline_comment_prefixes=("#", ";"))
            try:
                cp.read(profile_path, encoding="utf-8")
                # Look for matching GPU section
                gpu_id_upper = (self.gpu_id or "").upper()
                # 1. Exact match
                for sec in cp.sections():
                    if sec.upper() == gpu_id_upper:
                        matched_section = cp[sec]
                        break

                # 2. Substring or VEN+DEV match
                if matched_section is None:
                    # Extract VEN_XXXX&DEV_YYYY
                    m = re.search(r"VEN_[0-9A-F]+&DEV_[0-9A-F]+", gpu_id_upper)
                    ven_dev = m.group(0) if m else None
                    if ven_dev:
                        for sec in cp.sections():
                            if ven_dev in sec.upper():
                                matched_section = cp[sec]
                                break

                if matched_section is not None:
                    turbo = matched_section.getint("Turbo", fallback=100)
                    ram_turbo = matched_section.getint("RAM_Turbo", fallback=200)
                    quiet = matched_section.getint("Quiet", fallback=0)
                    ram_quiet = matched_section.getint("RAM_Quiet", fallback=0)
                    self.profile_data = {
                        "turbo_core": turbo,
                        "turbo_mem": ram_turbo,
                        "default_core": quiet,
                        "default_mem": ram_quiet,
                    }
                    self.supported = True
                    return
            except Exception as e:
                self.error = f"Failed to parse INI profile: {e}"

        # Fallback to bundled profile if available for this model
        for known_model, data in self.BUNDLED_FALLBACKS.items():
            if known_model.lower() in self.model.lower():
                self.profile_data = dict(data)
                self.supported = True
                return

        # If it's an NVIDIA GPU on a Predator model, provide safe standard OEM defaults (+100/+200)
        if self.gpu_id and "10DE" in self.gpu_id.upper():
            self.profile_data = {
                "turbo_core": 100,
                "turbo_mem": 200,
                "default_core": 0,
                "default_mem": 0,
            }
            self.supported = True
        else:
            self.supported = False
            self.error = self.error or "No matching GPU profile found"

    def resolve_offsets(self, mode: Any) -> Tuple[int, int]:
        """Map profile / thermal mode to (core_offset_mhz, mem_offset_mhz)."""
        m = str(mode).lower().strip()
        if m in ("performance", "turbo", "extreme", "4"):
            return self.profile_data.get("turbo_core", 100), self.profile_data.get("turbo_mem", 200)
        # Quiet / Balanced / Eco / Default / 0 / 1 / 2 / 3
        return self.profile_data.get("default_core", 0), self.profile_data.get("default_mem", 0)

    def _apply_nvml(self, core_offset: int, mem_offset: int) -> Tuple[bool, Optional[str]]:
        """Attempt to apply clock offsets directly via NVML (ctypes)."""
        nvml_lib = None
        for libname in ("libnvidia-ml.so.1", "libnvidia-ml.so"):
            try:
                nvml_lib = ctypes.CDLL(libname)
                break
            except Exception:
                pass

        if not nvml_lib:
            return False, "libnvidia-ml.so not found"

        try:
            if hasattr(nvml_lib, "nvmlInit_v2"):
                nvml_lib.nvmlInit_v2.restype = ctypes.c_int
                init_ret = nvml_lib.nvmlInit_v2()
            elif hasattr(nvml_lib, "nvmlInit"):
                nvml_lib.nvmlInit.restype = ctypes.c_int
                init_ret = nvml_lib.nvmlInit()
            else:
                return False, "nvmlInit symbol not found"

            if init_ret != 0:
                return False, f"nvmlInit failed (code {init_ret})"

            try:
                handle = ctypes.c_void_p()
                if hasattr(nvml_lib, "nvmlDeviceGetHandleByIndex_v2"):
                    get_dev = nvml_lib.nvmlDeviceGetHandleByIndex_v2
                elif hasattr(nvml_lib, "nvmlDeviceGetHandleByIndex"):
                    get_dev = nvml_lib.nvmlDeviceGetHandleByIndex
                else:
                    return False, "nvmlDeviceGetHandleByIndex missing"

                get_dev.argtypes = [ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
                get_dev.restype = ctypes.c_int
                dev_ret = get_dev(0, ctypes.byref(handle))
                if dev_ret != 0 or not handle.value:
                    return False, f"nvmlDeviceGetHandleByIndex failed (code {dev_ret})"

                errs = []
                if hasattr(nvml_lib, "nvmlDeviceSetGpcClkVfOffset"):
                    nvml_lib.nvmlDeviceSetGpcClkVfOffset.argtypes = [ctypes.c_void_p, ctypes.c_int]
                    nvml_lib.nvmlDeviceSetGpcClkVfOffset.restype = ctypes.c_int
                    r1 = nvml_lib.nvmlDeviceSetGpcClkVfOffset(handle, int(core_offset))
                    if r1 != 0:
                        errs.append(f"core offset error code {r1}")
                else:
                    errs.append("nvmlDeviceSetGpcClkVfOffset missing")

                if hasattr(nvml_lib, "nvmlDeviceSetMemClkVfOffset"):
                    nvml_lib.nvmlDeviceSetMemClkVfOffset.argtypes = [ctypes.c_void_p, ctypes.c_int]
                    nvml_lib.nvmlDeviceSetMemClkVfOffset.restype = ctypes.c_int
                    r2 = nvml_lib.nvmlDeviceSetMemClkVfOffset(handle, int(mem_offset))
                    if r2 != 0:
                        errs.append(f"mem offset error code {r2}")
                else:
                    errs.append("nvmlDeviceSetMemClkVfOffset missing")

                if errs:
                    return False, "; ".join(errs)
                return True, None
            finally:
                if hasattr(nvml_lib, "nvmlShutdown"):
                    nvml_lib.nvmlShutdown.restype = ctypes.c_int
                    try:
                        nvml_lib.nvmlShutdown()
                    except Exception:
                        pass
        except Exception as e:
            return False, f"NVML exception: {e}"

    def _apply_nvidia_settings(self, core_offset: int, mem_offset: int) -> Tuple[bool, Optional[str]]:
        """Attempt to apply clock offsets via nvidia-settings command."""
        if not shutil.which("nvidia-settings"):
            return False, "nvidia-settings binary not found"

        attempts = [
            [
                "-a", f"[gpu:0]/GPUGraphicsClockOffsetAll_Performance_Levels={core_offset}",
                "-a", f"[gpu:0]/GPUMemoryTransferRateOffsetAll_Performance_Levels={mem_offset}",
            ],
            [
                "-a", f"[gpu:0]/GPUGraphicsClockOffset[3]={core_offset}",
                "-a", f"[gpu:0]/GPUMemoryTransferRateOffset[3]={mem_offset}",
            ],
            [
                "-a", f"[gpu:0]/GPUGraphicsClockOffset[4]={core_offset}",
                "-a", f"[gpu:0]/GPUMemoryTransferRateOffset[4]={mem_offset}",
            ],
        ]

        last_err = None
        for args in attempts:
            try:
                res = subprocess.run(
                    ["nvidia-settings"] + args,
                    capture_output=True,
                    text=True,
                    timeout=3
                )
                if res.returncode == 0:
                    return True, None
                last_err = res.stderr.strip() or res.stdout.strip() or f"exit code {res.returncode}"
            except Exception as e:
                last_err = str(e)

        return False, f"nvidia-settings error: {last_err}"

    def _apply_hardware_offsets(self, core_offset: int, mem_offset: int) -> Tuple[bool, Optional[str]]:
        """Safely applies offsets via custom apply_fn, NVML, or nvidia-settings."""
        if self.apply_fn is not None:
            try:
                return self.apply_fn(core_offset, mem_offset)
            except Exception as e:
                return False, f"apply_fn exception: {e}"

        if not self.supported:
            return False, "GPU overclocking not supported on this platform"

        # 1. Try NVML
        ok, nvml_err = self._apply_nvml(core_offset, mem_offset)
        if ok:
            return True, None

        # 2. Try nvidia-settings fallback
        ok, ns_err = self._apply_nvidia_settings(core_offset, mem_offset)
        if ok:
            return True, None

        return False, f"Hardware apply failed (NVML: {nvml_err}; nvidia-settings: {ns_err})"

    def apply_mode(self, profile_name: Any) -> Dict[str, Any]:
        """Map profile name to offsets and apply them."""
        self.current_mode = str(profile_name)
        core, mem = self.resolve_offsets(profile_name)
        self.current_core_offset = core
        self.current_mem_offset = mem

        if not self.supported:
            self.applied = False
            self.error = self.error or "GPU overclocking not supported on this platform"
            return self.get_status()

        applied, err = self._apply_hardware_offsets(core, mem)
        self.applied = applied
        self.error = err
        return self.get_status()

    def set_offsets(self, core: int, mem: int) -> Dict[str, Any]:
        """Manual override for core and memory offsets."""
        self.current_mode = "manual"
        self.current_core_offset = int(core)
        self.current_mem_offset = int(mem)

        if not self.supported:
            self.applied = False
            self.error = self.error or "GPU overclocking not supported on this platform"
            return self.get_status()

        applied, err = self._apply_hardware_offsets(self.current_core_offset, self.current_mem_offset)
        self.applied = applied
        self.error = err
        return self.get_status()

    def get_status(self) -> Dict[str, Any]:
        """Return current status of the GPU overclocking engine."""
        return {
            "supported": bool(self.supported),
            "model": str(self.model),
            "gpu_id": str(self.gpu_id or "none"),
            "mode": str(self.current_mode),
            "core_offset_mhz": int(self.current_core_offset),
            "mem_offset_mhz": int(self.current_mem_offset),
            "applied": bool(self.applied),
            "error": self.error,
        }
