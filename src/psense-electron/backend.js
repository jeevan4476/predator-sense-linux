/* ddsc dispatch → psensed (or local stubs).
 *
 * Response-convention notes from the decode:
 *  - scenario.* carries the whole app data model (profiles[], active,
 *    lighting...); ours persists to ~/.config/predator-sense-linux-scenario.json
 *  - pssdk.setDeviceData(funcName,data)/getUpdatedData(funcName) is a keyed
 *    data cache; main.js pumps live values and broadcasts funcName on change.
 *  - info.* get/set pairs are a plain persisted KV store (their Info.ts used a
 *    persistent store keyed by the getter name, e.g. "IsAgreePrivacyPolicy").
 *  - getOEMSettings: object literal copied verbatim from their main.js
 *    (Features, Planet9_Url, avatar flags, Lighting) with Linux-appropriate flags.
 *  - every unknown function returns null (logged) — pages degrade gracefully
 *    and we map them one by one from the chunk code.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const nnode = require("net");
const { app, screen, Notification } = require("electron");
const { lightingEngine } = require("./lighting-engine");

// ------------------------------------------------------------------ state
let mainWin = null;
let broadcast = null;           // set by main.js once the broker is up
const SCENARIO_FILE = path.join(os.homedir(), ".config",
    "predator-sense-linux-scenario.json");
const INFO_FILE = path.join(os.homedir(), ".config",
    "predator-sense-linux-info.json");
let scenario = null;
let infoKV = null;
const pssdkStore = new Map();       // funcName -> data
let pumpTimer = null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), "[backend]", ...a);

/* pssdk store keys = the fn.* enum from their chunks. Seed sane defaults so
 * the zTe data-model refresh() lands on real values instead of null. */
seedStore();
function seedStore() {
    const seeds = {
        OPERATING_MODE: 1,                       // Ye.DEFAULT
        OVERCLOCKING_MODE: 0,
        FAN_CONTROL: {
            mode: 0,
            custom_fan_data: [
                { fan_custom_auto: 1, fan_custom_speed: 30, fan_index: 0, fan_name: "CPU" },
                { fan_custom_auto: 1, fan_custom_speed: 30, fan_index: 0, fan_name: "GPU" },
            ],               // their DEFAULT_SCENARIO fanControl shape (2-fan PHN16-71)
        },
        SOUND_MODE: 10,                          // d0.AUTOMATIC
        BACKLIGHT_30S: 0,
        BOOT_SOUND: 0,
        STICKY_KEY: 0,
        WIN_KEY: 0,
        LCD_OVERDRIVE: 0,
        GPU_MODE: 0,
        CUSTOM_BOOT_LOGO: {},
        ADAPTOR_STATUS: 1,
        BATTERY_BOOST: 0,      // pump refreshes with the honest value within 1 s
        LIGHTING: null,        // seeded from the active profile's lighting on pump
    };
    for (const [k, v] of Object.entries(seeds)) pssdkStore.set(k, v);
}

/* Ye enum: QUIET=0 DEFAULT=1 EXTREME=4 TURBO=5 ECO=6 (or 2) → platform_profile */
const MODE_TO_PROFILE = {
    0: "quiet", 1: "balanced", 2: "low-power", 4: "balanced-performance",
    5: "performance", 6: "low-power",
};
const PROFILE_TO_MODE = {
    quiet: 0, balanced: 1, "balanced-performance": 4,
    performance: 5, "low-power": 6,
};

function setWindow(w) { mainWin = w; }
function setBroadcaster(f) { broadcast = f; }
function emit(funcName, ...param) {
    try { broadcast && broadcast(funcName, ...param); } catch { }
}
function getWin() { return mainWin && !mainWin.isDestroyed() ? mainWin : null; }

// ------------------------------------------------------------------ psensed
function daemonCallOnce(op, args, timeout = 6000) {
    return new Promise((resolve) => {
        const s = nnode.createConnection("/run/psense.sock");
        let buf = "";
        s.setEncoding("utf8");
        s.setTimeout(timeout);
        s.on("connect", () => s.write(JSON.stringify({ op, ...args }) + "\n"));
        s.on("data", (d) => {
            buf += d;
            if (buf.endsWith("\n")) { s.end(); try { resolve(JSON.parse(buf)); } catch { resolve(null); } }
        });
        s.on("timeout", () => { s.destroy(); resolve(null); });
        s.on("error", () => resolve(null));
    });
}
async function daemonCall(op, args, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (true) {
        const rem = Math.max(1000, deadline - Date.now());
        const r = await daemonCallOnce(op, args, rem);
        if (r && typeof r.error === "string" && /^wmi busy:/i.test(r.error) && Date.now() + 250 < deadline) {
            await new Promise((res) => setTimeout(res, 250));
            continue;
        }
        return r;
    }
}

// ------------------------------------------------------------- info KV store
function loadKV() {
    if (infoKV) return infoKV;
    try { infoKV = JSON.parse(fs.readFileSync(INFO_FILE, "utf8")); }
    catch { infoKV = {}; }
    return infoKV;
}
function kvSet(k, v) {
    const kv = loadKV();
    if (JSON.stringify(kv[k]) === JSON.stringify(v)) return;
    kv[k] = v;
    try {
        fs.mkdirSync(path.dirname(INFO_FILE), { recursive: true });
        fs.writeFileSync(INFO_FILE, JSON.stringify(kv, null, 1));
    } catch (e) { log("info store save failed:", e.message); }
}
function machineId() {
    try { return fs.readFileSync("/etc/machine-id", "utf8").trim(); } catch { return "000"; }
}

// get/set pairs are generated: getter-default comes from GET_DEFAULTS[kvKey]
const KV_PAIRS = [
    // [kvKey, setFn, getFn, defaultGetterOrValue]
    ["IsAgreePrivacyPolicy", "setIsAgreePrivacyPolicy", "getIsAgreePrivacyPolicy", () => true],
    ["IsResumed", "setIsResumed", "getIsResumed", false],
    ["TemperatureUnit", "setTemperatureUnit", "getTemperatureUnit", "C"],
    ["AutoCheckUpdate", "setAutoCheckUpdate", "getAutoCheckUpdate", false],
    ["LastCheckUpdate", "setLastCheckUpdate", "getLastCheckUpdate", 0],
    ["LastCheckWinStoreUpdateTime", "setLastCheckWinStoreUpdateTime", "getLastCheckWinStoreUpdateTime", 0],
    ["LastRunTime", "setLastRunTime", "getLastRunTime", 0],
    ["FirstLaunchTime", "setFirstLaunchTime", "getFirstLaunchTime", () => Date.now()],
    ["UpdateList", "setUpdateList", "getUpdateList", []],
    ["FeatureGuideList", "setFeatureGuideList", "getFeatureGuideList", []],
    ["BiosUpdateResult", "setBiosUpdateResult", "getBiosUpdateResult", null],
    ["BACIGotIt", "setBACIGotIt", "getBACIGotIt", false],
    ["PressIGotItTime", "setPressIGotItTime", "getPressIGotItTime", 0],
    ["BACNotifyLastPushTime", "setBACNotifyLastPushTime", "getBACNotifyLastPushTime", 0],
    ["BACTimeZone", "setBACTimeZone", "getBACTimeZone", ""],
    ["BatteryCalibrationLastCheckTime", "setBatteryCalibrationLastCheckTime", "getBatteryCalibrationLastCheckTime", 0],
    ["BatteryLastCheckedInfo", "setBatteryLastCheckedInfo", "getBatteryLastCheckedInfo", null],
    ["StorageLastCheckedInfo", "setStorageLastCheckedInfo", "getStorageLastCheckedInfo", null],
    ["RamLastCheckedInfo", "setRamLastCheckedInfo", "getRamLastCheckedInfo", null],
    ["DiskCleanSetting", "setDiskCleanSetting", "getDiskCleanSetting",
        () => ({ FileSizeMB: "100", LastAccessedDay: "30", ForceDelete: false })],
    ["QuickClean", "setQuickClean", "getQuickClean", null],
    ["tempBlueLight", "settempBlueLight", "gettempBlueLight", false],
    ["SwitchKey", "setSwitchKey", "getSwitchKey", 0],
    ["FanDialInfo", "setFanDialInfo", "getFanDialInfo", null],
    ["GamebarWidgetSetting", "setGamebarWidgetSetting", "getGamebarWidgetSetting", null],
    ["wOverlayFirstLaunchTm", "setwOverlayFirstLaunchTm", "getwOverlayFirstLaunchTm", 0],
    ["RegistrationDate", "setRegistrationDate", "getRegistrationDate", 0],
    ["ProductRegistrationDone", "setProductRegistrationDone", "getProductRegistrationDone", false],
    ["RegistedInfoByAcerValidProdAPI", "setRegistedInfoByAcerValidProdAPI", "getRegistedInfoByAcerValidProdAPI", false],
    ["WarrantyInfo", "setWarrantyInfo", "getWarrantyInfo", null],
    ["AccessFromNoti", "setAccessFromNoti", "getAccessFromNoti", false],
    ["AcerIdKey", "setAcerIdKey", "getAcerIdKey", null],
    ["MonitoringWidgetData", "setMonitoringWidgetData", "getMonitoringWidgetData", null],
];

// ------------------------------------------------------------- scenario state
/* their scenario.ts default model (main.js DEFAULT_SCENARIO + getInitialProfile)
 * LIGHTING_DEVICE: GLOBAL=0 KEYBOARD=1; deviceName strings from LightingDeviceName */
const KB4ZONES = () => [0, 1, 2, 3].map((i) => ({ LED_id: i, color: "#00aec7", status: 1 }));
const GLOBAL_EFFECT = (over) => ({
    device: 0, effect: "WAVE", speed: 3, duration: 3, direction: 1,
    brightness: 5, color: "#00aec7", random: true, LEDs: [], dyEffect: "WAVE", music_effect: 1,
    ...(over ?? {}),
});
const KB_DEVICE = (over) => ({
    device: 1, deviceName: "AcerECKeyboard Device", effect: "STATIC",
    speed: 5, duration: 5, direction: 1, brightness: 5, color: "#00aec7",
    random: true, LEDs: KB4ZONES(), dyEffect: "WAVE", music_effect: 1,
    GA4_Label: "lighting_area_kb_effect",
    ...(over ?? {}),
});
function baseProfile(name, over) {
    return {
        name, appNames: [], enabled: true,
        opMode: 1, dcMode: 1, LastOpMode: 1,
        fanControl: {
            mode: 0, custom_fan_data: [
                { fan_custom_auto: 1, fan_custom_speed: 30, fan_index: 0, fan_name: "CPU" },
                { fan_custom_auto: 1, fan_custom_speed: 30, fan_index: 0, fan_name: "GPU" },
            ],
        },
        audioMode: 0,
        lighting: { mode: 0, GlobalEffect: GLOBAL_EFFECT(), devices: [KB_DEVICE()], tempBrightness: undefined },
        EnableEco: false,
        ...(over ?? {}),
    };
}
function defaultScenario() {
    const daily = baseProfile("MUI_DAILY_USE");
    const gaming = baseProfile("MUI_GAMING", {
        opMode: 4, LastOpMode: 4, audioMode: 5,                       // EXTREME + SHOOTER
        lighting: { mode: 0, GlobalEffect: GLOBAL_EFFECT({ effect: "BREATHING" }), devices: [KB_DEVICE({ effect: "BREATHING" })] },
    });
    const quiet = baseProfile("MUI_QUIET_OCCASION", {
        opMode: 0, LastOpMode: 0,
        lighting: { mode: 0, GlobalEffect: GLOBAL_EFFECT({ effect: "STATIC" }), devices: [KB_DEVICE()] },
    });
    return { active: 0, select: 0, profiles: [daily, gaming, quiet] };
}

function loadScenario() {
    if (scenario) return scenario;
    let fresh = false;
    try {
        scenario = JSON.parse(fs.readFileSync(SCENARIO_FILE, "utf8"));
    } catch {
        scenario = defaultScenario();
        fresh = true;
    }
    if (!Array.isArray(scenario.profiles) || scenario.profiles.length === 0) {
        scenario = defaultScenario();               // their Initial_Profile branch
        fresh = true;
    }
    if (fresh) {
        saveScenario();
        log("scenario: preset profiles seeded");
        // their main.js sends INITIAL_LIGHTING after preset creation; we mirror
        // that from main.js post-load (renderer PSS isn't listening this early)
    }
    return scenario;
}
function saveScenario() {
    try {
        fs.mkdirSync(path.dirname(SCENARIO_FILE), { recursive: true });
        fs.writeFileSync(SCENARIO_FILE,
            JSON.stringify(scenario ?? loadScenario(), null, 1));
        // their main re-seeds fn.LIGHTING from the active profile after scenario
        // mutations (profile switch) — keep the store in the same dynamic.
        setIfChanged("LIGHTING", activeLighting());
        // GTe subscribes "ScenarioChanged" and REPLACES its scenario data with
        // the broadcast payload (GTe.broadCastDataChanged). Without this the
        // renderer keeps a stale CurrentProfile and lighting edits revert.
        emit("ScenarioChanged", scenario ?? loadScenario());
    } catch (e) { log("scenario save failed:", e.message); }
}

// default profile template until chunk analysis pins every field
const DEFAULT_PROFILE = () => ({
    name: "",
    thermal: { mode: "balanced" },
    fan: { mode: "auto", cpuPct: null, gpuPct: null },
    lighting: { mode: 0, rgb: [255, 120, 0], brightness: 100, zones: "all" },
});

/* their main.js literal (readOEMSettings default) — verbatim flags, values
 * adapted: Planet9=false (no cloud), keyboard/interactive=true (EC RGB kb). */
const OEM_SETTINGS = () => ({
    Features: { Planet9: false, Mobile: false, EnableVR: false },
    HighlightFeature: { PurifiedView: true, PurifiedVoice: true },
    Planet9_Url: "https://planet9.gg/",
    EnableAvatarVideo: false,
    EnableAvatarApng: false,
    ACDCModeSet: true,
    ModeSwitchKey: true,
    ModeSwitchKeyUI: true,
    windowsMenuKey: true,
    Lighting: {
        keyboard: true, keyboard_device: "",
        eclogo: false, lightbar: false, logo: false,
        lightbar_rear: false, lightbar_rear_device: "",
        mculogo: false, interactive: true,
    },
});

// ------------------------------------------------------------------ handlers
// Coalesce simultaneous FunctionQuery + USBCharge(Get) + USBChargeSwitch(Get)
// on port 5141 into one usbcharge.get WMI eval.
let _usbchargeCache = null, _usbchargeAt = 0, _usbchargeInflight = null;
function usbchargeGetCached() {
    if (_usbchargeCache && Date.now() - _usbchargeAt < 1000) {
        return Promise.resolve(_usbchargeCache);
    }
    if (_usbchargeInflight) return _usbchargeInflight;
    _usbchargeInflight = (async () => {
        try {
            const r = await daemonCall("usbcharge.get", undefined, 15000);
            if (r && r.status === 0) {
                _usbchargeCache = r;
                _usbchargeAt = Date.now();
            }
            return r;
        } finally {
            _usbchargeInflight = null;
        }
    })();
    return _usbchargeInflight;
}
async function usbchargeSetRun(opts) {
    _usbchargeCache = null;
    _usbchargeAt = 0;
    const r = await daemonCall("usbcharge.set", opts ?? {}, 15000);
    if (r && r.committed && r.reported) {
        _usbchargeCache = { status: 0, ...r.reported };
        _usbchargeAt = Date.now();
    }
    return r;
}

const HANDLERS = {
    // root-side hardware snapshot for their DeviceInfo/Battery wsinfo channels
    // (see main.js wsinfo data providers — ledger §13.23)
    psense: {
        sysinfo: () => daemonCall("sysinfo"),
        health: () => daemonCall("health"),
        // battery charge mode (CareCenter BatteryHealthy; ledger §13.25).
        // 15 s: the renderer's periodic auto-GET can queue behind a slow
        // kb.zone.set repaint in the daemon's serialized WMI worker.
        battmodeGet: () => daemonCall("battmode.get", undefined, 15000),
        battmodeSet: ([v]) => daemonCall("battmode.set", { value: v }, 15000),
        // Power-off USB charge (QuickAccess USBChargeSwitch / USBCharge; ledger §13.29).
        usbchargeGet: () => usbchargeGetCached(),
        usbchargeSet: ([opts]) => usbchargeSetRun(opts),
    },
    scenario: {
        getScenario: () => loadScenario(),
        setScenario: ([data]) => { scenario = data ?? loadScenario(); return null; },
        saveScenario: () => { const s = loadScenario(); saveScenario(); emit("ScenarioChanged", s); return s; },
        getData: () => loadScenario(),
        SaveData: ([data]) => { scenario = data ?? loadScenario(); saveScenario(); emit("ScenarioChanged", scenario); return null; },
        setDataWithoutScenario: ([data]) => { if (data) scenario = data; return null; },
        getProfile: ([name]) => {
            const s = loadScenario();
            if (name == null) return s.profiles?.[s.active] ?? null;
            return (s.profiles ?? []).find((p) => p.name === name) ?? null;
        },
        setProfile: ([arg1, arg2]) => {
            const s = loadScenario();
            const prof = (typeof arg1 === "object" && arg1 !== null) ? arg1 : (arg2 ?? {});
            const name = (typeof arg1 === "string") ? arg1 : (prof.name ?? "profile");
            const p = { ...(DEFAULT_PROFILE()), ...prof, name };
            s.profiles = s.profiles ?? [];
            const i = s.profiles.findIndex((x) => x.name === p.name);
            if (i >= 0) s.profiles[i] = p; else s.profiles.push(p);
            saveScenario();
            emit("ScenarioChanged", s);
            return p;
        },
        deleteProfile: ([name]) => {
            const s = loadScenario();
            s.profiles = (s.profiles ?? []).filter((p) => p.name !== name);
            saveScenario();
            emit("ScenarioChanged", s);
            return null;
        },
        getInitialProfile: ([key]) => ({
            name: key,
            thermal: { mode: "balanced" },
            fan: { mode: "auto", cpuPct: null, gpuPct: null },
            lighting: null,
        }),
        getDefaultProfile: () => DEFAULT_PROFILE(),
        PowerResume: ([on]) => { log("scenario.PowerResume", on, "→ kb.get astray (§13.18: firmware recolors kb on profile changes)"); return null; },
        WidgetOverlayUnplugACApply: () => null,
    },
    info: {
        getAppVersion: () => "5.0.1463",
        getOEMSettings: () => OEM_SETTINGS(),
        getSerialNumber: async () =>
            (await daemonCall("sysinfo"))?.serial || "LNX" + machineId().slice(0, 12).toUpperCase(),
        getSystemUuid: async () => {
            const si = await daemonCall("sysinfo");
            return si?.uuid ||
                machineId().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5") || machineId();
        },
        getMachineGuid: () => machineId(),
        getSystemFamily: () => "Predator PHN16-71",
        getSystemProductName: () => "Predator PHN16-71",
        getSystemCPUName: () => "",
        getCountry: () => "",
        getLocaleCountryCode: () => (app.getLocaleCountryCode() || "US"),
        getCountryFromPublicIP: () => "",
        getLocale: () => (app.getLocale() || "en"),
        getLanguage: () => (app.getLocale() || "en"),
        getIsOLED: () => false,
        getSimulatorMode: () => false,
        getIsMobilePlatform: () => false,
        getIsAgreePrivacyPolicy: () => loadKV()["IsAgreePrivacyPolicy"] ?? true,
        getGAInfoAgree: () => loadKV()["IsAgreePrivacyPolicy"] != null ? !!loadKV()["IsAgreePrivacyPolicy"] : true,
        getTemperatureUnit: () => 1,    // cn.Celsius (their store default = 1)
        getneedtosendpp: () => false,
        getAcerAccount: () => null,
        getAcerCredential: () => null,
        removeAcerCredential: () => { kvSet("AcerIdKey", null); return null; },
        getAcerAnswer: () => null,
        getAcerCommunity: () => null,
        getAcerBoxTicked: () => null,
        getProclip: () => null,
        getForceRegistFail: () => false,
        getFirebaseSenderId: () => "",
        getBackendApiUrl: () => "",
        getNewerUpdates: () => null,
        getUpdateCheckPeriod: () => 0,
        getUpdateWarrantyDatePeriod: () => 0,
        getAvailableSize: () => null,
        getWarranty: () => null,
        getEnableDeleteProd: () => false,
        getContentInfo: () => null,
        getForegroundWin: () => detectForegroundWindow(),
        getHighlightFeature: () => ({
            PurifiedView: true,
            PurifiedVoice: true,
        }),
        getForceRegistFail: () => false,
        getHasStoreNewerVersionStatus: () => false,
        getLastActiveContentPath: () => loadKV()["LastActiveContentPath"] ?? "",
        setLastActiveContentPath: ([v]) => { kvSet("LastActiveContentPath", v ?? ""); return null; },
        getLastBootTime: () => {
            try {
                const m = fs.readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)/m);
                return m ? Number(m[1]) : 0;
            } catch { return 0; }
        },
        // Windows Dynamic Lighting status: null = not controlling (any truthy
        // value makes the lighting page show the "Windows Dynamic Lighting"
        // takeover dialog and disable the panels)
        getDynamicLighting: () => null,
        getNetworkInterfaces: () => [],
        getBatteryCalibrationLastCheckTime: () => loadKV()["BatteryCalibrationLastCheckTime"] ?? 0,
        recordoledPanels: ([v]) => { kvSet("oledPanels", v ?? null); return null; },
        setEnable3d: ([v]) => { kvSet("Enable3d", !!v); return null; },
        execSync: ([cmd]) => { log("info.execSync suppressed:", cmd); return null; },
        openHyperLink: ([url]) => { log("openHyperLink", url); return null; },
    },
    util: {
        minimizeMainWindow: () => { getWin()?.minimize(); return null; },
        restartComputer: () => { log("restartComputer suppressed"); return null; },
        showNotification: ([title, body]) => {
            try { new Notification({ title: String(title ?? ""), body: String(body ?? "") }).show(); }
            catch (e) { log("notify failed:", e.message); }
            return null;
        },
        getResolution: () => { const s = screen.getPrimaryDisplay().size; return [s.width, s.height]; },
        getFavoriteColor: () => [255, 120, 0],
        setFavoriteColor: ([v]) => { kvSet("favoriteColor", v ?? null); return null; },
        getTutorialShow: ([k]) => loadKV()[`tutorial.${String(k ?? "")}`] ?? false,
        setTutorialShow: ([k, v]) => { kvSet(`tutorial.${String(k ?? "")}`, v !== false); return null; },
        getAddPreloadAsDefault: () => loadKV()["addPreload"] ?? false,
        setAddPreloadAsDefault: ([v]) => { kvSet("addPreload", !!v); return null; },
        EnableEco: async () => { const r = await daemonCall("profile.set", { name: "low-power" }); return r ?? null; },
        ExitEco: async () => { const r = await daemonCall("profile.set", { name: "balanced" }); return r ?? null; },
        IsEnableEco: async () => { const r = await daemonCall("profile.get", {}); return r?.profile === "low-power"; },
        getImageColorDepth: () => null,
        checkQAExist: () => false,
        callADES: () => null,
        getServiceVer: () => "linux-shim-1",
        setOobeNotification: () => null,
        setWidgetsList: () => null,
        getWidgetsList: () => [],
        getHasShowUI: () => true,
        dynamicLightingChange: () => null,
        openDynamicLighting: () => null,
        openCameraSettings: () => {
            log("openCameraSettings invoked");
            try {
                const { exec } = require("child_process");
                exec("snapshot || cheese || kamoso || true", (err) => {
                    if (err) log("openCameraSettings launch error:", err.message);
                });
            } catch (e) { log("openCameraSettings failed:", e.message); }
            return null;
        },
        openPurifiedVoice: () => {
            log("openPurifiedVoice invoked");
            try {
                const { exec } = require("child_process");
                const scriptPath = path.join(__dirname, "../../scripts/psense-purified-voice.sh");
                exec(`psense-purified-voice || bash "${scriptPath}" || pavucontrol || true`, (err) => {
                    if (err) log("openPurifiedVoice launch error:", err.message);
                });
            } catch (e) { log("openPurifiedVoice failed:", e.message); }
            return null;
        },
        OnEyeDropper: () => null,
        inspect: () => null,
        GetNotificationIcon: () => null,
    },
    pssdk: {
        setDeviceData: async ([funcName, data]) => {
            const k = String(funcName);
            let out = data;
            if (k === "LIGHTING") {
                // their pssdk LIGHTING store keeps a profile-shaped model
                // ({GlobalEffect, devices[]}) — per-device entries update their
                // own sub-key (device 0 = GLOBAL) and refresh queries route by
                // {device:N} (vo.refreshParam / LightingMap.get(n).refreshParam)
                out = mergeLightingEntry(data);
                pssdkStore.set(k, out);
                persistLightingModel(out);   // MUST land BEFORE emit: the page
            } else if (k === "OPERATING_MODE") {
                // vendor main.js:99330: setDeviceData updates active profile opMode
                // and saves scenario so ScenarioChanged broadcasts to renderer GTe.
                // Without this, lc.currentMode keeps reading stale CurrentProfile.opMode
                // and the clicked mode plate never highlights in the UI (§13.31).
                const m = Number(data);
                const isDc = readAcOnline() === false;
                if (isDc && !(m === 0 || m === 1 || m === 2 || m === 6)) {
                    log(`OPERATING_MODE ${m} rejected on DC (only 0=Quiet, 1=Balanced, 2/6=Eco allowed)`);
                    return null;
                }
                pssdkStore.set(k, m);
                try {
                    const s = loadScenario();
                    const p = s?.profiles?.[s.active];
                    if (p) {
                        if (isDc) {
                            p.dcMode = m;
                        } else {
                            p.opMode = m;
                            if (m !== 5) p.LastOpMode = m;
                        }
                        saveScenario();
                    }
                } catch (e) { log("scenario opMode save failed:", e.message); }
                emit(k, m);
                await applyPssdkWrite(k, m);
                return null;
            } else if (k === "FAN_CONTROL") {
                pssdkStore.set(k, data);
                try {
                    const s = loadScenario();
                    const p = s?.profiles?.[s.active];
                    if (p) {
                        p.fanControl = data;
                        saveScenario();
                    }
                } catch (e) { log("scenario fanControl save failed:", e.message); }
            } else if (k === "GPU_MODE") {
                pssdkStore.set(k, data);
                kvSet("GPUMode", Number(data));
                log(`GPU_MODE set to ${data}`);
            } else if (k === "LCD_OVERDRIVE") {
                pssdkStore.set(k, data);
                kvSet("LCDOverdrive", Number(data));
                log(`LCD_OVERDRIVE set to ${data}`);
            } else pssdkStore.set(k, data);  // re-derives from the profile (§13.20)
            emit(k, data);
            await applyPssdkWrite(k, data);
            return null;
        },
        // vendor main.js: setDataWithoutScenario → adapter.setDeviceData — a
        // real hardware write that skips the scenario save (§13.30). Their
        // SwitchToProfileLightMode (area restore) and Global screen/music
        // mapping route lighting through here. Only LIGHTING is applied:
        // OPERATING_MODE/FAN_CONTROL arrive from applyProfile on every launch
        // with the profile's stored opMode, which our plate writes do not
        // update — applying them would clobber the live mode at startup.
        setDataWithoutScenario: async ([funcName, data]) => {
            const k = String(funcName);
            if (k === "LIGHTING") {
                pssdkStore.set(k, mergeLightingEntry(data));
                emit(k, data);
                await applyPssdkWrite(k, data);
                return null;
            }
            if (k === "OPERATING_MODE") {
                const m = Number(data);
                const isDc = readAcOnline() === false;
                if (isDc && !(m === 0 || m === 1 || m === 2 || m === 6)) {
                    log(`setDataWithoutScenario OPERATING_MODE ${m} rejected on DC`);
                    return null;
                }
                pssdkStore.set(k, m);
                try {
                    const s = loadScenario();
                    const p = s?.profiles?.[s.active];
                    if (p) {
                        if (isDc) {
                            p.dcMode = m;
                        } else {
                            p.opMode = m;
                            if (m !== 5) p.LastOpMode = m;
                        }
                        saveScenario();
                    }
                } catch (e) { log("scenario dcMode save failed:", e.message); }
                emit(k, m);
                await applyPssdkWrite(k, m);
                return null;
            }
            pssdkStore.set(k, data);
            emit(k, data);
            return null;
        },
        getUpdatedData: ([funcName]) => {
            const k = String(funcName);
            const v = pssdkStore.get(k);
            if (k === "LIGHTING" && (v == null || (typeof v === "object" && !v.GlobalEffect && !(v.devices?.length) && !v.effect)))
                return activeLighting();   // lazily seeded from the active profile
            return v ?? null;
        },
        getUpdatedDataParam: ([funcName, q]) => {
            const k = String(funcName);
            if (k !== "LIGHTING") return pssdkStore.get(k) ?? null;
            const v = pssdkStore.get(k) ?? activeLighting();
            if (typeof v !== "object" || v == null || q == null || typeof q !== "object") return v;
            const dev = Number(q.device);
            if (Number.isNaN(dev)) return v;
            if (dev === 0) return { device: 0, ...(v.GlobalEffect ?? {}) };
            return (v.devices ?? []).find((d) => Number(d.device) === dev) ?? null;
        },
        setWhisperMode: () => null,
        getWhisperMode: () => false,
        enableSesenWidget: () => null,
        // their connected-device list feeds zTe.InitialLighting (device tabs).
        // PHN16-71: EC 4-zone keyboard only (no lightbar/logo/magkey).
        getConnectedDevice: () => [
            { device: 1, deviceName: "AcerECKeyboard Device", GA4_Label: "lighting_area_kb_effect" },
        ],
        getSupportKerboardInfo: () => ({ keyboard_led_type: 4 }),   // Er.FOUR_AREA
        getSupportOperatingMode: () => [0, 1, 4, 5, 6],             // Ye.* we drive
        getSupportOverclockingMode: () => [],
        getSupportAudioMode: () => [0, 1, 2, 3, 4, 5, 6, 10],       // d0.*
        getSupportLCDOverdrive: () => true,
        getSupportGPUMode: () => loadKV()["GPUMode"] ?? 0,
        getSupportGPUModeCapability: () => 7,
        getSupportBootLogo: () => false,
        // their CPU/GPU info rings read data[0].cpu_name/cpu_max_frequency(MHz)
        getSupportCPUInfo: () => {
            try {
                const name = (fs.readFileSync("/proc/cpuinfo", "utf8")
                    .match(/^model name\s*:\s*(.+)$/m)?.[1] ?? "").trim();
                const kHz = Number(fs.readFileSync(
                    "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq", "utf8"));
                return [{ cpu_name: name, cpu_max_frequency: Math.round(kHz / 1000) }];
            } catch { return [{ cpu_name: "", cpu_max_frequency: 0 }]; }
        },
        getSupportGPUInfo: () => [gpuNameEntry()],
        // fan descriptor list (their fanDailsControl.data[i].fan_name consumers)
        getSupportFanControl: () => [
            { fan_index: 0, fan_name: "CPU" },
            { fan_index: 0, fan_name: "GPU" },
        ],
    },
    appCenter: {
        SetInteractiveLighting: async ([effId, bri]) => {
            try {
                const id = Number(effId ?? 9);
                log(`appCenter.SetInteractiveLighting effId=${id} bri=${bri}`);
                if (id === 0) return null; // sunrex_Stop
                const INTERACTIVE_MAP = {
                    1: 3, // sunrex_Wave -> WAVE
                    2: 2, // sunrex_Neon -> NEON
                    3: 2, // sunrex_Rock -> NEON
                    4: 1, // sunrex_Lightning -> BREATHING
                    5: 1, // sunrex_Xlight -> BREATHING
                    6: 1, // sunrex_Rain -> BREATHING
                    7: 2, // sunrex_Digital -> NEON
                    8: 3, // sunrex_Spectrum -> WAVE
                    9: 2, // sunrex_ScreenSync -> NEON (vendor main.8ed9dc924c527068.js §1262266)
                };
                const mode = INTERACTIVE_MAP[id] ?? 2;
                const rawBri = Number(bri ?? 5);
                const b = !Number.isFinite(rawBri) ? 100
                    : rawBri <= 5 ? clampi((rawBri - 1) * 25, 0, 100) : clampi(rawBri, 0, 100);
                await daemonCall("kb.set", { mode, speed: 3, brightness: b, dir: 0, rgb: [0, 174, 199] });
            } catch (e) { log("SetInteractiveLighting error:", e.message); }
            return null;
        },
        getAllWidgetApps: () => [],
        setAllWidgetApps: () => null,
        launchInGameOverlay: () => null,
        launchP9ProclipInstaller: () => null,
        getUserFileInfo: () => null,

        /* Linux app library from XDG .desktop entries (their Windows scan uses
           .lnk paths; we mirror the object contract: id/name/display/
           linkTargetParsingPath/icon + appUsageInfo consumers).   §13.21 */
        getAllInstalledApps: () => xdgApps(),
        getAllAppUsageInfos: () => [],
        getUserApps: () => loadKV()["userApps"] ?? [],
        setUserApps: ([v]) => { kvSet("userApps", v ?? null); return null; },
        getPinApps: () => loadKV()["pinApps"] ?? [],
        setPinApps: ([v]) => { kvSet("pinApps", v ?? null); return null; },
        // enums: Go{Popularity0,Alphabet1,LastUsed2,InstallDate3} Xn{All0,Preload1,Game2}
        getAppCenterFilterByType: () => loadKV()["appCenterFilter"] ?? { filterBy: 0, SortBy: 0 },
        setAppCenterFilterByType: ([v]) => { kvSet("appCenterFilter", v ?? null); return null; },
        getScenarioFilterByType: () => loadKV()["scenarioFilter"] ?? { filterBy: 0, SortBy: 0 },
        setScenarioFilterByType: ([v]) => { kvSet("scenarioFilter", v ?? null); return null; },
        getAppIconDataUri: ([app]) => appIconUri(app),
        // launch by XDG entry; detached child (desktop-app style)
        LaunchApp: ([app]) => xdgLaunch(app),
        setSwitchKey: async (a) => {
            const v = Array.isArray(a) && a.length === 1 ? a[0] : (a === undefined ? null : a);
            const val = Number(v ?? 0);
            kvSet("SwitchKey", val);
            await daemonCall("switchkey.set", { mode: val });
            return null;
        },
        getSwitchKey: async () => {
            const kv = loadKV();
            if (kv["SwitchKey"] !== undefined) return kv["SwitchKey"];
            const r = await daemonCall("switchkey.get", {});
            return r?.mode ?? 0;
        },
    },
    logIt: {
        debug: (a) => { console.log("[ui.debug]", ...a); },
        debugview: (a) => { console.log("[ui.dbgview]", ...a); },
        info: (a) => { console.log("[ui.info]", ...a); },
        error: (a) => { console.error("[ui.error]", ...a); },
    },
};

// generate the KV get/set pairs on HANDLERS.info
for (const [key, setFn, getFn, def] of KV_PAIRS) {
    if (HANDLERS.info[getFn]) continue;             // explicit handler wins
    HANDLERS.info[setFn] = (a) => {
        const v = Array.isArray(a) && a.length === 1 ? a[0] : (a === undefined ? null : a);
        kvSet(key, v === undefined ? null : v);
        return null;
    };
    HANDLERS.info[getFn] = () => {
        const kv = loadKV();
        if (kv[key] !== undefined) return kv[key];
        return typeof def === "function" ? def() : def;
    };
}
// BACTimeZone pair is generated from KV_PAIRS above

const gpuNameEntry = (() => {
    let cached = null;
    try {
        const { execFile } = require("child_process");
        execFile("nvidia-smi", ["--format=csv,noheader", "--query-gpu=name"],
            { timeout: 2500 }, (err, stdout) => {
                if (!err && String(stdout).trim()) cached = [{ gpu_name: String(stdout).trim() }];
            });
    } catch { }
    return () => cached ?? [{ gpu_name: "NVIDIA Discrete GPU" }];
})();

// ------------------------------------------------------------- psensed live pump
const SYS_LABEL = { temp1_input: "cpu", temp2_input: "sys", temp3_input: "gpu" };
let cpuLast = null;

/* One /proc/stat sample per pump tick (§13.30). The old sampler ran twice
 * per tick (buildMonitorData, then again ~15 ms later after nvidia-smi), so
 * the second call measured a tiny window and reset the baseline for the next
 * second. Columns: user nice system idle iowait irq softirq steal — guest
 * time is already folded into user/nice, so only the first 8 are summed. */
function cpuSample() {
    const parse = () => {
        try {
            const out = { all: null, cores: [] };
            for (const ln of fs.readFileSync("/proc/stat", "utf8").split("\n")) {
                const m = ln.match(/^cpu(\d*)\s+(.+)$/);
                if (!m) continue;
                const p = m[2].trim().split(/\s+/).slice(0, 8).map(Number);
                while (p.length < 8) p.push(0);
                const v = { idle: p[3] + p[4], total: p.reduce((a, b) => a + b, 0) };
                if (m[1] === "") out.all = v; else out.cores[Number(m[1])] = v;
            }
            return out.all ? out : null;
        } catch { return null; }
    };
    const now = parse();
    const prev = cpuLast;
    cpuLast = now;
    if (!now || !prev) return null;
    const dt = now.all.total - prev.all.total, di = now.all.idle - prev.all.idle;
    const coreBusy = now.cores.map((c, i) => {
        const p = prev.cores[i];
        if (!c || !p) return 0;
        return Math.max(0, (c.total - p.total) - (c.idle - p.idle));
    });
    return {
        usage: dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : null,
        coreBusy,
    };
}

function ramUsagePct() {
    try {
        const mi = fs.readFileSync("/proc/meminfo", "utf8");
        const tot = Number(mi.match(/^MemTotal:\s+(\d+)/m)?.[1]) || 0;
        const avail = Number(mi.match(/^MemAvailable:\s+(\d+)/m)?.[1]) || 0;
        return tot ? Math.round((1 - avail / tot) * 100) : null;
    } catch { return null; }
}

function setIfChanged(key, v, emitPayload) {
    const prev = pssdkStore.get(key);
    if (JSON.stringify(prev) === JSON.stringify(v)) return false;
    pssdkStore.set(key, v);
    if (emitPayload === false) return true;
    if (emitPayload !== undefined) {
        emit(key, emitPayload);
    } else if (key === "BATTERY_BOOST") {
        emit(key, { status: v });
    } else {
        emit(key, v);
    }
    return true;
}

// monitor panel
/* shape copied from their daemonService.monitorData / main.js GET_MONITOR_DATA */
let lastNet = null;
let ramInfo = null;
let ramInfoTs = 0;

async function ramFrequency() {          // SMBIOS via psensed `memory` (60 s cache)
    try {
        if (!ramInfo || Date.now() - ramInfoTs > 60000) {
            const m = await daemonCall("memory", {});
            ramInfo = m && !m.error ? m : null;
            ramInfoTs = Date.now();
        }
        return Number(ramInfo?.frequency ?? 0);
    } catch { return 0; }
}

function netRates() {
    try {
        const cur = {};
        for (const line of fs.readFileSync("/proc/net/dev", "utf8").split(/\n/)) {
            const m = line.match(/^(\s*[a-z0-9@.]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
            if (!m) continue;
            cur[m[1].trim()] = { rx: Number(m[2]), tx: Number(m[3]) };
        }
        const out = { wifi_down: 0, wifi_up: 0, eth_down: 0, eth_up: 0 };
        if (lastNet && (Date.now() - lastNet.t) >= 500) {
            const dt = (Date.now() - lastNet.t) / 1000;
            for (const [name, v] of Object.entries(cur)) {
                const prev = lastNet.d[name];
                if (!prev) continue;
                const drx = Math.max(0, v.rx - prev.rx) / dt / 1024;   // KB/s
                const dtx = Math.max(0, v.tx - prev.tx) / dt / 1024;
                const wifi = name.startsWith("w") || name.startsWith("W");
                const eth = name.startsWith("e") || name.startsWith("E");
                if (wifi) { out.wifi_down += drx; out.wifi_up += dtx; }
                else if (eth) { out.eth_down += drx; out.eth_up += dtx; }   // skip lo/docker/veth
            }
        }
        lastNet = { d: cur, t: Date.now() };
        return out;
    } catch { return { wifi_down: 0, wifi_up: 0, eth_down: 0, eth_up: 0 }; }
}

async function nvidiaState() {
    const { execFile } = require("child_process");
    return new Promise((resolve) => {
        execFile("nvidia-smi", ["--format=csv,noheader,nounits",
            "--query-gpu=temperature.gpu,utilization.gpu,clocks.current.graphics,clocks.max.graphics"],
            { timeout: 1500 }, (err, stdout) => {
                if (err) return resolve(null);
                const p = String(stdout).trim().split(/\s*,\s*/).map(Number);
                resolve({
                    temp: p[0] ?? null, usage: p[1] ?? null,
                    freq: p[2] ?? null, maxFreq: p[3] ?? null,
                });
            });
    });
}

function cpuCoreFreqsMHz() {
    // index = logical core number (readdir order is lexicographic: cpu0,
    // cpu1, cpu10, … — CPU_CORE_FREQUENCY[i] must be core i)
    try {
        const out = [];
        for (const n of fs.readdirSync("/sys/devices/system/cpu")) {
            const m = n.match(/^cpu(\d+)$/);
            if (!m) continue;
            try {
                const f = Number(fs.readFileSync(`/sys/devices/system/cpu/${n}/cpufreq/scaling_cur_freq`, "utf8"));
                if (Number.isFinite(f) && f > 0) out[Number(m[1])] = Math.round(f / 1000);   // kHz → MHz
            } catch { }
        }
        const dense = Array.from(out, (v) => v ?? 0);
        return dense.some((v) => v > 0) ? dense : null;
    } catch { return null; }
}

/* Aggregate clock (§13.30). AcerAgentService reports the _Total PDH
 * "% Processor Performance" × MaxClockSpeed — a whole-package figure. The
 * old Math.max(...freqs) showed whichever single thread had just boosted
 * (~4.7 GHz on an idle 24-thread i7-13700HX). Weight each core's clock by
 * the busy ticks it spent in the same 1 s window; all-idle → plain mean. */
function cpuAggregateMHz(freqs, coreBusy) {
    if (!freqs || !freqs.length) return 0;
    let w = 0, acc = 0;
    if (Array.isArray(coreBusy)) {
        freqs.forEach((f, i) => {
            const b = coreBusy[i] ?? 0;
            if (f > 0 && b > 0) { w += b; acc += f * b; }
        });
    }
    if (w > 0) return Math.round(acc / w);
    const live = freqs.filter((f) => f > 0);
    return live.length ? Math.round(live.reduce((a, b) => a + b, 0) / live.length) : 0;
}

function cpuCoreCount() {
    try { return fs.readFileSync("/proc/cpuinfo", "utf8").match(/^processor/mg)?.length ?? 0; }
    catch { return 0; }
}

async function buildMonitorData(sensors, fans, cpu) {
    const temps = sensors && !sensors.error ? sensors.temps ?? {} : {};
    const rpm = sensors && !sensors.error ? sensors.fans_rpm ?? {} : {};
    const gpu = await nvidiaState();
    const net = netRates();
    const mi = (() => {
        try { return fs.readFileSync("/proc/meminfo", "utf8"); } catch { return ""; }
    })();
    const memTotalKB = Number(mi.match(/^MemTotal:\s+(\d+)/m)?.[1]) || 0;
    const memAvailKB = Number(mi.match(/^MemAvailable:\s+(\d+)/m)?.[1]) || 0;
    const ramUsage = memTotalKB ? Math.round((1 - memAvailKB / memTotalKB) * 1000) / 10 : 0;
    const freqs = cpuCoreFreqsMHz();
    const data = {
        timeStamp: new Date(),
        CPU_CORE_AMOUNT: cpuCoreCount(),
        CPU_CORE_FREQUENCY: freqs ?? [],
        CPU_FREQUENCY: cpuAggregateMHz(freqs, cpu?.coreBusy),
        CPU_TEMPERATURE: temps.temp1_input != null ? Math.round(temps.temp1_input / 1000) : 0,
        CPU_USAGE: cpu?.usage ?? 0,
        CPU_FANSPEED: Number(rpm.cpu ?? 0),
        GPU1_FREQUENCY: gpu?.freq ?? 0,
        GPU1_TEMPERATURE: gpu?.temp ?? (temps.temp3_input != null ? Math.round(temps.temp3_input / 1000) : 0),
        GPU1_USAGE: gpu?.usage ?? 0,
        GPU1_IDLE_STATUS: gpu ? (gpu.usage <= 2 ? 1 : 0) : 1,
        GPU1_MAX_FREQUENCY: gpu?.maxFreq ?? 0,
        GPU1_FANSPEED: Number(rpm.gpu ?? 0),
        SYS1_TEMPERATURE: temps.temp2_input != null ? Math.round(temps.temp2_input / 1000) : 0,
        SYS1_FANSPEED: Number(rpm.gpu ?? 0),
        RAM_FREQUENCY: await ramFrequency(),              // MT/s → their "MHz"
        RAM_TOTAL: Math.round(memTotalKB / 1024),          // MB
        RAM_USAGE: ramUsage,                              // %
        ETHERNET_DOWNLOAD: Math.round(net.eth_down),
        ETHERNET_UPLOAD: Math.round(net.eth_up),
        WIFI_DOWNLOAD: Math.round(net.wifi_down),
        WIFI_UPLOAD: Math.round(net.wifi_up),
    };
    return data;
}

function notifyModeChange(mode) {
    try {
        const MODE_NAMES = { 0: "Quiet", 1: "Balanced", 2: "Eco", 4: "Performance", 5: "Turbo", 6: "Eco" };
        const name = MODE_NAMES[mode] ?? `Mode ${mode}`;
        new Notification({
            title: "PredatorSense",
            body: `Operating Mode: ${name}`,
            silent: true,
        }).show();
    } catch {}
}

let _lastForegroundWin = null;
let _lastForegroundCheck = 0;

function detectForegroundWindow() {
    if (Date.now() - _lastForegroundCheck < 1500 && _lastForegroundWin !== null) {
        return _lastForegroundWin;
    }
    _lastForegroundCheck = Date.now();
    try {
        const { execSync } = require("child_process");
        const out = execSync("xprop -root _NET_ACTIVE_WINDOW 2>/dev/null", { timeout: 250, encoding: "utf8" });
        const m = out.match(/_NET_ACTIVE_WINDOW\(WINDOW\):\s*window id #\s*(0x[0-9a-fA-F]+)/);
        if (m && m[1] && m[1] !== "0x0") {
            const classOut = execSync(`xprop -id ${m[1]} WM_CLASS 2>/dev/null`, { timeout: 250, encoding: "utf8" });
            const cm = classOut.match(/WM_CLASS\(STRING\) = "([^"]+)", "([^"]+)"/);
            if (cm) {
                _lastForegroundWin = cm[2] || cm[1];
                return _lastForegroundWin;
            }
        }
    } catch {}
    return _lastForegroundWin;
}

async function activateProfile(p) {
    if (!p) return;
    try {
        const acOn = readAcOnline();
        let mode = acOn === false ? (p.dcMode ?? 1) : (p.opMode ?? 1);
        if (acOn === false && (mode === 4 || mode === 5)) mode = 1;
        await applyPssdkWrite("OPERATING_MODE", mode);
        if (p.fanControl) await applyPssdkWrite("FAN_CONTROL", p.fanControl);
        if (p.lighting) await applyPssdkWrite("LIGHTING", p.lighting);
    } catch (e) {
        log("activateProfile error:", e.message);
    }
}

async function pumpOnce() {
    const cpu = cpuSample();          // exactly one /proc/stat delta per tick
    const [sensors, fans, prof] = await Promise.all([
        daemonCall("sensors", {}),
        daemonCall("fan.get", {}),
        daemonCall("profile.get", {}),
    ]);
    const acOn = readAcOnline();
    const boost = batteryBoostStatus();
    // monitor panel: broadcast the full native object every tick
    emit("UPDATE_MONITOR_DATA", await buildMonitorData(sensors, fans, cpu));
    if (cpu?.usage != null) setIfChanged("CPU_USAGE", cpu.usage);
    const ram = ramUsagePct();
    if (ram != null) setIfChanged("RAM_USAGE", ram);
    const sig = JSON.stringify([sensors, fans, prof, acOn, boost]);
    if (sig === pumpOnce._last) {
        pumpOnce._lastTs = Date.now();
        return;
    }
    pumpOnce._last = sig;
    try {        if (sensors && !sensors.error) {
            for (const [tn, mv] of Object.entries(sensors.temps ?? {})) {
                const label = SYS_LABEL[tn];
                if (label && mv != null) setIfChanged(`${label.toUpperCase()}_TEMPERATURE`,
                    Math.round(Number(mv)) / 1000);
            }
            if (sensors.fans_rpm) {
                for (const [k, v] of Object.entries(sensors.fans_rpm))
                    setIfChanged(`${k.toUpperCase()}_FANSPEED`, Number(v));
            }
        }
        if (fans && !fans.error) {
            for (const [k, v] of Object.entries(fans)) {
                if (k.startsWith("rpm_") && v != null)
                    setIfChanged(`${k.slice(4).toUpperCase()}_FANSPEED`, Number(v));
            }
        }
        if (setIfChanged("BATTERY_BOOST", boost, false)) {
            emit("BATTERY_BOOST", { status: boost });
        }
        if (prof && !prof.error && prof.profile) {
            let m = PROFILE_TO_MODE[prof.profile] ?? pssdkStore.get("OPERATING_MODE") ?? 1;
            // Battery safety clamp: high-power modes (balanced-performance 4, performance 5)
            // are disallowed on DC. If the physical key lands on 4 or 5 while unplugged,
            // immediately restore to balanced (1) to protect the battery pack.
            if (acOn === false && (m === 4 || m === 5)) {
                log(`battery mode clamp: ${prof.profile} -> balanced on DC`);
                await daemonCall("profile.set", { name: "balanced" });
                m = 1;
            }
            if (setIfChanged("OPERATING_MODE", m)) {
                notifyModeChange(m);
                try {
                    const s = loadScenario();
                    const p = s?.profiles?.[s.active];
                    if (p) {
                        if (acOn === false) {
                            if (p.dcMode !== m) {
                                p.dcMode = m;
                                saveScenario();
                            }
                        } else {
                            if (p.opMode !== m) {
                                p.opMode = m;
                                if (m !== 5) p.LastOpMode = m;
                                saveScenario();
                            }
                        }
                    }
                } catch {}
            }
        }
        if (acOn !== null) {
            if (setIfChanged("ADAPTOR_STATUS", acOn ? 1 : 0)) {
                emit("ADAPTOR_CHANGED", { status: acOn ? 1 : 0 });
            }
        }
        // Game / App Profile auto-switching
        try {
            const fg = detectForegroundWindow();
            if (fg) {
                const s = loadScenario();
                const matchedIdx = (s.profiles ?? []).findIndex(p =>
                    Array.isArray(p.appNames) && p.appNames.some(name =>
                        String(name).toLowerCase() === fg.toLowerCase() ||
                        fg.toLowerCase().includes(String(name).toLowerCase())
                    )
                );
                if (matchedIdx >= 0 && s.active !== matchedIdx) {
                    const matched = s.profiles[matchedIdx];
                    log(`auto-switching to profile "${matched.name}" for foreground app "${fg}"`);
                    s.active = matchedIdx;
                    saveScenario();
                    emit("ScenarioChanged", s);
                    activateProfile(matched);
                }
            }
        } catch (e) {
            log("scenario auto-switch error:", e.message);
        }
    } catch (e) { log("pump error:", e.message); }
}

function startPump() {
    if (pumpTimer) return;
    pumpOnce();
    let pumping = false;
    pumpTimer = setInterval(() => {
        if (pumping) return;           // a slow tick must not double-sample /proc/stat
        pumping = true;
        pumpOnce().catch((e) => log("pump fail:", e.message)).finally(() => { pumping = false; });
    }, 1000);
    log("pump started (1 Hz)");
    // Service-semantics boot apply (their AcerHardwareService restores the
    // active profile's lighting at startup). The EC register survives reboots
    // so this is normally a no-op diff — it exists to self-heal drift after
    // direct EC manipulation, firmware quirks or a forgotten un-applied edit.
    let bootApplyDone = false;
    setTimeout(async () => {
        if (bootApplyDone) return;
        bootApplyDone = true;
        try {
            const s = loadScenario();
            const prof = (s.profiles ?? [])[s.active ?? 0] ?? (s.profiles ?? [])[0];
            if (prof?.lighting) {
                log(`boot: applying profile lighting (${prof.name})`);
                await applyLightingWrite(prof.lighting);
            }
        } catch (e) {
            log("boot lighting apply failed:", e.message);
        }
    }, 5000);
}

function readAcOnline() {
    try {
        const dir = "/sys/class/power_supply";
        for (const n of fs.readdirSync(dir)) {
            const p = `${dir}/${n}`;
            let type = "";
            try { type = fs.readFileSync(`${p}/type`, "utf8").trim(); } catch { }
            if (type !== "Mains") continue;
            const on = fs.readFileSync(`${p}/online`, "utf8").trim();
            return on === "1";
        }
    } catch { }
    return null;
}

/* their BatteryBoost contract (ccagent-protocol-manual.json "BatteryBoost"):
 * getUpdatedData answers {status}, 1 = enabled / 0 = disabled, and the vendor
 * service is the decision authority — the vendor renderer locks the Scenario
 * mode plates the moment status reads 0 (dataModel.batteryBoost → LockMode).
 * Its UI banner pins the policy: "Mode switching is available when the
 * battery life is at least 40% capacity" (AC always unblocks). This is that
 * same rule computed from the real power supply, honest to Linux reality. */
function batteryBoostStatus() {
    if (readAcOnline()) return 1;
    try {
        const dir = "/sys/class/power_supply";
        for (const n of fs.readdirSync(dir)) {
            const p = `${dir}/${n}`;
            try {
                if (fs.readFileSync(`${p}/type`, "utf8").trim() !== "Battery") continue;
                const cap = Number(fs.readFileSync(`${p}/capacity`, "utf8").trim());
                return Number.isFinite(cap) && cap >= 40 ? 1 : 0;
            } catch { }
        }
    } catch { }
    return 0;
}

// ------------------------------------------------------------- lighting (EC kb)
/* Validated keyboard EC mode ids (spec §6.3, ledger §13.14.6/§13.16).
 * Strip-only ids (NEON=2, WAVE=3) pass through too — the EC forwards verbatim. */
const KB_EFFECT_IDS = {
    STATIC: 0, BREATHING: 1, NEON: 2, WAVE: 3, SHIFTING: 4,
    METEOR: 6, TWINKLING: 7, DIRECT: 0xFF,
};
const KB_DIRS = { RIGHT: 1, LEFT: 2, UP: 3, DOWN: 4, CLOCK: 5, ANTICLOCK: 6 };
const hexRgb = (hex) => {
    const m = String(hex ?? "").match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};
const parseRgb = (c) => {
    if (!c) return null;
    if (Array.isArray(c) && c.length >= 3) return [clampi(c[0], 0, 255), clampi(c[1], 0, 255), clampi(c[2], 0, 255)];
    const s = String(c).trim();
    const hex = s.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
    const rgb = s.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
    if (rgb) return [clampi(rgb[1], 0, 255), clampi(rgb[2], 0, 255), clampi(rgb[3], 0, 255)];
    return null;
};
const clampi = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

const MUSIC_EFFECT_MAP = {
    1: 3, // sunrex_Wave -> WAVE
    2: 2, // sunrex_Neon -> NEON
    3: 2, // sunrex_Rock -> NEON
    4: 1, // sunrex_Lightning -> BREATHING
    5: 1, // sunrex_Xlight -> BREATHING
    6: 1, // sunrex_Rain -> BREATHING
    7: 2, // sunrex_Digital -> NEON
    8: 3, // sunrex_Spectrum -> WAVE
};

const kbZonePalette = new Map();   // EC id-6 zone colors we last wrote (§13.28)
let kbFrameSig = null;             // last committed kb.set frame signature

/* one lighting entry → EC 16-B frame + STATIC zone palette (§13.16) */
async function applyLightingEntry(src) {
    if (!src || typeof src !== "object") return;
    const eff = String(src.effect ?? "").toUpperCase();
    let mode = KB_EFFECT_IDS[eff];
    if (mode === undefined) {
        if (eff === "SCREEN") {
            // Sunrex EC keyboard fallback (main.8ed9dc924c527068.js §1262266)
            mode = 2; // NEON
        } else if (eff === "MUSIC") {
            const musId = Number(src.music_effect ?? src.musicEffect ?? 1);
            mode = MUSIC_EFFECT_MAP[musId] ?? 3;
        } else {
            log(`lighting: effect "${eff}" unmapped → STATIC (mode 0)`);
            mode = 0;
        }
    }
    // EC rejects non-animated modes with speed≠0 (ack ok, no change — ledger
    // §13.20): STATIC(DIRECT) must write speed 0, animated keep the UI speed.
    const speed = mode === 0 ? 0 : clampi(src.speed ?? 3, 0, 9);
    // their UI scale 1..5 (BrightnessMin 1 = off) → EC 0/25/50/75/100
    // (AcerAgentService 0x140042df2..e57, §13.30); >5 = already a percent.
    const rawBri = Number(src.brightness ?? 5);
    const bri = !Number.isFinite(rawBri) ? 100
        : rawBri <= 5 ? clampi((rawBri - 1) * 25, 0, 100) : clampi(rawBri, 0, 100);
    const dirNum = typeof src.direction === "number"
        ? (src.direction | 0) : (KB_DIRS[String(src.direction ?? "").toUpperCase()] ?? 0);

    // RGB extraction: single-color animated modes (BREATHING 1, SHIFTING 4, METEOR 6,
    // TWINKLING 7) require the RGB bytes in the 16-B frame (bytes 5..7, §13.14.4).
    // If not supplied, the EC firmware defaults to 0,0,0 (blackness / no backlight).
    let rgb = parseRgb(src.color);
    if (!rgb && Array.isArray(src.LEDs)) {
        for (const led of src.LEDs) {
            const c = parseRgb(led?.color);
            if (c) { rgb = c; break; }
        }
    }
    if (!rgb) rgb = [0, 174, 199];   // default Predator cyan-teal #00aec7

    log(`lighting write: effect=${eff} mode=${mode} speed=${speed} bri=${bri} dir=${dirNum} rgb=${rgb.join(",")}`);
    if (mode === 0) {
        lightingEngine.stopEffect();
        // STATIC palette lives in the id-6 zone store (16-B RGB is not applied).
        // LEDs present → per-zone colors; else single picked color fills 4 zones.
        let zones = Array.isArray(src.LEDs) ? src.LEDs.slice(0, 4) : [];
        if (!zones.length && src.color && parseRgb(src.color)) {
            zones = [0, 1, 2, 3].map((i) => ({ LED_id: i, color: src.color }));
        }
        // zone-palette cache (§13.28): the EC holds per-zone colors; repaints
        // of an unchanged palette were 4 extra WMI evals (~1 s full-plate lag)
        // for zero visible change — their effects page re-sends the whole
        // LIGHTING object on every interaction. Only zones whose color actually
        // changes are written now. Limit (honest): an external EC writer can
        // desync this cache; the next payload diff then repains normally, and
        // the cache resets with this process.
        const wanted = {};
        for (const led of zones) {
            const c = parseRgb(led?.color);
            if (c) wanted[(led.LED_id ?? 0) | 0] = c;
        }
        let painted = false;
        for (const [sid, c] of Object.entries(wanted)) {
            const prev = kbZonePalette.get(Number(sid));
            if (prev && prev[0] === c[0] && prev[1] === c[1] && prev[2] === c[2]) continue;
            await daemonCall("kb.zone.set", { rgb: c, zones: String(Number(sid) + 1) });
            kbZonePalette.set(Number(sid), c);
            painted = true;
        }
        if (zones.length && !painted)
            log("zone palette unchanged — skipped (no WMI evals)");
        if (!zones.length) kbZonePalette.clear();
    } else {
        // Animated mode active: clear zone palette cache so returning to STATIC
        // always restores per-zone hardware colors.
        kbZonePalette.clear();
        // 4-zone hardware drops backlight with hardware method 20 animations.
        // Hand off animation to userspace Pulsar Dynamic Lighting Engine!
        lightingEngine.startEffect({
            effect: eff,
            speed,
            brightness: bri,
            direction: dirNum,
            color: rgb,
            music_effect: src.music_effect ?? src.musicEffect
        }, daemonCall);
        return;
    }
    // kb-frame cache (§13.28): re-sending the identical global frame (same
    // mode/speed/brightness/dir AND picked color — e.g. repeated fallback or no-op)
    // is a no-op on the EC; skip the eval entirely.
    const frameSig = `${mode}|${speed}|${bri}|${dirNum}|${rgb.join(",")}`;
    if (frameSig === kbFrameSig) {
        log(`kb frame unchanged — skipped: ${frameSig}`);
        return;
    }
    const r = await daemonCall("kb.set", { mode, speed, brightness: bri, dir: dirNum, rgb });
    if (r?.error) log("lighting kb.set error:", r.error);
    else kbFrameSig = frameSig;
}

async function applyLightingWrite(data) {
    if (!data || typeof data !== "object") return;
    if (data.GlobalEffect || Array.isArray(data.devices)) {
        // whole-profile model: vendor SwitchToProfileLightMode applies ONE
        // side — lighting.mode GLOBAL(0) → GlobalEffect, AREA(1) → devices.
        // Applying both let devices[0] (STATIC) clobber a Global effect.
        if (Number(data.mode ?? 0) === 1) {
            for (const d of data.devices ?? []) await applyLightingEntry(d);
        } else if (data.GlobalEffect) {
            await applyLightingEntry(data.GlobalEffect);
        }
        return;
    }
    if (data.effect) await applyLightingEntry(data);  // a single device entry payload
}

// ------------------------------------------------------------- appCenter XDG
/* Linux App Center: XDG .desktop entries mapped onto their Windows app-object
   contract (ledger §13.21): {id, name, display, linkTargetParsingPath, icon,
   appUsageInfo}. Pins/userApps persist as whole objects via KV. */
let _xdgCache = null;
let _xdgIcons = null;
const HOME = os.homedir();
const XDG_DIRS = [
    "/usr/share/applications", "/usr/local/share/applications",
    `${HOME}/.local/share/applications`,
    "/var/lib/snapd/desktop/applications",
    "/var/lib/flatpak/exports/share/applications",
    `${HOME}/.local/share/flatpak/exports/share/applications`,
];

function parseDesktopFile(p) {
    let name = "", exec = "", icon = "", hide = false, type = "";
    try {
        for (const line of fs.readFileSync(p, "utf8").split(/\n/)) {
            const t = line.trim();
            if (t.startsWith("[") && t !== "[Desktop Entry]") break;   // next section
            const k = t.match(/^([^=]+?)\s*= ?(.*)$/);
            if (!k) continue;
            const key = k[1];
            const val = k[2];
            if (key === "Name" && !name) name = val;
            else if (key.startsWith("Name[en")) name = val;    // en wins
            else if (key === "Exec") exec = val;
            else if (key === "Icon") icon = val;
            else if (key === "Type") type = val;
            else if (key === "NoDisplay" && /true/i.test(val)) hide = true;
            else if (key === "Hidden" && /true/i.test(val)) hide = true;
        }
    } catch { return null; }
    if (type !== "Application" || hide || !exec) return null;
    if (!name) name = p.split("/").pop().replace(/\.desktop$/, "");
    return { fid: p, name, icon };
}

function xdgApps() {
    if (_xdgCache && Date.now() - _xdgCache.t < 60000) return _xdgCache.a;
    const out = [];
    for (const d of XDG_DIRS) {
        let files = [];
        try { files = fs.readdirSync(d); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith(".desktop")) continue;
            const e = parseDesktopFile(path.join(d, f));
            if (!e) continue;
            const nm = e.name;
            out.push({
                id: f.replace(/\.desktop$/, ""),
                name: nm,
                display: nm,
                iconKey: e.icon ?? "",                   // desktop Icon= value
                linkTargetParsingPath: e.fid,          // path-like key (their .lnk)
                packageInstallPath: e.fid,             // their WSINFO scan touches this
                categories: [],
                appUsageInfo: usageInfoFor(nm),
            });
        }
    }
    // dedupe by id (user dir wins – parsing order: user dirs last)
    const seen = new Map();
    for (const a of out) if (!seen.has(a.id)) seen.set(a.id, a);
    const apps = [...seen.values()].sort((a, b) => a.display.localeCompare(b.display));
    _xdgCache = { t: Date.now(), a: apps };
    return apps;
}

function usageInfoFor(_nm) { return { usageCount: 0, lastInvoked: null }; }

/* icon resolver: Icon=name → hicolor/pixmaps lookup, base64 data-uri by ext */
function buildIconIndex() {
    const idx = [];
    const scan = (dir) => {
        try {
            for (const f of fs.readdirSync(dir)) {
                idx.push([f.replace(/\.(png|svg|svgz|xpm)$/i, "").toLowerCase(),
                path.join(dir, f), f]);
            }
        } catch { }
    };
    const themes = ["hicolor", "Adwaita", "AdwaitaLegacy"];
    const bases = ["/usr/share/icons", `${HOME}/.local/share/icons`, `${HOME}/.icons`,
        "/var/lib/flatpak/exports/share/icons",
        `${HOME}/.local/share/flatpak/exports/share/icons`];
    const sizes = ["scalable", "256x256", "128x128", "96x96", "64x64", "48x48", "32x32"];
    for (const b of bases) for (const t of themes) for (const s of sizes) {
        for (const cat of ["apps", "mimetypes"]) scan(path.join(b, t, s, cat));
    }
    scan("/usr/share/pixmaps");
    return idx;
}

function appIconUri(app) {
    if (!app) return null;
    const key = app.linkTargetParsingPath ?? app.id ?? "";
    if (!_xdgIcons) _xdgIcons = { t: 0, map: new Map(), idx: null };
    if (_xdgIcons.map.has(key)) return _xdgIcons.map.get(key);
    if (!_xdgIcons.idx) _xdgIcons.idx = buildIconIndex();
    const icon = app.iconKey ?? "";
    let file = null;
    if (icon.startsWith("/") || icon.startsWith("~")) {
        file = icon.replace(/^~/, HOME);
    } else if (icon) {
        const want = icon.toLowerCase();
        const hit = _xdgIcons.idx.find(([b]) => b === want);
        file = hit?.[1] ?? null;
    }
    let uri = null;
    try {
        if (file && fs.existsSync(file)) {
            const mime = /\.svgz?$/.test(file.toLowerCase()) ? "image/svg+xml" : "image/png";
            uri = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
        }
    } catch { }
    _xdgIcons.map.set(key, uri);
    return uri;
}

/* XDG launch: spawn the Exec detached (their LaunchApp(app) contract) */
function xdgLaunch(app) {
    try {
        const key = app?.linkTargetParsingPath ?? "";
        let exec = "";
        if (key && fs.existsSync(key)) {
            for (const line of fs.readFileSync(key, "utf8").split(/\n/)) {
                const m = line.match(/^Exec= ?(.*)$/);
                if (m) { exec = m[1]; break; }
            }
        }
        if (!exec) return { error: "app has no Exec" };
        const args = exec.split(/\s+/).filter((t) => t && !/^%[%fuUdDnNiIckKvVmM]$/.test(t)).join(" ");
        const { execFile } = require("child_process");
        const bin = args.split(/\s+/)[0];
        const rest = args.split(/\s+/).slice(1);
        const child = execFile(bin, rest, { detached: true, stdio: "ignore" });
        child.unref();
        log(`appCenter: launched ${bin}`);
        return null;
    } catch (e) {
        return { error: `launch failed: ${e.message}` };
    }
}

function activeLighting() {
    try {
        const s = loadScenario();
        return s.profiles?.[s.active]?.lighting
            ?? { mode: 0, GlobalEffect: GLOBAL_EFFECT(), devices: [KB_DEVICE()] };
    } catch {
        return { mode: 0, GlobalEffect: GLOBAL_EFFECT(), devices: [KB_DEVICE()] };
    }
}

/* one per-device lighting entry → profile-shaped store model (pure).
   device 0 = GLOBAL (scalars live on GlobalEffect), devices N≥1 merge by
   device id in devices[] (inserting with their deviceName when known). */
function mergeLightingEntry(data, storeVal = pssdkStore.get("LIGHTING")) {
    if (!data || typeof data !== "object") return storeVal ?? activeLighting();
    const dev = Number(data.device ?? 0);
    // a whole-model payload arrives pre-shaped ({GlobalEffect|devices})
    if (dev === 0 && (data.GlobalEffect || Array.isArray(data.devices))) return data;
    const base = (() => {
        const v = storeVal;
        if (v && typeof v === "object" && (v.GlobalEffect || Array.isArray(v.devices))) return v;
        const m = activeLighting();
        return { ...m, GlobalEffect: { ...(m.GlobalEffect ?? {}) }, devices: [...(m.devices ?? [])] };
    })();
    const entry = { ...data };
    if (dev === 0) {
        base.GlobalEffect = { device: 0, ...base.GlobalEffect, ...entry };
        base.mode = 0;                 // LIGHTING_MODE.GLOBAL (vendor setLightingLEDs)
    } else {
        const list = Array.isArray(base.devices) ? base.devices.slice() : [];
        let i = list.findIndex((d) => Number(d.device) === dev);
        if (i < 0) { i = list.length; list.push({ device: dev, deviceName: entry.deviceName ?? "AcerECKeyboard Device" }); }
        // their extractEffect drops LEDs on animated Area effects — keep the
        // stored zone palette instead of wiping it
        if (!Array.isArray(entry.LEDs)) delete entry.LEDs;
        list[i] = { ...list[i], ...entry };
        base.devices = list;
        base.mode = 1;                 // LIGHTING_MODE.AREA
    }
    return base;
}

/* their semantics: lighting edits persist into the active scenario profile —
   the page re-derives its selection from the profile after every apply, so a
   store without the profile update makes the selection revert ~1 s later. */
function persistLightingModel(base) {
    if (!base || typeof base !== "object" || !base.GlobalEffect) return;
    try {
        const s = loadScenario();
        const p = s?.profiles?.[s.active];
        if (p?.lighting) {
            p.lighting = base;
            saveScenario();   // re-seeds the store; setIfChanged is a no-op
        }
    } catch { }
}

// ------------------------------------------------------------- apply-on-write
async function applyPssdkWrite(key, data) {
    try {
        if (key === "OPERATING_MODE") {
            const p = MODE_TO_PROFILE[data];
            if (p) {
                await daemonCall("profile.set", { name: p });
                notifyModeChange(data);
            }
            return;
        }
        if (key === "FAN_CONTROL") {
            // their FAN_MODE enum (vendor bundle): Auto=0 Max=1 Custom=2
            const mode = data && data.mode;
            if (mode === 0) await daemonCall("fan.reset", {});
            else if (mode === 1) await daemonCall("fan.speed", { pct: 100 });
            else if (mode === 2 && Array.isArray(data.custom_fan_data)) {
                // custom payload (vendor DEFAULT_SCENARIO shape): per-fan
                // entries {fan_custom_auto, fan_custom_speed %, fan_index,
                // fan_name}; fan_index 0 = CPU fan (hwmon fan1), 1 = GPU fan
                // (hwmon fan2). auto=1 fans ride the firmware curve.
                const seen = new Set();
                for (const f of data.custom_fan_data) {
                    if (!f || !Number.isFinite(Number(f.fan_index))) continue;
                    const idx = Number(f.fan_index);
                    if (seen.has(idx)) continue;    // vendor ships dup-name entries; first per index wins
                    seen.add(idx);
                    const fan = idx === 1 ? "gpu" : "cpu";
                    const pct = Number(f.fan_custom_speed);
                    if (f.fan_custom_auto === 1) await daemonCall("fan.reset", { fan });
                    else if (Number.isFinite(pct))
                        await daemonCall("fan.speed", { pct: Math.max(0, Math.min(100, pct)), fan });
                }
                log("FAN_CONTROL custom applied:", JSON.stringify(data));
            } else log("FAN_CONTROL unsupported payload:", JSON.stringify(data));
            return;
        }
        if (key === "LIGHTING") return await applyLightingWrite(data);
        // remaining keys are UI-local booleans on this hardware
    } catch (e) { log("applyPssdkWrite failed", key, e.message); }
}

async function dispatch(module, fn, args) {
    try { if (process.env.PS_TRACE) log(`ddsc ${module}.${fn} ${JSON.stringify(args ?? []).slice(0, 180)}`); } catch { }
    // _events: dynamic topic names (ScenarioChanged, ...) observed by ddsc.broadcast
    if (module === "_events") { return null; }

    const mod = HANDLERS[module];
    if (!mod) { log(`ddsc shim: unhandled module "${module}.${fn}"`); return null; }
    const h = mod[fn];
    if (typeof h !== "function") {
        log(`ddsc shim: unhandled func "${module}.${fn}" args=${JSON.stringify(args ?? null).slice(0, 200)}`);
        return null;
    }
    return await h(args);
}

function shutdown() {
    try { lightingEngine.stopEffect(); } catch { }
}

process.on("exit", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { dispatch, setWindow, setBroadcaster, startPump, pssdkStore, shutdown, lightingEngine };
