/* Electron main shim.
 *
 * The original PredatorSense main.js hosts an HTTPS+MQTT(aedes) server and a
 * Windows NodeRT backend. The renderer *needs* that broker: its own chunk-local
 * MqttFunctionCall connects to `wss://localhost:<wssport>/mqtt`, asks the
 * "PWARuntime" subject for getAllFuncs, and builds its ddsc object from the
 * reply (that init gates the Angular boot — without it the window is blank).
 *
 * So the shim reproduces the broker 1:1:
 *   https(+TLS self-signed) :15150  /mqtt  → aedes (renderer, wss://)
 *   http(no tls)            :15151  /mqtt  → same aedes (our internal PWARuntime responder)
 * and answers call_PWARuntime {getAllFuncs, ddsc} by dispatching into
 * backend.js (scenario store + psensed socket ops).
 */
const { app, BrowserWindow, ipcMain, protocol, net, Tray, Menu, nativeImage, Notification, screen } = require("electron");
const path = require("path");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const backend = require("./backend");

// pss:// serves app/dist/widgets/main as a web root (their HTTPS server did the
// same) — absolute "/assets/..." paths and module scripts need a real root.
protocol.registerSchemesAsPrivileged([{
    scheme: "pss",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

const APP_ROOT = path.join(__dirname, "app", "dist", "widgets", "main");

function handlePssRequest(request) {
    const u = new URL(request.url);
    let p = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    const file = path.join(APP_ROOT, p);
    if (!file.startsWith(APP_ROOT)) return new Response("", { status: 403 });
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
        p = path.join(p, "index.html");
    const target = path.join(APP_ROOT, p);
    if (!fs.existsSync(target)) return new Response("", { status: 404 });
    return net.fetch("file://" + target);
}

// renderer's browser-path WebSocket validates our self-signed cert itself —
// accept it for this session (offline app, localhost only)
app.commandLine.appendSwitch("ignore-certificate-errors");

const WSS_PORT = 15150;   // renderer-side (matches their preload default)
const WS_PORT = 15151;    // internal loopback for the responder client

let mainWin = null;
let overlayWin = null;
let _updateTrayMenu = null;

const URL_PARAMS = {
    "theme": "dark",
    "wssport": String(WSS_PORT),
    "Planet9": "0",
    "isCNIP": "0",
    "Enable3d": "0",
    "EnableAvatarVideo": "0",
    "EnableAvatarApng": "0",
    "fps": "-1",
    "sku": "uat",          // universe key (dev/uat/prd) — uat is complete in the bundle
    "devTool": process.env.PS_DEVTOOLS ? "1" : "0",
    "showWhenReady": "1"
};

function buildQuery() {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(URL_PARAMS)) if (v !== "") p.set(k, v);
    return p.toString();
}

// --------------------------------------------------------------- agent wedge
// Windows-only Acer agent services (PORTS: the websocket client classes in the
// renderer + handshake/authPacket decoded from chunks). The renderer keeps
// retrying those connections forever — спокойный wedge: real AES-ECB handshake,
// EC-bypass (1007) error replies so features register as unsupported.
// ------------------------------------------------- wsinfo honest data providers
/* Their renderer polls three of the wedged agent services for UI data
 * (packet decode: ledger §13.23): DeviceInfoI3d on port 4449 (System Info /
 * Checkup hardware facts), CareCenter on 4343 (BatteryStatus + Checkup check
 * commands) and QuickAccess on 5141 (kept at the EC bypass). Replies
 * follow their envelope: ResponsePacket(3) echoing the request Session; the
 * Result shapes below mirror their adapter consumers (fu/DeviceInfoI3d and
 * the in-bundle simulator fixtures). Everything else keeps the EC bypass. */
const DEVICE_CMDS = new Set(["SystemInfo", "SMBIOS", "DeviceManager",
    "MotherBoard", "OS", "Storage", "Network"]);
let _sysinfoData = null, _sysinfoDataAt = 0, _sysinfoPending = null;
async function sysinfoData() {
    if (_sysinfoData && Date.now() - _sysinfoDataAt < 30000) return _sysinfoData;
    if (_sysinfoPending) return _sysinfoPending;
    _sysinfoPending = (async () => {
        try {
            _sysinfoData = await backend.dispatch("psense", "sysinfo", []);
            _sysinfoDataAt = Date.now();
        } catch (e) {
            console.error("[agent] sysinfo fetch failed:", e.message);
        } finally {
            _sysinfoPending = null;
        }
        return _sysinfoData;
    })();
    return _sysinfoPending;
}
function deviceResult(cmd, si) {
    switch (cmd) {
        case "SystemInfo": return { CPUName: si.cpu, CPUCores: si.cpu_cores,
            RAMSizeMB: si.ram?.total_mb, RAMType: si.ram?.type };
        case "SMBIOS": return { ProductName: si.product, BaseboardVersion: si.bios_version,
            BIOSVersion: si.bios_version, BIOSVendor: si.bios_vendor,
            BIOSMajorVersion: si.bios_major, BIOSMinorVersion: si.bios_minor };
        case "DeviceManager": return si.devices;
        case "MotherBoard": return { BIOSVersion: si.bios_version, BIOSVendor: si.bios_vendor,
            CHID: si.chid, BIOSMajorVersion: si.bios_major, BIOSMinorVersion: si.bios_minor };
        case "OS": return si.os;
        case "Storage": return si.storage;
        case "Network": return si.network;
    }
    return null;
}
function batteryResult(si) {
    const b = si?.battery ?? {};
    return { ACMode: b.ac_online === true, BatteryPercent: b.capacity ?? 0,
        BatterySaverMode: false, BatteryFlag: 1,
        RemainingSeconds: b.remaining_seconds ?? -1, FullLifeTimeSeconds: -1 };
}

/* CareCenter check commands (ledger §13.23 follow-up; see §13.24): the checkup
 * dialogs complete on an Action:"Notify" whose Data carries
 * {Progress, EstimatedSeconds, HealthStatus} — HealthStatus 0 = OK, 1 =
 * attention, -1 = unknown/unchecked. Their dialog persists the result itself
 * (info KV · setBattery/Storage/RamLastCheckedInfo), we only report honestly. */
const HEALTH_TTL = 10000;
let _healthData = null, _healthAt = 0, _healthPending = null;
async function healthData() {
    if (_healthData && Date.now() - _healthAt < HEALTH_TTL) return _healthData;
    if (_healthPending) return _healthPending;
    _healthPending = (async () => {
        try { _healthData = await backend.dispatch("psense", "health", []); _healthAt = Date.now(); }
        catch (e) { console.error("[agent] health fetch failed:", e.message); }
        finally { _healthPending = null; }
        return _healthData;
    })();
    return _healthPending;
}
/* Notify-completion packet shape consumed by the checkup dialog (CCNotify). */
const checkNotify = (session, cmd, health) => ({
    PacketType: 3, Version: 1, Action: "Notify", Session: session,
    Command: cmd, Data: {
        Progress: 100, EstimatedSeconds: 0, HealthStatus: health,
    },
});
/* Abort-progress: ≤100 with EstimatedSeconds > 0 makes their CancelHandle path
 * close the dialog WITHOUT persisting a check result. */
const checkAbort = (session, cmd) => ({
    PacketType: 3, Version: 1, Action: "Notify", Session: session,
    Command: cmd, Data: { Progress: 95, EstimatedSeconds: 1 },
});
function checkBatteryResult(hres) {
    const b = hres?.battery ?? {};
    return { BatteryHealthStatus: b.battery_health ?? -1,
        BatteryFullRaw: b.battery_full_raw ?? 0,
        BatteryDesignRaw: b.battery_design_raw ?? 0,
        BatteryRatioPct: b.battery_capacity_ratio_pct ?? -1,
        BatteryCycleCount: b.battery_cycle_count ?? 0 };
}

async function startAgentWebservers() {
    let WS;
    try { WS = require("ws"); } catch { return; }
    const crypto = require("crypto");
    const KEYA = Buffer.from("A6052DC8A6E44210", "utf8");
    const KEYB = Buffer.from("AB252AB73BED1CDB", "utf8");
    const aes = (key, data) => {
        const c = crypto.createCipheriv("aes-128-ecb", key, null);
        return Buffer.concat([c.update(Buffer.from(data, "utf8")), c.final()]).toString("base64");
    };
    const SERVICES = {
        4343: "AcerCareCenterFunctionalityTests_HandshakingQuestion",
        5141: "AcerQuickAccessFunctionalityTests_HandshakingQuestion",
        4449: "AcerDeviceInfoFunctionalityTests_HandshakingQuestion",
    };
    const servers = [];
    for (const [port, question] of Object.entries(SERVICES)) {
        try {
            const srv = require("https").createServer({
                key: fs.readFileSync(path.join(__dirname, "tls", "server.key")),
                cert: fs.readFileSync(path.join(__dirname, "tls", "server.crt")),
            });
            const wss = new WS.Server({ server: srv, path: "/" });
            wss.on("connection", (sock) => {
                const pnum = Number(port);
                sock.on("message", (raw) => {
                    void (async () => {
                        let m;
                        try { m = JSON.parse(String(raw)); } catch { return; }
                        const reply = (o) => { try { sock.send(JSON.stringify(o)); } catch { } };
                        if (m.PacketType === 1) {
                            // server authentication packet (their QC/CC/DI protocols)
                            reply({ PacketType: 1, Data: aes(KEYB, question) });
                            return;
                        }
                        if (m.PacketType !== 2) return;
                        const ver = m.Version || 1;
                        const ok = (cmd, result) => reply({
                            PacketType: 3, Version: ver, Session: m.Session,
                            Command: cmd, Action: m.Action || "Get", Result: result,
                        });
                        const fquery = (qdata) => reply({
                            PacketType: 3, Version: ver, Session: m.Session,
                            Command: "FunctionQuery", ServiceVersion: "1.0.0.0",
                            Data: qdata,
                        });
                        if (pnum === 4449) {
                            // their DeviceInfoI3d channel — honest hardware data
                            if (m.Command === "FunctionQuery") return fquery([...DEVICE_CMDS]);
                            const si = await sysinfoData();
                            if (si && DEVICE_CMDS.has(m.Command)) {
                                ok(m.Command, deviceResult(m.Command, si));
                                return;
                            }
                        } else if (pnum === 4343) {
                            // CareCenter — battery status + honest checkups
                            if (m.Command === "FunctionQuery") {
                                return fquery(["BatteryStatus", "CheckBattery",
                                    "CheckMemory", "CheckStorage",
                                    "BatteryHealthy"]);
                            }
                            if (m.Command === "BatteryHealthy") {
                                // charge mode (ls enum): 0=Optimized | 1=Full |
                                // 2=Adaptive-learning — hardware write path is
                                // the misc/id-22 SMM call (ledger §13.25); AI
                                // mode (2) stays unadvertised: the Adaptive
                                // Charging scheduler has no Linux equivalent
                                const act = m.Action || "Get";
                                const fail = () => reply({
                                    // no Action field on error packets — their
                                    // handler routes Action:"Set" into a silent
                                    // auto-Get and never sees PacketType 9
                                    // (§13.24 GOTCHA)
                                    PacketType: 9, ErrorCode: 1004,
                                    Session: m.Session, Version: ver,
                                    Command: "BatteryHealthy", Result: null,
                                });
                                try {
                                    if (act === "Get") {
                                        const r = await backend.dispatch("psense", "battmodeGet", []);
                                        if (r && r.status === 0 && typeof r.value === "number") {
                                            return ok("BatteryHealthy", { Value: r.value });
                                        }
                                    } else if (act === "Set") {
                                        const mode = Number(m.Param1);
                                        if (mode === 0 || mode === 1) {
                                            const r = await backend.dispatch("psense", "battmodeSet", [mode]);
                                            if (r && r.committed) {
                                                // ACK Action:"Set" → their
                                                // ResponsePacketHandler auto-re-GETs
                                                console.log(`[agent] charge mode -> ${mode}` +
                                                    ` (EC read-back ${r.reported ?? "n/a"})`);
                                                reply({ PacketType: 3, Version: ver,
                                                    Session: m.Session,
                                                    Command: "BatteryHealthy", Action: "Set" });
                                                return;
                                            }
                                        }
                                    }
                                } catch (e) {
                                    console.error("[agent] battmode:", e.message);
                                }
                                return fail();
                            }
                            if (m.Action === "Abort" && /^(Check)/.test(m.Command)) {
                                // they cancel a running check: progress ≤100 with
                                // EstimatedSeconds>0 closes the dialog, unpersisted
                                return reply(checkAbort(m.Session, m.Command));
                            }
                            const si = await sysinfoData();
                            if (si && m.Command === "BatteryStatus") {
                                ok("BatteryStatus", batteryResult(si));
                                return;
                            }
                            const health = await healthData();
                            if (health && m.Command === "CheckBattery") {
                                if ((m.Action || "Get") === "Get") {
                                    ok("CheckBattery", checkBatteryResult(health));
                                    return;
                                }
                                // Action:"Set" — instant honest check
                                reply({ PacketType: 3, Version: ver, Session: m.Session,
                                    Command: "CheckBattery", Action: "Set" });
                                return reply(checkNotify(m.Session, "CheckBattery",
                                    health.battery?.battery_health ?? -1));
                            }
                            if (health && m.Command === "CheckMemory") {
                                if ((m.Action || "Get") === "Get") {
                                    // Get shape per the CC-agent embedded
                                    // protocol manual (§13.25); honest filler:
                                    // SMBIOS totals, no runtime diagnostic ran
                                    ok("CheckMemory", {
                                        TotalMemoryMB: si.ram?.total_mb ?? 0,
                                        NumberOfBanks: si.ram?.banks ?? 0,
                                        TestInProgress: false,
                                        HealthStatus: -1,
                                    });
                                    return;
                                }
                                // honest: no Linux runtime memory diagnostic.
                                // NOTE: no Action field — their handler routes
                                // Action:"Set" packets into a silent auto-Get
                                // path and never sees PacketType 9.
                                return reply({ PacketType: 9, ErrorCode: 1004,
                                    Session: m.Session, Version: ver,
                                    Command: "CheckMemory", Result: null });
                            }
                            if (health && m.Command === "CheckStorage") {
                                if ((m.Action || "Get") === "Get") {
                                    ok("CheckStorage", (health.disks ?? []).map((d) => ({
                                        DiskName: d.model, DiskIndex: d.index,
                                        MediaType: d.media, TotalSizeMB: d.total_mb,
                                        Healthy: d.health, DriveLetters: ["/"],
                                    })));
                                    return;
                                }
                                // Action:"Set", Param1 = disk index — instant check
                                const idx = typeof m.Param1 === "number" ? m.Param1
                                    : (typeof m.Param1 === "string" && m.Param1 !== "" &&
                                       !isNaN(Number(m.Param1)) ? Number(m.Param1) : 0);
                                const disk = (health.disks ?? [])[idx] ?? {};
                                reply({ PacketType: 3, Version: ver, Session: m.Session,
                                    Command: "CheckStorage", Action: "Set" });
                                console.log(`[agent] check storage ${disk.dev}: ${disk.smart_status} -> health ${disk.health}`);
                                return reply(checkNotify(m.Session, "CheckStorage",
                                    disk.health ?? -1));
                            }
                        } else if (pnum === 5141) {
                            // QuickAccess (AcerQAAgent.exe; ledger §13.29):
                            // On PHN16-71, APGeAction::GetFunction(0x04) is the
                            // single hardware-backed QuickAccess capability
                            // (Power-off USB Charge switch + battery threshold %);
                            // DustDefender (0x0107), SystemUsageModes (0x07),
                            // SIM (0x1102/0x1202), and Touchpad/KeyboardLock
                            // (0x20001/0x20101) all report unsupported/0 on this
                            // EC, and DisplayModeSwitch/Capability are unused by
                            // the renderer (which uses pssdk GPUModeCap).
                            const failQA = (cmd) => reply({
                                PacketType: 9, ErrorCode: 1004,
                                Session: m.Session, Version: ver,
                                Command: cmd, Result: null,
                            });
                            if (m.Command === "FunctionQuery") {
                                return reply({
                                    PacketType: 3, Version: ver, Session: m.Session,
                                    Command: "FunctionQuery", ServiceVersion: "1.1.13",
                                    Data: ["USBCharge", "USBChargeSwitch", "HighlightFeature"],
                                });
                            }
                            if (m.Command === "HighlightFeature") {
                                return ok("HighlightFeature", {
                                    PurifiedView: true,
                                    PurifiedVoice: true,
                                });
                            }
                            if (m.Command === "USBChargeSwitch") {
                                const act = m.Action || "Get";
                                try {
                                    if (act === "Get") {
                                        const r = await backend.dispatch("psense", "usbchargeGet", []);
                                        if (r && r.status === 0 && typeof r.enabled === "boolean") {
                                            return ok("USBChargeSwitch", { Value: r.enabled });
                                        }
                                    } else if (act === "Set") {
                                        const en = m.Param1 === true || m.Param1 === 1 ||
                                            m.Param1 === "1" || m.Param1 === "true";
                                        const r = await backend.dispatch("psense", "usbchargeSet", [{ enabled: en }]);
                                        if (r && r.committed) {
                                            console.log(`[agent] USBChargeSwitch -> ${en}` +
                                                ` (EC read-back ${JSON.stringify(r.reported)})`);
                                            reply({ PacketType: 3, Version: ver, Session: m.Session,
                                                Command: "USBChargeSwitch", Action: "Set" });
                                            return;
                                        }
                                    }
                                } catch (e) {
                                    console.error("[agent] USBChargeSwitch:", e.message);
                                }
                                return failQA("USBChargeSwitch");
                            }
                            if (m.Command === "USBCharge") {
                                const act = m.Action || "Get";
                                try {
                                    if (act === "Get") {
                                        const r = await backend.dispatch("psense", "usbchargeGet", []);
                                        if (r && r.status === 0 && typeof r.threshold === "number") {
                                            return ok("USBCharge", { Value: r.threshold });
                                        }
                                    } else if (act === "Set") {
                                        const thr = parseInt(String(m.Param1 ?? "").replace("%", ""), 10);
                                        if (thr === 10 || thr === 20 || thr === 30) {
                                            const r = await backend.dispatch("psense", "usbchargeSet",
                                                [{ enabled: true, threshold: thr }]);
                                            if (r && r.committed) {
                                                console.log(`[agent] USBCharge threshold -> ${thr}%` +
                                                    ` (EC read-back ${JSON.stringify(r.reported)})`);
                                                reply({ PacketType: 3, Version: ver, Session: m.Session,
                                                    Command: "USBCharge", Action: "Set" });
                                                return;
                                            }
                                        }
                                    }
                                } catch (e) {
                                    console.error("[agent] USBCharge:", e.message);
                                }
                                return failQA("USBCharge");
                            }
                        }
                        reply({   // everything else: EC bypass (not supported)
                            PacketType: 9, ErrorCode: 1007,
                            Session: m.Session, Version: ver, Command: m.Command,
                            Action: m.Action, Result: null,
                        });
                    })();
                });
                // CareCenter keeps the Checkup battery meter fresh via Notify
                let notifyTimer = null;
                if (pnum === 4343) {
                    notifyTimer = setInterval(() => {
                        try {
                            if (sock.readyState !== 1) return;
                            sysinfoData().then((si) => {
                                if (si) sock.send(JSON.stringify({
                                    PacketType: 3, Version: 1, Action: "Notify",
                                    Command: "BatteryStatus", Result: batteryResult(si),
                                }));
                            }).catch(() => { });
                        } catch { }
                    }, 30000);
                }
                sock.on("close", () => { if (notifyTimer) clearInterval(notifyTimer); });
            });
            srv.listen(Number(port), "localhost");
            servers.push(srv);
            console.log(`[agent] ${port} (${question.match(/Acer(\w+)Functionality/)[1]}) wedge up`);
        } catch (e) {
            console.error(`[agent] ${port} failed:`, e.message);
        }
    }
    return servers;
}

// ------------------------------------------------------------------ broker
function startBroker() {
    const _aedes = require("aedes");
    const Aedes = _aedes.Aedes ?? _aedes.default ?? _aedes;
    const aedes = new Aedes();
    const websocketStream = require("websocket-stream");
    const tlsOpts = {
        key: fs.readFileSync(path.join(__dirname, "tls", "server.key")),
        cert: fs.readFileSync(path.join(__dirname, "tls", "server.crt"))
    };

    const httpsSrv = require("https").createServer(tlsOpts);
    websocketStream.createServer({ server: httpsSrv, path: "/mqtt" }, aedes.handle);
    httpsSrv.listen(WSS_PORT, "localhost");

    const httpSrv = http.createServer();
    websocketStream.createServer({ server: httpSrv, path: "/mqtt" }, aedes.handle);
    httpSrv.listen(WS_PORT, "localhost");

    [httpsSrv, httpSrv].forEach((s) => s.on("error", (e) =>
        console.error("[broker] server error", e.message)));

    return { aedes, httpsSrv, httpSrv };
}

// internal client answering renderer ddsc calls (their PWARuntime role)
function startResponder(broker) {
    const mqtt = require("mqtt");
    const table = require("./ddsc-table.json");
    const callTable = [];
    for (const [mod, fns] of Object.entries(table))
        for (const fn of fns) callTable.push({ moduleName: mod, func: fn });

    const client = mqtt.connect(`ws://localhost:${WS_PORT}/mqtt`, {
        clientId: "PWARuntime_shim",
        keepalive: 60,
        reconnectPeriod: 1000
    });
    client.on("connect", () => {
        console.log("[broker] responder ready — renderer may connect");
        client.subscribe("call_PWARuntime");
    });
    client.on("message", (topic, payloadBuf) => {
        try {
            const payload = JSON.parse(payloadBuf.toString());
            if (topic !== "call_PWARuntime") return;
            const reply = async () => {
                const { callId, fnName, param = [] } = payload;
                let result;
                if (fnName === "getAllFuncs") {
                    result = callTable;
                } else if (fnName === "ddsc") {
                    const [mod, fn, args = []] = param;
                    result = await backend.dispatch(String(mod), String(fn), args);
                } else {
                    result = null;
                }
                client.publish("reply_PWARuntime",
                    JSON.stringify({ callId, reason: "fromFunction", result }));
            };
            void reply();
        } catch (e) {
            console.error("[broker] responder message error", e.message);
        }
    });
    return client;
}

// main-process → renderer live events (ScenarioChanged etc.) land here
function broadcastEvent(eventType, ...params) {
    const broker = startBroker._instance;
    if (!broker) return;
    const payload = { eventType, param: params, sourceClientId: "PWARuntime_shim" };
    broker.aedes.publish({
        topic: "broadcast_XSenseApp",
        payload: Buffer.from(JSON.stringify(payload)),
        qos: 0, retain: false
    }, () => { });
    // mirror for window.ddsc.on consumers (preload shim layer)
    try {
        const w = mainWin && !mainWin.isDestroyed() ? mainWin : null;
        w?.webContents.send("ddsc-broadcast", eventType, ...params);
    } catch { }
    try {
        if (overlayWin && !overlayWin.isDestroyed()) {
            overlayWin.webContents.send("ddsc-broadcast", eventType, ...params);
            if (eventType === "UPDATE_MONITOR_DATA" && params[0]) {
                const opMode = backend.pssdkStore?.get("OPERATING_MODE") ?? 1;
                overlayWin.webContents.send("overlay-metrics", { ...params[0], OPERATING_MODE: opMode });
            }
        }
    } catch { }
}

const OVERLAY_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  body {
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #e0f7fa;
    overflow: hidden;
    height: 160px;
    width: 280px;
    padding: 5px;
  }
  .hud-card {
    background: linear-gradient(135deg, rgba(8, 20, 32, 0.95), rgba(4, 10, 18, 0.97));
    border: 1px solid rgba(0, 210, 255, 0.45);
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.75), 0 0 10px rgba(0, 210, 255, 0.18);
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .hud-header {
    -webkit-app-region: drag;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    background: rgba(0, 46, 64, 0.75);
    border-bottom: 1px solid rgba(0, 210, 255, 0.25);
    cursor: move;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .logo-text {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 1px;
    color: #00d2ff;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .logo-icon {
    width: 13px;
    height: 13px;
    fill: #00d2ff;
  }
  .mode-badge {
    font-size: 8.5px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: rgba(0, 210, 255, 0.2);
    color: #00d2ff;
    border: 1px solid rgba(0, 210, 255, 0.4);
  }
  .close-btn {
    -webkit-app-region: no-drag;
    background: transparent;
    border: none;
    color: #88a0b0;
    font-size: 13px;
    font-weight: bold;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    transition: color 0.15s;
  }
  .close-btn:hover {
    color: #ff3366;
  }
  .hud-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 5px;
    padding: 5px 7px;
    flex: 1;
  }
  .section {
    background: rgba(0, 24, 38, 0.5);
    border: 1px solid rgba(0, 210, 255, 0.14);
    border-radius: 5px;
    padding: 4px 6px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .sec-title {
    font-size: 10px;
    font-weight: 800;
    color: #00d2ff;
    letter-spacing: 0.5px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid rgba(0, 210, 255, 0.12);
    padding-bottom: 2px;
    margin-bottom: 2px;
  }
  .metric-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 9.5px;
    line-height: 1.35;
  }
  .metric-label {
    color: #78909c;
    font-size: 9px;
  }
  .metric-val {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .gpu-note {
    font-size: 8px;
    color: #546e7a;
    text-align: right;
    font-style: italic;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
  }
</style>
</head>
<body>
<div class="hud-card">
  <div class="hud-header">
    <div class="header-left">
      <div class="logo-text">
        <svg class="logo-icon" viewBox="0 0 24 24"><path d="M12 2L4 9v6l8 7 8-7V9l-8-7zm0 3.5l5 4.3v4.4L12 18.5l-5-4.3V9.8l5-4.3z"/></svg>
        PREDATOR
      </div>
      <span class="mode-badge" id="mode-badge">BALANCED</span>
    </div>
    <button class="close-btn" id="close-btn" title="Close">x</button>
  </div>
  <div class="hud-body">
    <div class="section">
      <div class="sec-title">
        <span>CPU</span>
        <span id="cpu-fan" style="color: #80deea; font-size: 8.5px; font-weight: normal;">0 RPM</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Temp</span>
        <span class="metric-val" id="cpu-temp" style="color: #80deea;">--°C</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Usage</span>
        <span class="metric-val" id="cpu-usage" style="color: #80d8ff;">--%</span>
      </div>
    </div>
    <div class="section">
      <div class="sec-title">
        <span>GPU</span>
        <span id="gpu-fan" style="color: #80deea; font-size: 8.5px; font-weight: normal;">0 RPM</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Temp</span>
        <span class="metric-val" id="gpu-temp" style="color: #80deea;">--°C</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Usage</span>
        <span class="metric-val" id="gpu-usage" style="color: #80d8ff;">--%</span>
      </div>
      <div class="gpu-note" id="gpu-note">210MHz (Dormant)</div>
    </div>
  </div>
</div>
<script>
  const { ipcRenderer } = require("electron");
  document.getElementById("close-btn").addEventListener("click", () => {
    ipcRenderer.send("overlay-close");
  });

  const MODES = {
    0: { name: "Quiet", color: "#00b0ff", bg: "rgba(0, 176, 255, 0.2)", border: "rgba(0, 176, 255, 0.4)" },
    1: { name: "Balanced", color: "#00e5ff", bg: "rgba(0, 229, 255, 0.2)", border: "rgba(0, 229, 255, 0.4)" },
    2: { name: "Eco", color: "#00e676", bg: "rgba(0, 230, 118, 0.2)", border: "rgba(0, 230, 118, 0.4)" },
    4: { name: "Performance", color: "#ff9100", bg: "rgba(255, 145, 0, 0.2)", border: "rgba(255, 145, 0, 0.4)" },
    5: { name: "Turbo", color: "#ff1744", bg: "rgba(255, 23, 68, 0.2)", border: "rgba(255, 23, 68, 0.4)" },
    6: { name: "Eco", color: "#00e676", bg: "rgba(0, 230, 118, 0.2)", border: "rgba(0, 230, 118, 0.4)" },
  };

  function tempColor(t) {
    if (t >= 80) return "#ff5252";
    if (t >= 65) return "#ffb74d";
    return "#80deea";
  }

  function updateMetrics(d) {
    if (!d) return;
    if (d.CPU_TEMPERATURE != null) {
      const el = document.getElementById("cpu-temp");
      el.textContent = d.CPU_TEMPERATURE + "°C";
      el.style.color = tempColor(d.CPU_TEMPERATURE);
    }
    if (d.CPU_USAGE != null) {
      document.getElementById("cpu-usage").textContent = Math.round(d.CPU_USAGE) + "%";
    }
    if (d.CPU_FANSPEED != null) {
      document.getElementById("cpu-fan").textContent = d.CPU_FANSPEED + " RPM";
    }
    if (d.GPU1_TEMPERATURE != null) {
      const el = document.getElementById("gpu-temp");
      el.textContent = d.GPU1_TEMPERATURE + "°C";
      el.style.color = tempColor(d.GPU1_TEMPERATURE);
    }
    if (d.GPU1_USAGE != null) {
      document.getElementById("gpu-usage").textContent = Math.round(d.GPU1_USAGE) + "%";
    }
    if (d.GPU1_FANSPEED != null) {
      document.getElementById("gpu-fan").textContent = d.GPU1_FANSPEED + " RPM";
    }

    const noteEl = document.getElementById("gpu-note");
    const isIdle = d.GPU1_IDLE_STATUS === 1 || (d.GPU1_USAGE != null && d.GPU1_USAGE <= 2 && (!d.GPU1_FREQUENCY || d.GPU1_FREQUENCY <= 300));
    if (isIdle) {
      const f = d.GPU1_FREQUENCY ? d.GPU1_FREQUENCY + "MHz" : "210MHz";
      noteEl.textContent = f + " (Dormant)";
      noteEl.style.color = "#546e7a";
    } else {
      const f = d.GPU1_FREQUENCY ? d.GPU1_FREQUENCY + "MHz" : "Active";
      noteEl.textContent = f;
      noteEl.style.color = "#00e5ff";
    }

    if (d.OPERATING_MODE != null) {
      const m = MODES[d.OPERATING_MODE] || { name: "Mode " + d.OPERATING_MODE, color: "#00e5ff", bg: "rgba(0, 229, 255, 0.2)", border: "rgba(0, 229, 255, 0.4)" };
      const badge = document.getElementById("mode-badge");
      badge.textContent = m.name;
      badge.style.color = m.color;
      badge.style.background = m.bg;
      badge.style.borderColor = m.border;
    }
  }

  ipcRenderer.invoke("get-overlay-init-data").then(updateMetrics).catch(() => {});
  setInterval(() => {
    ipcRenderer.invoke("get-overlay-init-data").then(updateMetrics).catch(() => {});
  }, 1000);

  ipcRenderer.on("overlay-metrics", (ev, data) => updateMetrics(data));
  ipcRenderer.on("ddsc-broadcast", (ev, type, ...params) => {
    if (type === "UPDATE_MONITOR_DATA" && params[0]) {
      updateMetrics(params[0]);
    } else if (type === "OPERATING_MODE" && params[0] != null) {
      updateMetrics({ OPERATING_MODE: params[0] });
    }
  });
</script>
</body>
</html>`;

function createOverlayWindow() {
    if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
    overlayWin = new BrowserWindow({
        width: 280,
        height: 160,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    try {
        const display = screen.getPrimaryDisplay();
        const { width } = display.workAreaSize;
        overlayWin.setPosition(Math.max(20, width - 300), 60);
    } catch {}

    overlayWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(OVERLAY_HTML));

    overlayWin.on("close", (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            overlayWin.hide();
            _updateTrayMenu?.();
            return false;
        }
    });

    overlayWin.on("closed", () => {
        overlayWin = null;
        _updateTrayMenu?.();
    });

    return overlayWin;
}

function toggleOverlay(show) {
    if (!overlayWin || overlayWin.isDestroyed()) {
        createOverlayWindow();
    }
    const targetState = show !== undefined ? Boolean(show) : !overlayWin.isVisible();
    if (targetState) {
        overlayWin.show();
        try {
            const opMode = backend.pssdkStore?.get("OPERATING_MODE") ?? 1;
            const lastData = backend.getLastMonitorData ? backend.getLastMonitorData() : null;
            overlayWin.webContents.send("overlay-metrics", { ...(lastData || {}), OPERATING_MODE: opMode });
        } catch {}
    } else {
        overlayWin.hide();
    }
    _updateTrayMenu?.();
}

function createWindow() {
    mainWin = new BrowserWindow({
        width: 1168,
        minWidth: 500,
        height: 780,
        minHeight: 780,
        frame: false,
        show: false,
        resizable: true,
        center: true,
        fullscreenable: true,
        backgroundColor: "#002E40",
        webPreferences: {
            nodeIntegration: true,
            webviewTag: true,
            webSecurity: false,
            contextIsolation: false,
            sandbox: false,
            preload: path.join(__dirname, "preload.js")
        }
    });
    backend.setWindow(mainWin);

    try { require("@electron/remote/main").enable(mainWin.webContents); }
    catch (e) { console.error("[remote] enable failed", e.message); }

    mainWin.webContents.session.setCertificateVerifyProc((_req, cb) => cb(0));

    const query = buildQuery();
    const url = `pss://main/?${query}`;
    mainWin.loadURL(url).catch((e) => console.error("[load] failed:", e.message));
    // their main sends INITIAL_LIGHTING on every boot after CheckPresetKeyboardLighting
    setTimeout(() => {
        const w = mainWin && !mainWin.isDestroyed() ? mainWin : null;
        w?.webContents.send("DESKTOP_MSG", "INITIAL_LIGHTING");
    }, 5000);
    if (URL_PARAMS.devTool === "1") {
        mainWin.webContents.openDevTools({ mode: "detach" });
    }
    const wc = mainWin.webContents;
    wc.on("console-message", (ev, level, msg, line, srcId) => {
        const tag = ["", "info", "warn", "error"][level] || "?";
        console.log(`[renderer.${tag}] ${(srcId.split("/").pop() || "")}:${line || ""} ${msg}`);
    });
    wc.on("did-fail-load", (_e, code, desc, url) =>
        console.error(`[load-failed] ${code} ${desc} ${url}`));
    wc.on("render-process-gone", (_e, det) =>
        console.error("[renderer-gone]", JSON.stringify(det)));
    wc.on("did-finish-load", () => {
        console.log("[load] finished:", wc.getURL().slice(0, 120));
        // The renderer only builds its global LightingMap after this signal.
        // A persisted scenario does not emit INITIAL_LIGHTING during backend
        // startup, so send it once after Angular has installed its listener.
        setTimeout(() => {
            if (!wc.isDestroyed()) wc.send("DESKTOP_MSG", "INITIAL_LIGHTING");
        }, 1000);
    });
    // PS_SHOT=<secs> → save a screenshot to debug/firstframe.png (headless debugging)
    if (process.env.PS_SHOT) {
        const secs = Number(process.env.PS_SHOT) || 20;
        setTimeout(() => {
            wc.capturePage?.().then((img) => {
                const out = path.join(__dirname, "debug");
                fs.mkdirSync(out, { recursive: true });
                fs.writeFileSync(path.join(out, "firstframe.png"), img.toPNG());
                console.log("[shot] saved", path.join(out, "firstframe.png"));
            }).catch((e) => console.error("[shot] failed", e.message));
        }, secs * 1000);
    }
    // PS_DEBUGGER=1 → DevTools protocol console capture with stacks
    if (process.env.PS_DEBUGGER) {
        const dbg = wc.debugger;
        dbg.attach("1.3");
        dbg.on("message", (_ev, method, params) => {
            if (method === "Runtime.consoleAPICalled") {
                const { type, args, stackTrace } = params;
                if (type === "error" || type === "warning") {
                    const text = args.map((a) => {
                        if (a.type === "string") return a.value;
                        if (a.description) return a.description;
                        if (a.preview) return a.preview.properties.map((p) => `${p.name}=${p.value}`).join(" ");
                        return a.type;
                    }).join(" ");
                    console.log(`[dbg.${type}] ${text.slice(0, 300)}`);
                    (stackTrace ?? []).slice(0, 12).forEach((fr) =>
                        console.log(`    at ${fr.functionName || "??"} ${String(fr.url).split("/").pop()}:${fr.lineNumber}:${fr.columnNumber}`));
                }
            }
        });
        dbg.sendCommand("Runtime.enable").catch(() => { });
    }
    // PS_TOURS=1 → walk the tabs via their DESKTOP_MSG handlers, capture each
    if (process.env.PS_TOURS) {
        const out = path.join(__dirname, "debug");
        fs.mkdirSync(out, { recursive: true });
        const tabs = [
            ["PersonalSettings", "TO_Personal_Setting_PAGE"],
            ["Lighting", "TO_Lighting_Setting_PAGE"],
            ["LiveUpdate", "TO_LiveUpdate_PAGE"],
            ["MainPage", "TO_Main_PAGE"],
        ];
        const stop = process.env.TOUR_STOP;
        const seq = stop ? tabs.slice(0, tabs.findIndex((t) => t[0] === stop) + 1) : tabs;
        (async () => {
            for (const [name, msg] of seq) {
                try {
                    wc.send("DESKTOP_MSG", msg);
                    await new Promise(r => setTimeout(r, 4500));
                    const img = await wc.capturePage();
                    fs.writeFileSync(path.join(out, `tab_${name}.png`), img.toPNG());
                    console.log("[tour] saved", name);
                } catch (e) { console.error("[tour]", name, e.message); }
            }
        })();
    }
     // PS_CLICKS="x,y,dwellms;..." → synthetic mouse clicks after the tour.
    // Coordinates are full-window CSS px (same space as PS_SHOT captures).
    // Each click captures a second-level sequence (SEQ_<i>_*.png) to reveal
    // post-click UI changes (e.g., lighting selection reverts).
    //
    // The vendor shell hosts every page as a <webview> guest; sendInputEvent
    // into the host webContents does NOT cross the webview boundary (only
    // tab-bar clicks ever landed). Each click is therefore resolved into the
    // webview whose bounding rect contains the point and dispatched there
    // with coordinates translated to that guest's viewport; points outside
    // every webview rect fall back to the host (tab bar / outer chrome).
    if (process.env.PS_CLICKS) {
        const clicks = process.env.PS_CLICKS.split(";").map((s) => {
            const [x, y, dwell] = s.split(",").map(Number);
            return [x, y, dwell || 900];
        });
        const seqCap = async (idx, label) => {
            try {
                const img = await wc.capturePage();
                fs.writeFileSync(path.join(__dirname, "debug", `seq_${idx}_${label}.png`), img.toPNG());
                console.log(`[seq] seq_${idx}_${label}`);
            } catch (e) { console.error("[seq]", e.message); }
        };
        (async () => {
            await new Promise((r) => setTimeout(r, (Number(process.env.PS_SHOT) || 18) * 1000 + 2500));
            if (process.env.PS_TRACE) try {
                const dom = await wc.executeJavaScript(`JSON.stringify({
                    t: document.title, url: location.href.slice(0, 90),
                    wv: document.querySelectorAll('webview').length,
                    ifr: document.querySelectorAll('iframe').length,
                    body: [...document.body.children].map(e => e.tagName + '.' + String(e.className).slice(0, 24))
                })`, true);
                console.log("[click] dom census:", dom);
            } catch (e) { console.log("[click] census failed:", e.message); }
            for (const [x, y, dwell] of clicks) {
                // resolve the point into a webview guest (see block comment)
                let target = wc, cx = x, cy = y;
                try {
                    const info = await wc.executeJavaScript(`(function(){
                        const out = [];
                        for (const v of document.querySelectorAll('webview,iframe')) {
                            const r = v.getBoundingClientRect();
                            const id = (typeof v.getWebContentsId === "function") ? v.getWebContentsId()
                                : (typeof v.remote !== "undefined" ? -2 : null);
                            out.push({ tag: v.tagName, x: r.x, y: r.y, w: r.width, h: r.height, id });
                        }
                        return JSON.stringify(out); })()`, true);
                    const list = JSON.parse(info || "[]");
                    const hit = list.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
                    if (process.env.PS_TRACE) console.log("[click] embed rects:", info);
                    if (hit && hit.id) {
                        const guest = require("electron").webContents.fromId(hit.id);
                        if (guest) { target = guest; cx = x - hit.x; cy = y - hit.y; }
                    }
                } catch { /* host fallback */ }
                if (process.env.PS_TRACE) try {
                    const chain = await wc.executeJavaScript(`(function(){
                        let e = document.elementFromPoint(${target === wc ? x : cx}, ${target === wc ? y : cy}), out = [];
                        while (e && e !== document.body && out.length < 14) {
                            out.push(e.tagName + '.' + String(e.getAttribute('class') || '').slice(0, 40));
                            e = e.parentElement;
                        }
                        return out.join(' < '); })()`, true);
                    console.log(`[click] element chain at ${cx},${cy}:`, chain);
                } catch (e) { console.log("[click] chain failed:", e.message); }
                target.sendInputEvent({ type: "mouseMove", x: cx, y: cy });
                await new Promise((r) => setTimeout(r, 120));
                target.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount: 1 });
                target.sendInputEvent({ type: "mouseUp", x: cx, y: cy, button: "left", clickCount: 1 });
                console.log(`[click] ${x},${y}${target === wc ? " (host)" : ` (webview ${hit.id}, local ${cx},${cy})`}`);
                if (process.env.PS_CLICK_SYNTH) try {
                    const r = await wc.executeJavaScript(`(function(){
                        const e = document.elementFromPoint(${cx}, ${cy});
                        if (!e) return "no element";
                        const b = (e.closest && e.closest('button')) || e;
                        b.click();
                        return "clicked " + b.tagName + "." + String(b.getAttribute('class') || '').slice(0, 40); })()`, true);
                    console.log("[click-synth]", r);
                } catch (e) { console.log("[click-synth] failed:", e.message); }
                await seqCap("0", "400ms");
                await new Promise((r) => setTimeout(r, 400));
                await seqCap("1", "1s");
                await new Promise((r) => setTimeout(r, 1000));
                await seqCap("2", "2s");
                await new Promise((r) => setTimeout(r, 2000));
                await seqCap("3", "4s");
                const rest = Math.max(0, dwell - 400 - 1000 - 2000);
                await new Promise((r) => setTimeout(r, rest));
                await seqCap("4", "final");
            }
            try {
                const img = await wc.capturePage();
                fs.writeFileSync(path.join(__dirname, "debug", "click_test.png"), img.toPNG());
                console.log("[click] captured click_test.png");
            } catch (e) { console.error("[click] capture failed", e.message); }
        })();
    }
    mainWin.on("close", (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWin.hide();
            return false;
        }
    });
    mainWin.once("ready-to-show", () => mainWin.show());
    mainWin.on("closed", () => { mainWin = null; });
}

let tray = null;

function createTray() {
    if (tray) return;
    try {
        const iconPath = path.join(__dirname, "app", "dist", "widgets", "main", "icon_targetsize_16.aaef4649718cb834.png");
        const icon = nativeImage.createFromPath(iconPath);
        tray = new Tray(icon);
        tray.setToolTip("Predator Sense");

        const updateTrayMenu = async () => {
            let currentProfile = "balanced";
            try {
                const r = await backend.daemonCall("profile.get", {});
                if (r?.profile) currentProfile = r.profile;
            } catch {}

            const contextMenu = Menu.buildFromTemplate([
                { label: "Predator Sense", enabled: false },
                { type: "separator" },
                {
                    label: "Mode: Eco (Low Power)",
                    type: "radio",
                    checked: currentProfile === "low-power",
                    click: async () => {
                        await backend.daemonCall("profile.set", { name: "low-power" });
                        updateTrayMenu();
                    }
                },
                {
                    label: "Mode: Quiet",
                    type: "radio",
                    checked: currentProfile === "quiet",
                    click: async () => {
                        await backend.daemonCall("profile.set", { name: "quiet" });
                        updateTrayMenu();
                    }
                },
                {
                    label: "Mode: Balanced",
                    type: "radio",
                    checked: currentProfile === "balanced",
                    click: async () => {
                        await backend.daemonCall("profile.set", { name: "balanced" });
                        updateTrayMenu();
                    }
                },
                {
                    label: "Mode: Performance",
                    type: "radio",
                    checked: currentProfile === "performance",
                    click: async () => {
                        await backend.daemonCall("profile.set", { name: "performance" });
                        updateTrayMenu();
                    }
                },
                {
                    label: "Mode: Turbo",
                    type: "radio",
                    checked: currentProfile === "turbo",
                    click: async () => {
                        await backend.daemonCall("profile.set", { name: "turbo" });
                        updateTrayMenu();
                    }
                },
                { type: "separator" },
                {
                    label: "Fan: Auto",
                    click: async () => {
                        await backend.daemonCall("fan.reset", {});
                    }
                },
                {
                    label: "Fan: Max (100%)",
                    click: async () => {
                        await backend.daemonCall("fan.speed", { pct: 100 });
                    }
                },
                { type: "separator" },
                {
                    label: "Restore Keyboard Lighting",
                    click: async () => {
                        await backend.daemonCall("kb.restore", {});
                    }
                },
                { type: "separator" },
                {
                    label: "Toggle Desktop Mini Widget",
                    type: "checkbox",
                    checked: Boolean(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()),
                    click: () => {
                        toggleOverlay();
                        updateTrayMenu();
                    }
                },
                { type: "separator" },
                {
                    label: "Show PredatorSense",
                    click: () => {
                        if (mainWin && !mainWin.isDestroyed()) {
                            mainWin.show();
                            mainWin.focus();
                        } else {
                            createWindow();
                        }
                    }
                },
                {
                    label: "Quit",
                    click: () => {
                        app.isQuitting = true;
                        app.quit();
                    }
                }
            ]);
            tray.setContextMenu(contextMenu);
        };

        tray.on("click", () => {
            if (!mainWin || mainWin.isDestroyed()) createWindow();
            else if (mainWin.isVisible()) mainWin.hide();
            else {
                mainWin.show();
                mainWin.focus();
            }
        });

        _updateTrayMenu = updateTrayMenu;
        updateTrayMenu();
    } catch (e) {
        console.error("[tray] creation error:", e.message);
    }
}

app.whenReady().then(() => {
    app.commandLine.appendSwitch("ignore-certificate-errors");
    // their renderer does require('@electron/remote') (window maximize service)
    try {
        require("@electron/remote/main").initialize();
    } catch (e) { console.error("[remote] init failed", e.message); }
    ipcMain.handle("ddsc-dispatch", (ev, module, fn, args) =>
        backend.dispatch(module, fn, args || []));

    const broker = startBroker();
    startBroker._instance = broker;
    backend.setBroadcaster((eventType, ...param) =>
        broadcastEvent(eventType, ...param));
    backend.startPump();
    const responder = startResponder(broker);
    const agents = startAgentWebservers();
    app.on("quit", () => {
        try {
            backend.shutdown?.();
            responder.end(true);
            broker.httpSrv.close();
            broker.httpsSrv.close();
            agents?.forEach(s => s.close());
        } catch { }
    });

    try {
        protocol.handle("pss", handlePssRequest);
    } catch (e) { console.error("[pss] handler failed", e.message); }
    ipcMain.on("overlay-close", () => toggleOverlay(false));
    ipcMain.on("toggle-overlay", (ev, val) => toggleOverlay(val));
    ipcMain.handle("get-overlay-init-data", () => {
        const opMode = backend.pssdkStore?.get("OPERATING_MODE") ?? 1;
        const last = backend.getLastMonitorData ? backend.getLastMonitorData() : null;
        return { ...(last || {}), OPERATING_MODE: opMode };
    });
    backend.setOverlayToggler(toggleOverlay);
    createOverlayWindow();
    createTray();
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (app.isQuitting || !tray) {
        app.quit();
    }
});
