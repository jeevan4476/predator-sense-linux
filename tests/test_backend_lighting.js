/**
 * Tests for Backend Bridge Lighting Integration (Task 3)
 *
 * Verifies that applyLightingEntry delegates mathematical dynamic effects
 * (WAVE, BREATHING, SHIFTING, METEOR, TWINKLING, RAINBOW, NEON) to psensed via kb.effect.set,
 * delegates sensory effects (SCREEN, MUSIC) to the client lighting-engine,
 * and handles STATIC (mode 0) by stopping both engines and applying zone colors.
 */

const assert = require("assert");

// CI (and any machine without electron installed) can't resolve the real
// electron module; backend.js only needs app/screen/Notification symbols at
// load time, so hand it inert stubs.
const Module = require("node:module");
const origLoad = Module._load;
Module._load = function (request) {
    if (request === "electron")
        return { app: {}, screen: {}, Notification: {} };
    return origLoad.apply(this, arguments);
};

const {
    applyLightingEntry,
    applyLightingWrite,
    setDaemonCallOverride,
    lightingEngine,
    shutdown
} = require("../src/psense-electron/backend");

async function runTests() {
    console.log("Running backend lighting tests...");

    const daemonCalls = [];
    setDaemonCallOverride(async (op, args) => {
        daemonCalls.push({ op, args });
        return { status: 0 };
    });

    // Test 1: Mathematical effects delegate to psensed (kb.effect.set)
    const mathEffects = ["WAVE", "BREATHING", "SHIFTING", "METEOR", "TWINKLING", "RAINBOW", "NEON"];
    for (const eff of mathEffects) {
        daemonCalls.length = 0;
        let stopEffectCalled = false;
        const origStopEffect = lightingEngine.stopEffect;
        lightingEngine.stopEffect = () => {
            stopEffectCalled = true;
            origStopEffect.call(lightingEngine);
        };

        try {
            await applyLightingEntry({
                effect: eff,
                speed: 4,
                brightness: 80,
                direction: 2,
                color: "#00ffcc",
                LEDs: [{ color: "#00ffcc" }, { color: "#00ffcc" }, { color: "#00ffcc" }, { color: "#00ffcc" }]
            });

            assert.strictEqual(stopEffectCalled, true, `${eff} must call lightingEngine.stopEffect()`);
            assert.strictEqual(daemonCalls.length, 1, `${eff} should make exactly 1 daemon call`);
            assert.strictEqual(daemonCalls[0].op, "kb.effect.set", `${eff} must call kb.effect.set`);
            assert.strictEqual(daemonCalls[0].args.effect, eff);
            assert.strictEqual(daemonCalls[0].args.speed, 4);
            assert.strictEqual(daemonCalls[0].args.brightness, 80);
            assert.strictEqual(daemonCalls[0].args.direction, 2);
            assert.deepStrictEqual(daemonCalls[0].args.rgb, [0, 255, 204]);
            assert.strictEqual(daemonCalls[0].args.zoneCount, 4);
            assert.strictEqual(daemonCalls[0].args.zone_count, 4);
            // Must NOT have written method 20 kb.set
            assert.ok(!daemonCalls.some(c => c.op === "kb.set"), `${eff} must not write method 20 kb.set`);
            console.log(`  ok ${eff} delegated to daemon kb.effect.set`);
        } finally {
            lightingEngine.stopEffect = origStopEffect;
        }
    }

    // Test 2: STATIC effect (mode 0) stops both client and daemon effects, sets zone colors
    {
        daemonCalls.length = 0;
        let stopEffectCalled = false;
        const origStopEffect = lightingEngine.stopEffect;
        lightingEngine.stopEffect = () => {
            stopEffectCalled = true;
            origStopEffect.call(lightingEngine);
        };

        try {
            await applyLightingEntry({
                effect: "STATIC",
                speed: 0,
                brightness: 100,
                color: "#ff0000",
                LEDs: [
                    { LED_id: 0, color: "#ff0000" },
                    { LED_id: 1, color: "#00ff00" },
                    { LED_id: 2, color: "#0000ff" },
                    { LED_id: 3, color: "#ffffff" }
                ]
            });

            assert.strictEqual(stopEffectCalled, true, "STATIC must stop client lightingEngine");
            const stopCall = daemonCalls.find(c => c.op === "kb.effect.stop");
            assert.ok(stopCall, "STATIC must call daemon kb.effect.stop");

            const zoneCalls = daemonCalls.filter(c => c.op === "kb.zone.set");
            assert.strictEqual(zoneCalls.length, 4, "STATIC should write 4 individual zones");
            assert.deepStrictEqual(zoneCalls[0].args, { rgb: [255, 0, 0], zones: "1" });
            assert.deepStrictEqual(zoneCalls[1].args, { rgb: [0, 255, 0], zones: "2" });
            assert.deepStrictEqual(zoneCalls[2].args, { rgb: [0, 0, 255], zones: "3" });
            assert.deepStrictEqual(zoneCalls[3].args, { rgb: [255, 255, 255], zones: "4" });
            console.log("  ok STATIC stopped effects and set zone colors");
        } finally {
            lightingEngine.stopEffect = origStopEffect;
        }
    }

    // Test 3: SCREEN and MUSIC sensory effects run on client side and stop daemon effect
    {
        for (const eff of ["SCREEN", "MUSIC"]) {
            daemonCalls.length = 0;
            let startEffectConfig = null;
            const origStartEffect = lightingEngine.startEffect;
            lightingEngine.startEffect = (config) => {
                startEffectConfig = config;
            };

            try {
                await applyLightingEntry({
                    effect: eff,
                    speed: 3,
                    brightness: 75,
                    direction: 1,
                    color: "#00aaff",
                    music_effect: 2,
                    LEDs: [{}, {}, {}, {}]
                });

                const stopCall = daemonCalls.find(c => c.op === "kb.effect.stop");
                assert.ok(stopCall, `${eff} must stop background daemon effect`);
                assert.ok(startEffectConfig, `${eff} must call lightingEngine.startEffect`);
                assert.strictEqual(startEffectConfig.effect, eff);
                assert.strictEqual(startEffectConfig.speed, 3);
                assert.strictEqual(startEffectConfig.brightness, 75);
                assert.strictEqual(startEffectConfig.direction, 1);
                assert.deepStrictEqual(startEffectConfig.color, [0, 170, 255]);
                if (eff === "MUSIC") {
                    assert.strictEqual(startEffectConfig.music_effect, 2);
                }
                console.log(`  ok ${eff} stopped daemon and started client lightingEngine`);
            } finally {
                lightingEngine.startEffect = origStartEffect;
                lightingEngine.stopEffect();
            }
        }
    }

    // Test 4: Profile lighting write wrapper (applyLightingWrite)
    {
        daemonCalls.length = 0;
        await applyLightingWrite({
            mode: 0,
            GlobalEffect: {
                effect: "BREATHING",
                speed: 5,
                brightness: 100,
                color: "#123456"
            }
        });
        assert.strictEqual(daemonCalls.length, 1);
        assert.strictEqual(daemonCalls[0].op, "kb.effect.set");
        assert.strictEqual(daemonCalls[0].args.effect, "BREATHING");
        assert.deepStrictEqual(daemonCalls[0].args.rgb, [18, 52, 86]);
        console.log("  ok applyLightingWrite routed GlobalEffect correctly");
    }

    // Test 5: Shutdown hook cleans client-side resources without calling daemon kb.effect.stop
    {
        daemonCalls.length = 0;
        let clientStopCalled = false;
        const origStopEffect = lightingEngine.stopEffect;
        lightingEngine.stopEffect = () => {
            clientStopCalled = true;
            origStopEffect.call(lightingEngine);
        };

        try {
            shutdown();
            assert.strictEqual(clientStopCalled, true, "shutdown() must call lightingEngine.stopEffect()");
            assert.strictEqual(daemonCalls.length, 0, "shutdown() must NOT call daemon kb.effect.stop so effects persist");
            console.log("  ok shutdown() preserves background daemon dynamic lighting");
        } finally {
            lightingEngine.stopEffect = origStopEffect;
        }
    }

    console.log("\nAll backend lighting tests PASSED!");
}

runTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
