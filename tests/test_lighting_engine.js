/**
 * Lighting engine (client-side SCREEN/MUSIC renderer) contract tests.
 *
 * Written BEFORE the .ts migration (P1 tests-first, feat/ts-migration):
 * these pin the exact behavior the .ts twin must reproduce byte-for-byte.
 * The module surface stays stable under the B-lite emit model: both this
 * suite and the backend suite require
 *   ../src/psense-electron/lighting-engine.js
 * which remains the only consumed filename (emitted from .ts in P1b).
 *
 * Pure color math gets golden-value tables; the zone write policy
 * (_applyZones) is exercised with a recording daemonCall copy so no
 * socket, screen capture or audio monitor is touched here.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const engine = require(path.join(__dirname, "..", "src", "psense-electron", "lighting-engine.js"));

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------------------- color math

test("hsvToRgb golden table (primary hues, exact boundaries)", () => {
    // saturation/value both 1; hue -> classic color wheel
    assert.deepStrictEqual(engine.hsvToRgb(0, 1, 1), [255, 0, 0]);       // red
    assert.deepStrictEqual(engine.hsvToRgb(60, 1, 1), [255, 255, 0]);   // yellow
    assert.deepStrictEqual(engine.hsvToRgb(120, 1, 1), [0, 255, 0]);    // green
    assert.deepStrictEqual(engine.hsvToRgb(180, 1, 1), [0, 255, 255]);  // cyan
    assert.deepStrictEqual(engine.hsvToRgb(240, 1, 1), [0, 0, 255]);    // blue
    assert.deepStrictEqual(engine.hsvToRgb(300, 1, 1), [255, 0, 255]);  // magenta
});

test("hsvToRgb normalizes hue wraps and negatives", () => {
    assert.deepStrictEqual(engine.hsvToRgb(360, 1, 1), [255, 0, 0]);
    assert.deepStrictEqual(engine.hsvToRgb(420, 1, 1), [255, 255, 0]);  // 420 % 360 = 60
    assert.deepStrictEqual(engine.hsvToRgb(-60, 1, 1), [255, 0, 255]);  // -60 -> 300 (magenta)
});

test("hsvToRgb neutral axis: saturation 0 collapses to gray value", () => {
    assert.deepStrictEqual(engine.hsvToRgb(197, 0, 0.5), [128, 128, 128]); // hue irrelevant, 127.5 rounds to 128
    assert.deepStrictEqual(engine.hsvToRgb(0, 1, 0), [0, 0, 0]);
});

test("hsvToRgb in-between hue arithmetic (30 deg, value scaling)", () => {
    assert.deepStrictEqual(engine.hsvToRgb(30, 1, 1), [255, 128, 0]);   // x = 0.5 -> 127.5 rounds 128
    assert.deepStrictEqual(engine.hsvToRgb(0, 1, 0.5), [128, 0, 0]);    // v scales, hue fixed
});

test("rgbToHsv round-trips through hsvToRgb on picked colors", () => {
    const samples = [
        [0, 255, 204],
        [0, 174, 199],
        [255, 128, 0],
        [128, 128, 128],
        [255, 0, 0],
        [12, 34, 56],
    ];
    for (const rgb of samples) {
        const [h, s, v] = engine.rgbToHsv(...rgb);
        const back = engine.hsvToRgb(h, s, v);
        for (let i = 0; i < 3; i++) {
            assert.ok(Math.abs(back[i] - rgb[i]) <= 4,
                `round-trip drift too large for ${rgb}: got ${back}`);
        }
    }
});

test("rgbToHsv: black saturates away hue, gray drops saturation", () => {
    const [bh, bs, bv] = engine.rgbToHsv(0, 0, 0);
    assert.strictEqual(bs, 0);
    assert.strictEqual(bv, 0);
    const [gh, gs, gv] = engine.rgbToHsv(90, 90, 90);
    assert.strictEqual(gs, 0);
    assert.strictEqual(gv, 90 / 255);
    assert.ok(gh >= 0);
});

test("clampRgb bounds each channel and falls back to the Acer default cyan", () => {
    assert.deepStrictEqual(engine.clampRgb([300, -10, 255]), [255, 0, 255]);
    assert.deepStrictEqual(engine.clampRgb([127.4, 10.6, 2]), [127, 11, 2]);   // rounds
    assert.deepStrictEqual(engine.clampRgb(["a", 25, 3]), [0, 25, 3]);         // NaN -> 0 (per-channel)
    assert.deepStrictEqual(engine.clampRgb(null), [0, 174, 199]);              // absent input -> default ON color
    assert.deepStrictEqual(engine.clampRgb("not-an-array"), [0, 174, 199]);
    assert.deepStrictEqual(engine.clampRgb([1, 2]), [0, 174, 199]);            // length < 3
});

test("scaleRgb multiplies and floors the factor at zero", () => {
    assert.deepStrictEqual(engine.scaleRgb([255, 0, 255], 0.5), [128, 0, 128]);
    assert.deepStrictEqual(engine.scaleRgb([200, 100, 0], -1), [0, 0, 0]);     // negative factor clamped to 0
    assert.deepStrictEqual(engine.scaleRgb([300, 0, 900], 1), [255, 0, 255]);  // per-channel 255 cap
});

test("lerpColor interpolates with clamped t", () => {
    assert.deepStrictEqual(engine.lerpColor([0, 0, 0], [255, 255, 255], 0.5), [128, 128, 128]);
    assert.deepStrictEqual(engine.lerpColor([0, 0, 0], [255, 255, 255], 2), [255, 255, 255]);  // t>1 clamped
    assert.deepStrictEqual(engine.lerpColor([10, 20, 30], [0, 0, 0], -1), [10, 20, 30]);        // t<0 clamped
    assert.deepStrictEqual(engine.lerpColor([0, 40, 40], [40, 40, 0], 0.25), [10, 40, 30]);
});

test("colorsEqual compares exactly; non-arrays are never equal", () => {
    assert.strictEqual(engine.colorsEqual([0, 174, 199], [0, 174, 199]), true);
    assert.strictEqual(engine.colorsEqual([0, 174, 199], [0, 174, 200]), false);
    assert.strictEqual(engine.colorsEqual(null, [0, 0, 0]), false);
    assert.strictEqual(engine.colorsEqual([0, 0, 0], undefined), false);
});

// ---------------------------------------------------------------- module shape

test("singleton export is an instance of the exported class", () => {
    assert.ok(engine.lightingEngine instanceof engine.LightingEngine);
    assert.strictEqual(typeof engine.LightingEngine, "function");
});

// ---------------------------------------------------------------- write policy

function makeRecorder() {
    const rec = { calls: [] };
    rec.daemonCall = async (op, args) => {
        rec.calls.push({ op, args });
        return { status: 0 };
    };
    return rec;
}

test("_applyZones collapses identical zones into a single 'all' write", async () => {
    const eng = new engine.LightingEngine();
    const rec = makeRecorder();
    const sid = eng.activeSessionId;

    eng.running = true;
    await eng._applyZones([[0, 174, 199], [0, 174, 199], [0, 174, 199], [0, 174, 199]], rec.daemonCall, sid);

    assert.strictEqual(rec.calls.length, 1);
    assert.strictEqual(rec.calls[0].op, "kb.zone.set");
    assert.deepStrictEqual(rec.calls[0].args, { rgb: [0, 174, 199], zones: "all" });
});

test("_applyZones dedups consecutive identical frames", async () => {
    const eng = new engine.LightingEngine();
    const rec = makeRecorder();
    const sid = eng.activeSessionId;
    eng.running = true;

    await eng._applyZones([[5, 5, 5], [5, 5, 5]], rec.daemonCall, sid);
    const afterFirst = rec.calls.length;
    assert.ok(afterFirst >= 1);
    await eng._applyZones([[5, 5, 5], [5, 5, 5]], rec.daemonCall, sid);
    assert.strictEqual(rec.calls.length, afterFirst, "identical frame must produce zero writes");

    // one changed zone -> exactly one targeted write
    await eng._applyZones([[5, 5, 5], [9, 9, 9]], rec.daemonCall, sid);
    assert.strictEqual(rec.calls.length, afterFirst + 1);
    assert.deepStrictEqual(rec.calls[rec.calls.length - 1].args, { rgb: [9, 9, 9], zones: "2" });
});

test("_applyZones drops frames when stopped or stale", async () => {
    const eng = new engine.LightingEngine();
    const rec = makeRecorder();

    eng.running = false;
    await eng._applyZones([[1, 2, 3], [4, 5, 6]], rec.daemonCall, 0);
    assert.strictEqual(rec.calls.length, 0, "stopped engine must not write");

    eng.running = true;
    await eng._applyZones([[1, 2, 3]], rec.daemonCall, eng.activeSessionId + 1);
    assert.strictEqual(rec.calls.length, 0, "stale session must not write");

    await eng._applyZones([], rec.daemonCall, eng.activeSessionId);
    assert.strictEqual(rec.calls.length, 0, "empty frame must not write");
});

test("_applyZones resets the cache when zone count changes", async () => {
    const eng = new engine.LightingEngine();
    const rec = makeRecorder();
    const sid = eng.activeSessionId;
    eng.running = true;

    await eng._applyZones([[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]], rec.daemonCall, sid);
    assert.strictEqual(rec.calls.length, 1);       // collapsed 'all'
    await eng._applyZones([[2, 2, 2], [2, 2, 2]], rec.daemonCall, sid);
    assert.strictEqual(rec.calls.length, 2);       // count change -> cache reset -> fresh write
    assert.deepStrictEqual(rec.calls[1].args, { rgb: [2, 2, 2], zones: "all" });
});

// ---------------------------------------------------------------- lifecycle

test("BREATHING loop streams zones through daemonCall and stops clean", async () => {
    const eng = new engine.LightingEngine();
    const rec = makeRecorder();

    // NOTE: config.color must be an RGB array here (backend parses hex
    // before calling the engine; the engine fallback is the default cyan)
    eng.startEffect(
        { effect: "BREATHING", color: [0, 255, 204], brightness: 100, speed: 1, zoneCount: 4 },
        rec.daemonCall,
    );
    try {
        assert.strictEqual(eng.running, true);
        await sleep(160);                          // ~3 frames at the 45 ms cadence
        assert.ok(rec.calls.length >= 2, `expected streamed frames, got ${rec.calls.length}`);
        for (const call of rec.calls) {
            assert.strictEqual(call.op, "kb.zone.set");
            assert.ok(Array.isArray(call.args.rgb) && call.args.rgb.length === 3);
            for (const ch of call.args.rgb) {
                assert.ok(Number.isInteger(ch) && ch >= 0 && ch <= 255,
                    `channel out of range: ${JSON.stringify(call.args.rgb)}`);
            }
            assert.match(String(call.args.zones), /all|[1-4]/);
        }
    } finally {
        eng.stopEffect();
    }
    assert.strictEqual(eng.running, false);
    assert.strictEqual(eng.activeProc, null);

    // after stop the loop must fully drain: no more writes ever
    const writesAfterStop = rec.calls.length;
    await sleep(180);
    assert.strictEqual(rec.calls.length, writesAfterStop, "writes continued after stopEffect");
});

test("stopEffect on a fresh engine is safe and idempotent", async () => {
    const eng = new engine.LightingEngine();
    eng.stopEffect();
    eng.stopEffect();
    assert.strictEqual(eng.running, false);
    assert.strictEqual(eng.activeProc, null);
    assert.strictEqual(eng.screenSampleTimer, null);
    assert.deepStrictEqual(eng.lastWrittenZones, []);
});
