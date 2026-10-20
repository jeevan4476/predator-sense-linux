/**
 * psensed daemon protocol client (typed) — P3 core of the B-lite TS port.
 *
 * Normative source: spec/daemon-protocol.md. This module is byte-faithful
 * to the working client in backend.js (daemonCall/daemonCallOnce); the
 * full backend.ts port adopts it as the canonical socket boundary.
 * Its transport invariants are the ones the Rust daemon must satisfy
 * (one request per connection, newline-JSON framing, 6 s default client
 * timeout, "wmi busy:" retry contract with 250 ms sleep).
 *
 * Transport rules mirrored here (section references = spec):
 *  T3 one request per connection, newline terminated both ways
 *  T4 reply read terminated by "\n" (client side: buf.endsWith)
 *  T6/T-bad malformed reply -> null (transport unavailability encoding)
 *  §2.1 presence of `error` key = failure; extra keys advisory
 *  §3   "wmi busy:" prefix is a byte-locked contract (regex ^wmi busy:/i)
 */

import type { Socket } from "net";

export const DEFAULT_DAEMON_SOCKET = "/run/psense.sock";

/** All ops the GUI backend currently dispatches + reserved internal. */
export type DaemonOp =
    | "battmode.get" | "battmode.set"
    | "fan.get" | "fan.reset" | "fan.speed"
    | "kb.effect.set" | "kb.effect.stop" | "kb.set" | "kb.zone.set"
    | "profile.get" | "profile.set"
    | "switchkey.get" | "switchkey.set"
    | "usbcharge.set" | "usbcharge.get"
    /** escape hatch for ops later phases adopt (CLI-only ops etc.) */
    | (string & { __daemonOpBrand?: never });

/** Flat daemon request: op + sibling args (spec section 2 — never nested). */
export type DaemonRequest = { op: DaemonOp } & Record<string, unknown>;

/** section 2.1: presence of key `error` (any value) = failure. */
export interface DaemonError {
    error: string;
    [key: string]: unknown;
}

export type DaemonReply = Record<string, unknown>;

/** Payload types for the GUI-facing ops (spec section 7). */
export interface SensorsReply {
    fans_rpm: { cpu: string | null; gpu: string | null };
    temps: Record<string, string>;
    stale: boolean;
    fresh: boolean;
}
export interface FanGetReply {
    rpm_cpu: string;
    rpm_gpu: string;
    pwm_available: boolean;
    curves: Record<string, unknown>;
    fan1: { pwm: string; mode: string; rpm: string };
    fan2: { pwm: string; mode: string; rpm: string };
}
export interface ProfileGetReply { profile: string; choices: string[]; }
export interface ProfileSetReply { profile: string; gpu_oc?: unknown; }
export interface KbSetReply { status: number; ack: string; frame: string; }
export interface KbZoneSetReply {
    zones: string[];
    applied: Array<{ zone_bit: number; status: number }>;
    skipped?: string;
}
export interface KbEffectSetReply {
    status: number;
    effect: Record<string, unknown>;
}
export interface SwitchkeyGetReply { mode: number; }
export interface SwitchkeySetReply { status: number; mode: number; }
export interface BattmodeSetReply {
    status: number;
    raw?: string;
    committed?: boolean;
    [key: string]: unknown;
}
export interface UsbchargeGetReply { status: number; raw?: string; [key: string]: unknown; }
export interface MemoryReply {
    dimms: unknown;
    total_mb: number;
    type: string;
    frequency: string;
    speed_max: unknown;
    [key: string]: unknown;
}
export interface HealthReply {
    battery: Record<string, unknown>;
    disks: Array<Record<string, unknown>>;
    ram: { health: number };
}
export interface GpuOcReply { supported: unknown; [key: string]: unknown; }

/** Wire line builders (newline-JSON, T3). */
export function encodeRequest(req: DaemonRequest): string {
    return `${JSON.stringify(req)}\n`;
}

/** Buffered text -> reply object or null on parse failure (T-bad). */
export function parseReply(buf: string): DaemonReply | null {
    if (!buf.endsWith("\n")) return null;
    try { return JSON.parse(buf) as DaemonReply; } catch { return null; }
}

/** section 2.1 portable discriminator: error key presence (any value). */
export function isDaemonError(reply: unknown): reply is DaemonError {
    return !!reply && typeof reply === "object" && "error" in reply;
}

/** section 3 byte-locked busy prefix (regex ^wmi busy:/i). */
export const WMI_BUSY_PATTERN = /^wmi busy:/i;

export function isBusyError(reply: unknown): reply is DaemonError {
    return isDaemonError(reply) && typeof reply.error === "string"
        && WMI_BUSY_PATTERN.test(reply.error);
}

export interface DaemonCallOnce {
    (op: DaemonOp, args: Record<string, unknown>, timeout?: number): Promise<DaemonReply | null>;
}

export interface DaemonCallFn {
    (op: DaemonOp, args: Record<string, unknown>, timeout?: number): Promise<DaemonReply | null>;
}

/** One request, one connection, one reply (T3). Mirrors backend.js
 * `daemonCallOnce`: null on timeout/error/malformed; timeout is the
 * per-connection SOCKET inactivity timer, not a total deadline. */
export function createDaemonCallOnce(socketPath: string = DEFAULT_DAEMON_SOCKET): DaemonCallOnce {
    return (op, args, timeout = 6000) => new Promise((resolve) => {
        const s = netCreateConnection(socketPath);
        let buf = "";
        s.setEncoding("utf8");
        s.setTimeout(timeout);
        s.on("connect", () => s.write(encodeRequest({ op, ...args })));
        s.on("data", (d: string) => {
            buf += d;
            if (buf.endsWith("\n")) {
                s.end();
                resolve(parseReply(buf));
            }
        });
        s.on("timeout", () => { s.destroy(); resolve(null); });
        s.on("error", () => resolve(null));
    });
}

/** net.createConnection extracted for testability (house the import at
 * the boundary so a test can swap transports if ever needed). */
function netCreateConnection(path: string): Socket {
    // lazy require keeps this module electron-test agnostic (no import of
    // 'net' at top level in emitted CJS either)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const netMod = require("net") as typeof import("net");
    return netMod.createConnection(path);
}

/** The full retry client: mirrors backend.js `daemonCall` including the
 * deadline arithmetic (min 1000 ms per attempt, 250 ms busy sleep,
 * guarded so a busy retry cannot outlive the deadline). */
export function createDaemonCall(
    socketPath: string = DEFAULT_DAEMON_SOCKET,
    override?: DaemonCallFn | null,
): DaemonCallFn {
    const once = createDaemonCallOnce(socketPath);
    return async function daemonCall(op, args, timeout = 6000) {
        if (override) return await override(op, args, timeout);
        const deadline = Date.now() + timeout;
        for (;;) {
            const rem = Math.max(1000, deadline - Date.now());
            const r = await once(op, args, rem);
            if (isBusyError(r) && Date.now() + 250 < deadline) {
                await sleep(250);
                continue;
            }
            return r;
        }
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}
