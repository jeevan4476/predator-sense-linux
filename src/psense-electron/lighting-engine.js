/**
 * Userspace Pulsar Dynamic Lighting Engine for 4-Zone Keyboards
 *
 * Drives the 4 keyboard zones via daemonCall("kb.zone.set", { rgb: [r, g, b], zones: String(zoneIndex + 1) })
 * to avoid hardware method 20 blackouts on 4-zone laptops (e.g. Acer Predator PHN16-71).
 */

const { spawn } = require("child_process");

function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(1, s));
    v = Math.max(0, Math.min(1, v));
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r1 = 0, g1 = 0, b1 = 0;
    if (h < 60) { r1 = c; g1 = x; b1 = 0; }
    else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    return [
        Math.round((r1 + m) * 255),
        Math.round((g1 + m) * 255),
        Math.round((b1 + m) * 255)
    ];
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        else if (max === g) h = ((b - r) / d + 2) * 60;
        else h = ((r - g) / d + 4) * 60;
    }
    return [h, s, v];
}

function clampRgb(rgb) {
    if (!rgb || !Array.isArray(rgb) || rgb.length < 3) return [0, 174, 199];
    return [
        Math.max(0, Math.min(255, Math.round(Number(rgb[0]) || 0))),
        Math.max(0, Math.min(255, Math.round(Number(rgb[1]) || 0))),
        Math.max(0, Math.min(255, Math.round(Number(rgb[2]) || 0)))
    ];
}

function scaleRgb(rgb, factor) {
    factor = Math.max(0, factor);
    return [
        Math.max(0, Math.min(255, Math.round(rgb[0] * factor))),
        Math.max(0, Math.min(255, Math.round(rgb[1] * factor))),
        Math.max(0, Math.min(255, Math.round(rgb[2] * factor)))
    ];
}

function colorsEqual(c1, c2) {
    if (!c1 || !c2) return false;
    return c1[0] === c2[0] && c1[1] === c2[1] && c1[2] === c2[2];
}

function lerpColor(c1, c2, t) {
    t = Math.max(0, Math.min(1, t));
    return [
        Math.round(c1[0] + (c2[0] - c1[0]) * t),
        Math.round(c1[1] + (c2[1] - c1[1]) * t),
        Math.round(c1[2] + (c2[2] - c1[2]) * t)
    ];
}

class LightingEngine {
    constructor() {
        this.running = false;
        this.activeSessionId = 0;
        this.activeProc = null;
        this.lastWrittenZones = [null, null, null, null];
        this.currentConfig = null;
        this.screenSampleTimer = null;
        this.screenSampleColors = null;
        this.audioRms = 0;
        this.audioPeak = 0;
    }

    stopEffect() {
        this.running = false;
        this.activeSessionId++;
        if (this.activeProc) {
            try { this.activeProc.kill("SIGKILL"); } catch { }
            this.activeProc = null;
        }
        if (this.screenSampleTimer) {
            clearInterval(this.screenSampleTimer);
            this.screenSampleTimer = null;
        }
        this.screenSampleColors = null;
        this.audioRms = 0;
        this.audioPeak = 0;
        this.lastWrittenZones = [null, null, null, null];
    }

    async _applyZones(zones, daemonCall, sessionId) {
        if (!this.running || sessionId !== this.activeSessionId) return;
        const target = zones.map(clampRgb);

        const allIdentical = target.every(c => colorsEqual(c, target[0]));
        if (allIdentical) {
            const allAlreadyWritten = this.lastWrittenZones.every(c => colorsEqual(c, target[0]));
            if (!allAlreadyWritten) {
                await daemonCall("kb.zone.set", { rgb: target[0], zones: "all" });
                for (let i = 0; i < 4; i++) this.lastWrittenZones[i] = [...target[0]];
            }
        } else {
            for (let i = 0; i < 4; i++) {
                if (!this.running || sessionId !== this.activeSessionId) break;
                if (!colorsEqual(target[i], this.lastWrittenZones[i])) {
                    await daemonCall("kb.zone.set", { rgb: target[i], zones: String(i + 1) });
                    this.lastWrittenZones[i] = [...target[i]];
                }
            }
        }
    }

    async _runLoop(sessionId, daemonCall, updateFn) {
        let lastTime = Date.now();
        while (this.running && sessionId === this.activeSessionId) {
            const now = Date.now();
            const dt = Math.max(0.001, (now - lastTime) / 1000);
            lastTime = now;

            try {
                const nextZones = updateFn(dt, now);
                if (nextZones && Array.isArray(nextZones) && nextZones.length === 4) {
                    await this._applyZones(nextZones, daemonCall, sessionId);
                }
            } catch (err) {
                console.error("[lighting-engine] render frame error:", err.message);
            }

            const elapsed = Date.now() - now;
            const targetInterval = 45; // ~22 fps
            const delay = Math.max(10, targetInterval - elapsed);
            await new Promise(res => setTimeout(res, delay));
        }
    }

    _startAudioMonitor(sessionId) {
        try {
            const proc = spawn("parec", [
                "-d", "@DEFAULT_MONITOR@",
                "--format=s16le",
                "--rate=11025",
                "--channels=1"
            ], { stdio: ["ignore", "pipe", "ignore"] });

            this.activeProc = proc;
            proc.stdout.on("data", (chunk) => {
                if (!this.running || sessionId !== this.activeSessionId) return;
                let sumSquares = 0;
                let n = 0;
                for (let i = 0; i < chunk.length - 1; i += 2) {
                    const sample = chunk.readInt16LE(i);
                    sumSquares += sample * sample;
                    n++;
                }
                if (n > 0) {
                    const rawRms = Math.sqrt(sumSquares / n) / 32768.0;
                    const normalized = Math.min(1.0, rawRms * 5.0);
                    this.audioRms = this.audioRms * 0.6 + normalized * 0.4;
                    if (normalized > this.audioPeak) this.audioPeak = normalized;
                    else this.audioPeak = Math.max(0, this.audioPeak - 0.05);
                }
            });

            proc.on("error", (e) => {
                console.warn("[lighting-engine] parec monitor not available:", e.message);
                this.activeProc = null;
            });
            proc.on("exit", () => {
                if (this.activeProc === proc) this.activeProc = null;
            });
        } catch (e) {
            console.warn("[lighting-engine] Failed to start parec:", e.message);
        }
    }

    _startScreenSampler(sessionId) {
        const sampleOnce = () => {
            if (!this.running || sessionId !== this.activeSessionId) return;
            try {
                const proc = spawn("ffmpeg", [
                    "-loglevel", "quiet",
                    "-f", "x11grab",
                    "-i", ":0.0",
                    "-vf", "scale=4:1",
                    "-vframes", "1",
                    "-f", "rawvideo",
                    "-pix_fmt", "rgb24",
                    "-"
                ], { stdio: ["ignore", "pipe", "ignore"] });

                const chunks = [];
                proc.stdout.on("data", d => chunks.push(d));
                proc.on("close", (code) => {
                    if (code === 0) {
                        const buf = Buffer.concat(chunks);
                        if (buf.length >= 12) {
                            this.screenSampleColors = [
                                [buf[0], buf[1], buf[2]],
                                [buf[3], buf[4], buf[5]],
                                [buf[6], buf[7], buf[8]],
                                [buf[9], buf[10], buf[11]]
                            ];
                        }
                    }
                });
            } catch { }
        };

        sampleOnce();
        this.screenSampleTimer = setInterval(sampleOnce, 220);
    }

    startEffect(config, daemonCall) {
        this.stopEffect();
        this.running = true;
        const sessionId = ++this.activeSessionId;
        this.currentConfig = { ...config };

        const eff = String(config.effect || "").toUpperCase();
        const baseColor = clampRgb(config.color);
        const briScale = Math.max(0, Math.min(1, (config.brightness ?? 100) / 100));
        const speed = Math.max(1, Math.min(9, Number(config.speed) || 3));
        const dir = Number(config.direction) === 2 ? 2 : 1; // 1 = RIGHT, 2 = LEFT

        switch (eff) {
            case "BREATHING": {
                let phase = 0;
                const freq = 0.8 + (speed - 1) * 0.4;
                this._runLoop(sessionId, daemonCall, (dt) => {
                    phase += dt * freq * Math.PI;
                    const factor = 0.2 + 0.8 * (0.5 * (1 + Math.sin(phase)));
                    const c = scaleRgb(baseColor, factor * briScale);
                    return [c, c, c, c];
                });
                break;
            }

            case "WAVE": {
                let baseHue = 0;
                const hueSpeed = 45 + speed * 25; // deg/sec
                this._runLoop(sessionId, daemonCall, (dt) => {
                    baseHue = (baseHue + (dir === 2 ? -1 : 1) * hueSpeed * dt + 360000) % 360;
                    const zones = [];
                    for (let i = 0; i < 4; i++) {
                        const offset = (dir === 2 ? -i : i) * 60;
                        const hue = (baseHue + offset + 360000) % 360;
                        zones.push(hsvToRgb(hue, 1.0, briScale));
                    }
                    return zones;
                });
                break;
            }

            case "SHIFTING": {
                const [userHue, userSat] = rgbToHsv(baseColor[0], baseColor[1], baseColor[2]);
                const sat = userSat < 0.1 ? 0.9 : userSat;
                let shiftPhase = 0;
                const shiftSpeed = 25 + speed * 20; // deg/sec
                this._runLoop(sessionId, daemonCall, (dt) => {
                    shiftPhase = (shiftPhase + (dir === 2 ? -1 : 1) * shiftSpeed * dt + 360000) % 360;
                    const zones = [];
                    for (let i = 0; i < 4; i++) {
                        const zoneOffset = (dir === 2 ? -i : i) * 35;
                        const h = (userHue + shiftPhase + zoneOffset + 360000) % 360;
                        zones.push(hsvToRgb(h, sat, briScale));
                    }
                    return zones;
                });
                break;
            }

            case "METEOR": {
                // Streak travels across zone 0 -> 1 -> 2 -> 3 (or 3 -> 0)
                let pos = dir === 2 ? 4.0 : -1.0;
                const meteorSpeed = 1.6 + speed * 0.9; // zones/sec
                this._runLoop(sessionId, daemonCall, (dt) => {
                    if (dir === 2) {
                        pos -= meteorSpeed * dt;
                        if (pos < -2.0) pos = 4.0;
                    } else {
                        pos += meteorSpeed * dt;
                        if (pos > 5.0) pos = -1.0;
                    }

                    const zones = [];
                    const ambient = 0.08;
                    for (let i = 0; i < 4; i++) {
                        const dist = dir === 2 ? (i - pos) : (pos - i);
                        let trail = 0;
                        if (dist >= 0 && dist < 2.5) {
                            trail = Math.exp(-dist * 1.6);
                        } else if (dist < 0 && dist > -0.5) {
                            trail = (1 + dist / 0.5) * 0.25;
                        }
                        const intensity = Math.min(1.0, ambient + trail * (1.0 - ambient));
                        zones.push(scaleRgb(baseColor, intensity * briScale));
                    }
                    return zones;
                });
                break;
            }

            case "TWINKLING": {
                const ambient = 0.18;
                const glints = [0, 0, 0, 0];
                this._runLoop(sessionId, daemonCall, (dt) => {
                    for (let i = 0; i < 4; i++) {
                        if (glints[i] > 0) {
                            glints[i] = Math.max(0, glints[i] - dt * (1.2 + speed * 0.3));
                        } else if (Math.random() < (0.04 + speed * 0.02)) {
                            glints[i] = 1.0;
                        }
                    }
                    const zones = [];
                    for (let i = 0; i < 4; i++) {
                        const intensity = ambient + (1.0 - ambient) * glints[i];
                        let c = scaleRgb(baseColor, intensity * briScale);
                        if (glints[i] > 0.4) {
                            const whiteBlend = ((glints[i] - 0.4) / 0.6) * 0.5;
                            c = lerpColor(c, [255, 255, 255], whiteBlend);
                        }
                        zones.push(c);
                    }
                    return zones;
                });
                break;
            }

            case "SCREEN": {
                this._startScreenSampler(sessionId);
                let currentZones = [baseColor, baseColor, baseColor, baseColor];
                let fallbackPhase = 0;
                this._runLoop(sessionId, daemonCall, (dt) => {
                    fallbackPhase = (fallbackPhase + dt * 60) % 360;
                    let targetZones = this.screenSampleColors;
                    if (!targetZones) {
                        // Smooth gradient fallback if display capture is inaccessible
                        targetZones = [
                            hsvToRgb(fallbackPhase, 0.8, 1.0),
                            hsvToRgb((fallbackPhase + 60) % 360, 0.8, 1.0),
                            hsvToRgb((fallbackPhase + 120) % 360, 0.8, 1.0),
                            hsvToRgb((fallbackPhase + 180) % 360, 0.8, 1.0)
                        ];
                    }
                    currentZones = currentZones.map((c, i) =>
                        lerpColor(c, scaleRgb(targetZones[i], briScale), 0.35)
                    );
                    return currentZones;
                });
                break;
            }

            case "MUSIC": {
                this._startAudioMonitor(sessionId);
                let simBeat = 0;
                let wavePhase = 0;
                const musicStyle = Number(config.music_effect || 1);
                this._runLoop(sessionId, daemonCall, (dt) => {
                    wavePhase = (wavePhase + dt * (60 + speed * 30)) % 360;
                    // Audio monitor value with fallback subtle beat generator if audio is silent
                    simBeat = (simBeat + dt * 2.5) % (2 * Math.PI);
                    const fallbackAmp = 0.15 + 0.1 * Math.pow(Math.max(0, Math.sin(simBeat)), 4);
                    const amp = Math.max(this.audioRms, fallbackAmp);

                    const zones = [];
                    if (musicStyle === 1 || musicStyle === 8) {
                        // Rainbow spectrum wave scaled by music amplitude
                        for (let i = 0; i < 4; i++) {
                            const h = (wavePhase + i * 60) % 360;
                            const zoneFactor = Math.min(1.0, (0.2 + 0.8 * amp));
                            zones.push(hsvToRgb(h, 1.0, zoneFactor * briScale));
                        }
                    } else if (musicStyle === 2 || musicStyle === 7) {
                        // Dynamic hue shift: calm teal shifts to amber/red on heavy beats
                        const dynamicHue = (180 - amp * 160 + 360) % 360;
                        const factor = Math.min(1.0, 0.25 + 0.75 * amp);
                        const c = hsvToRgb(dynamicHue, 1.0, factor * briScale);
                        return [c, c, c, c];
                    } else {
                        // Center-out visualizer beat bounce
                        const centerAmp = Math.min(1.0, 0.2 + 0.8 * amp);
                        const outerAmp = Math.min(1.0, 0.15 + 0.65 * this.audioPeak);
                        const centerColor = scaleRgb(baseColor, centerAmp * briScale);
                        const outerColor = scaleRgb(baseColor, outerAmp * briScale);
                        return [outerColor, centerColor, centerColor, outerColor];
                    }
                    return zones;
                });
                break;
            }

            default: {
                // Default fallback: gentle breathing
                let phase = 0;
                this._runLoop(sessionId, daemonCall, (dt) => {
                    phase += dt * Math.PI;
                    const factor = 0.2 + 0.8 * (0.5 * (1 + Math.sin(phase)));
                    const c = scaleRgb(baseColor, factor * briScale);
                    return [c, c, c, c];
                });
                break;
            }
        }
    }
}

const lightingEngine = new LightingEngine();

module.exports = {
    LightingEngine,
    lightingEngine,
    hsvToRgb,
    rgbToHsv,
    scaleRgb,
    clampRgb,
    colorsEqual
};
