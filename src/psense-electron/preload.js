/* ddsc preload shim (replaces their ddsc.js MQTT preload).
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
const { ipcRenderer } = require("electron");
const table = require("./ddsc-table.json");

const ddsc = {};
for (const [module, funcs] of Object.entries(table)) {
    ddsc[module] = {};
    for (const fn of funcs) {
        ddsc[module][fn] = (...args) =>
            ipcRenderer.invoke("ddsc-dispatch", module, fn, args);
    }
}
// broadcast/event API the renderer uses for live data pushes.
// main.js mirrors every MQTT broadcast to channel "ddsc-broadcast".
const pairs = new Map();   // ev -> Map(cb -> listener)
ddsc.on = (ev, cb) => {
    let m = pairs.get(ev);
    if (!m) { m = new Map(); pairs.set(ev, m); }
    const l = (_e, evt, ...p) => { if (evt === ev) cb(...p); };
    m.set(cb, l);
    ipcRenderer.on("ddsc-broadcast", l);
    return () => ddsc.off(ev, cb);
};
ddsc.off = (ev, cb) => {
    const m = pairs.get(ev); if (!m) return;
    const l = m.get(cb);
    if (l) { ipcRenderer.removeListener("ddsc-broadcast", l); m.delete(cb); }
};
ddsc.broadcast = (ev, ...args) => {
    ipcRenderer.invoke("ddsc-dispatch", "_events", ev, args);
};

window.ddsc = ddsc;
window.InitDDSC = async () => { console.info("[ddsc shim] InitDDSC() resolved"); };
// error visibility: angular swallows stacks through its error handler
window.addEventListener("error", (e) => {
    console.error("[boot-hook] error:", e.message, "@", e.filename?.split("/").pop(), e.lineno, e.colno,
        "\n", (e.error && e.error.stack || "").slice(0, 900));
});
window.addEventListener("unhandledrejection", (e) => {
    console.error("[boot-hook] rejection:", e.reason && (e.reason.message || e.reason),
        "\n", (e.reason && e.reason.stack || "").slice(0, 900));
});
console.info("[ddsc shim] ready:", Object.keys(ddsc).join(","));
