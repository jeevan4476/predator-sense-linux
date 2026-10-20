/**
 * ddsc preload shim (.ts twin — migrated in P2; contract identical to
 * preload.js at 1:1 behavior; B-lite: tsc emits preload.js in place).
 *
 * Their preload "ddsc.js" connects to wss://localhost:15150/mqtt, asks the
 * backend PWARuntime for getAllFuncs and builds `window.ddsc =
 * {<module>:{<func>: (...args) => mqtt-call}}`. We build the IDENTICAL object
 * straight from ddsc-table.json and route every call over ipc
 * 'ddsc-dispatch' → backend.js — no MQTT, no Express, no Windows deps.
 *
 * window.InitDDSC stays (async awaitable, resolves immediately) because the
 * Angular bootstrap may await it.
 */

// CJS import= form: tsc emits `require("./ddsc-table.json")` while the
// typing comes from the GENERATED ddsc-table.d.ts (tools/generate-ddsc-dts.mjs).
import table = require("./ddsc-table.json");
import type { IpcRendererEvent } from "electron";

type DdscFn = (...args: unknown[]) => Promise<unknown>;
type DdscCb = (...args: unknown[]) => void;
type EvListener = (e: IpcRendererEvent, evt: string, ...args: unknown[]) => void;

type DdscRuntime = {
    [M in keyof DdscTable]: { [F in DdscTable[M][number]]: DdscFn };
} & {
    on: (ev: string, cb: DdscCb) => () => void;
    off: (ev: string, cb: DdscCb) => void;
    broadcast: (ev: string, ...args: unknown[]) => Promise<unknown>;
};

declare global {
    interface Window {
        ddsc: DdscRuntime;
        InitDDSC: () => Promise<void>;
    }
}

const { ipcRenderer }: { ipcRenderer: Electron.IpcRenderer } = require("electron");

// broadcast/event API the renderer uses for live data pushes.
// main.js mirrors every MQTT broadcast to channel "ddsc-broadcast".
const pairs = new Map<string, Map<DdscCb, EvListener>>();   // ev -> Map(cb -> listener)

const offImpl = (ev: string, cb: DdscCb): void => {
    const m = pairs.get(ev); if (!m) return;
    const l = m.get(cb);
    if (l) { ipcRenderer.removeListener("ddsc-broadcast", l); m.delete(cb); }
};

const onImpl = (ev: string, cb: DdscCb): (() => void) => {
    let m = pairs.get(ev);
    if (!m) { m = new Map(); pairs.set(ev, m); }
    const l: EvListener = (_e, evt, ...p) => { if (evt === ev) cb(...p); };
    m.set(cb, l);
    ipcRenderer.on("ddsc-broadcast", l);
    return () => offImpl(ev, cb);
};

const broadcastImpl = (ev: string, ...args: unknown[]): Promise<unknown> => {
    return ipcRenderer.invoke("ddsc-dispatch", "_events", ev, args);
};

const ddsc: Record<string, Record<string, DdscFn>> = {};
const tableKeys = Object.keys(table) as (keyof DdscTable)[];
for (const mod of tableKeys) {
    ddsc[mod] = {};
    for (const fn of table[mod]) {   // funcs: DdscTable[mod] -> string list from the generated table
        ddsc[mod][fn] = (...args: unknown[]) =>
            ipcRenderer.invoke("ddsc-dispatch", mod, fn, args);
    }
}
Object.assign(ddsc, { on: onImpl, off: offImpl, broadcast: broadcastImpl });

window.ddsc = ddsc as unknown as DdscRuntime;
window.InitDDSC = async () => { console.info("[ddsc shim] InitDDSC() resolved"); };

// error visibility: angular swallows stacks through its error handler
window.addEventListener("error", (e: ErrorEvent) => {
    console.error("[boot-hook] error:", e.message, "@", e.filename?.split("/").pop(), e.lineno, e.colno,
        "\n", (e.error && e.error.stack || "").slice(0, 900));
});
window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    console.error("[boot-hook] rejection:", e.reason && (e.reason.message || e.reason),
        "\n", (e.reason && e.reason.stack || "").slice(0, 900));
});
console.info("[ddsc shim] ready:", Object.keys(ddsc).join(","));
