# Contributing to Predator Sense Linux

Thank you for your interest in improving Predator Sense Linux! We welcome contributions of all kinds: hardware compatibility reports, bug fixes, packaging for additional distributions, feature additions, and documentation improvements.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Prerequisites & Development Environment](#prerequisites--development-environment)
- [Running & Building Locally](#running--building-locally)
  - [1. Running the Daemon (`psensed`)](#1-running-the-daemon-psensed)
  - [2. Testing the CLI (`psense`)](#2-testing-the-cli-psense)
  - [3. Running the Electron GUI in Dev Mode](#3-running-the-electron-gui-in-dev-mode)
  - [4. Packaging & Building RPMs](#4-packaging--building-rpms)
- [Adding & Testing New Laptop Models](#adding--testing-new-laptop-models)
  - [Step 1: Identify Your Hardware](#step-1-identify-your-hardware)
  - [Step 2: Inspect WMI Devices & ACPI Tables](#step-2-inspect-wmi-devices--acpi-tables)
  - [Step 3: Safe Method Probing via CLI](#step-3-safe-method-probing-via-cli)
  - [Step 4: Submitting Hardware Quirks](#step-4-submitting-hardware-quirks)
- [Coding Guidelines & Standards](#coding-guidelines--standards)
  - [Zero-Telemetry & Privacy Guarantee](#zero-telemetry--privacy-guarantee)
  - [Python Code (`psense` CLI)](#python-code-psense-cli)
  - [JavaScript / Electron (`psense-electron`)](#javascript--electron-psense-electron)
  - [C Kernel Driver (`psense-wmi`)](#c-kernel-driver-psense-wmi)
  - [Shell Scripts & Packaging](#shell-scripts--packaging)
- [Pull Request Workflow](#pull-request-workflow)

---

## Code of Conduct

We are committed to providing a friendly, safe, and welcoming environment for everyone. Please be respectful, constructive, and collaborative in all communications.

---

## Prerequisites & Development Environment

To build and run all components from source, install the following packages for your distribution:

### Fedora / RHEL
```bash
sudo dnf install -y git gcc make dkms kernel-devel \
    nodejs npm python3 python3-devel rpm-build rpmlint \
    smartmontools acpica-tools
```

### Ubuntu / Debian
```bash
sudo apt install -y git gcc make dkms linux-headers-$(uname -r) \
    nodejs npm python3 python3-dev \
    smartmontools acpidump iasl
```

### Arch Linux
```bash
sudo pacman -S --needed git gcc make dkms linux-headers \
    nodejs npm python smartmontools acpica
```

---

## Running & Building Locally

### 1. Running the Daemon (`psensed`)

The daemon can be run directly from the source tree for testing:

```bash
# Build and install the kernel module first if not already present:
sudo bash src/psense-wmi/install-dkms.sh

# Run the daemon in foreground mode with debug output:
sudo ./src/psensed
```

The daemon listens on `/run/psense.sock` with permissions `0660 root:wheel`.

### 2. Testing the CLI (`psense`)

The CLI is a standalone Python 3 script using standard library modules:

```bash
# Run directly against the active socket:
python3 src/psense checkup
python3 src/psense sensors
python3 src/psense profile list
python3 src/psense info
```

### 3. Running the Electron GUI in Dev Mode

```bash
cd src/psense-electron

# Install dependencies
npm install

# Launch with developer tools enabled
PS_DEVTOOLS=1 npm start
```

### 4. Packaging & Building RPMs

To verify packaging and ensure Fedora / openSUSE compliance:

```bash
# 1. Create the release tarball
packaging/make-tar.sh

# 2. Build RPM packages into dist/rpm
rpmbuild -bb packaging/predator-sense.spec \
    --define "_sourcedir $PWD/dist" \
    --define "_rpmdir $PWD/dist/rpm"

# 3. Verify compliance with rpmlint (must report 0 errors, 0 warnings)
rpmlint -r packaging/predator-sense.rpmlintrc packaging/predator-sense.spec dist/rpm/x86_64/*.rpm
```

---

## Adding & Testing New Laptop Models

Acer uses shared WMI interfaces across the Predator Helios, Triton, and Nitro lines, but individual models may have subtle method ID differences, different fan counts, or unique keyboard lighting zones.

### Step 1: Identify Your Hardware

Capture your exact DMI parameters:

```bash
echo "Vendor:  $(cat /sys/class/dmi/id/sys_vendor)"
echo "Product: $(cat /sys/class/dmi/id/product_name)"
echo "Board:   $(cat /sys/class/dmi/id/board_name)"
echo "BIOS:    $(cat /sys/class/dmi/id/bios_version)"
```

### Step 2: Inspect WMI Devices & ACPI Tables

Check if the standard Acer Gaming WMI devices are present:

```bash
ls -l /sys/bus/wmi/devices/
```

Look for GUIDs:
- `7A4DDFE7-05D4-4860-B3E1-0E2040E35D22` (`AcerGamingFunction`)
- `79772EC5-037D-464A-A4D9-6A42E468A6B0` (`BatteryControl`)

To inspect the raw ACPI dispatch methods:
```bash
sudo acpidump -b
iasl -d *.dat
grep -rn "7A4DDFE7" .
```

### Step 3: Safe Method Probing via CLI

Use the safe `psense wmi` CLI evaluator to inspect responses without triggering unsupported writes:

```bash
# Read gaming function support capabilities:
psense wmi gaming 23 02000000 --out 8

# Query battery function support:
psense battmode get
```

### Step 4: Submitting Hardware Quirks

If your laptop model requires custom handling:
1. Document the DMI string from Step 1.
2. Note the working method IDs and fan indices.
3. Open an issue or pull request with your findings and output of `psense checkup` and `psense info`.

---

## Coding Guidelines & Standards

### Zero-Telemetry & Privacy Guarantee
- **Absolute Rule**: Never introduce network calls to analytics, crash reporting, telemetry, or third-party servers.
- All operations, diagnostics, and monitoring must run completely locally and offline.
- Do not collect machine serial numbers or transmit identifiable data.

### Python Code (`psense` CLI)
- Use standard library modules only for `src/psense`. Do not introduce runtime `pip` dependencies.
- Follow PEP 8 style guidelines.
- Target Python 3.8+ compatibility.
- Ensure all commands handle daemon disconnection gracefully.

### JavaScript / Electron (`psense-electron`)
- Keep business logic cleanly divided between `main.js` (IPC, window lifecycle, tray, overlay) and `backend.js` (service shim, socket client, scenario store).
- Respect the offline security policy; never disable certificate verification for remote origins.
- Pulsar dynamic lighting effects belong in `lighting-engine.js` with smooth HSV/RGB interpolation and hardware-safe rate limiting.

### C Kernel Driver (`psense-wmi`)
- Follow Linux kernel coding style (`Documentation/process/coding-style.rst`).
- All user-accessible ioctls must enforce strict input size and parameter validation.
- Maintain the inter-evaluation pacing (30 ms hardware safety interval) to prevent SMM race conditions.
- Keep the GUID and method allow-list strict.

### Shell Scripts & Packaging
- Shell scripts must pass `shellcheck` with zero warnings.
- Always include `set -euo pipefail` at the start of bash scripts.
- RPM spec files must pass `rpmlint` with zero errors and zero warnings.

---

## Pull Request Workflow

1. **Fork the Repository**: Create a personal fork on GitHub.
2. **Create a Feature Branch**:
   ```bash
   git checkout -b feature/model-support-ph18
   ```
3. **Commit Your Changes**: Follow Conventional Commits conventions:
   - `feat(fans): add support for tertiary auxiliary fan curve`
   - `fix(lighting): resolve meteor animation stutter at 60fps`
   - `docs(readme): update arch linux installation guide`
4. **Test Before Submitting**:
   - Run `python3 src/psense checkup`.
   - Run `node -c src/psense-electron/main.js` and `backend.js`.
   - If modifying packaging, run `make-tar.sh` and `rpmlint`.
5. **Open a Pull Request**: Provide a clear summary of changes, test results, and specify the laptop model tested.
