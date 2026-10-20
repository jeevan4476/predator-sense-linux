# Predator Sense Linux — Electron exact clone (their renderer + our ddsc shim)

Runs the **original Predator Sense 5.0.1.463 Angular renderer** (`app/dist/widgets/main`,
shipped unchanged from the Windows bundle) with a Linux shim that fakes the
backend: window.ddsc.* calls go to the local root daemon `psensed`
(`/run/psense.sock`), not their MQTT/Cert/NodeRT stack.

## Run

```bash
cd ~/projects/predator-sense-linux/src/psense-electron
npm install electron      # one-time (Electron runtime, ~250 MB)
npx electron .            # launch
```

Debug console of dispatched-but-unimplemented functions:
`PS_DEVTOOLS=1 npx electron .` (devtools; every unknown `ddsc.<module>.<func>`
prints `[backend] unhandled func ...` to the terminal → tells us what to map next).

## Files

| file | role |
|---|---|
| `main.js` | Electron main: their BrowserWindow config 1:1 + ipc handle 'ddsc-dispatch' |
| `preload.js` | builds window.ddsc from ddsc-table.json (replaces their MQTT preload) |
| `backend.js` | dispatch → psensed ops / scenario store / OS stubs |
| `ddsc-table.json` | inventoried 126 fn surface (analysis ledger §13.19) |
| `app/` | their unchanged renderer payload |

Scenario state: `~/.config/predator-sense-linux-scenario.json`.
