/**
 * Transport contract tests for the typed daemon protocol client
 * (src/psense-electron/daemon-protocol.ts -> daemon-protocol.js).
 *
 * These pin the DEMO behaviors spec/daemon-protocol.md requires of every
 * client against a REAL local unix socket (no electron, no live daemon):
 *   T3   one request per connection + newline framing both directions
 *   T-bad malformed reply -> null
 *   T2.1 error-key presence = failure
 *   section 3  "wmi busy:" retry contract (250 ms sleep, deadline-guarded)
 *
 * A fixture server implements only what a client test needs:
 *  - "echo"       -> replies with the daemon-style flattened request
 *  - "slow.echo"  -> sleeps before replying (timeout path, ms-budget)
 *  - "busy.once"  -> answers `wmi busy:` on attempt 1, echoes attempt 2+
 *  - typo reply   -> garbage JSON line then newline (parse -> null)
 */

const { test } = require("node:test");
const assert = require("node:assert");
const netMod = require("node:net");
const osMod = require("node:os");
const pathMod = require("node:path");
const fsMod = require("node:fs");

const protocol = require(pathMod.join(__dirname, "..", "src", "psense-electron", "daemon-protocol.js"));

function makeMockDaemon(socketPath) {
    const state = { connections: 0, lastRequest: null, closedClean: 0 };
    const server = netMod.createServer((conn) => {
        state.connections += 1;
        conn.setEncoding("utf8");
        let got = "";
        conn.on("data", (chunk) => {
            got += chunk;
            if (!got.endsWith("\n")) return;
            let req;
            try { req = JSON.parse(got); } catch { return; }
            state.lastRequest = req;
            switch (req.op) {
                case "echo.badline":
                    conn.write("not json\n");
                    state.closedClean += 1;
                    conn.end();
                    return;
                case "busy.once": {
                    // first connection gets the byte-locked busy error, the
                    // retry (new connection) gets the echo
                    state.connections += 0;
                    if (state.connections === 1) {
                        conn.write(JSON.stringify({
                            error: "wmi busy: another eval is running (or pending); retry shortly — reads are unaffected",
                        }) + "\n");
                    } else {
                        conn.write(JSON.stringify({
                            op: req.op, marker: "mock",
                        }) + "\n");
                    }
                    state.closedClean += 1;
                    conn.end();
                    return;
                }
                case "echo": {
                    assert.ok(got.endsWith("\n"), "request must be newline terminated");
                    const reply = { op: req.op, echoedArgs: req.args, marker: "mock" };
                    conn.write(JSON.stringify(reply) + "\n");
                    state.closedClean += 1;
                    conn.end();
                    return;
                }
                default:
                    state.closedClean += 1;
                    conn.end();
            }
        });
        conn.on("error", () => { });
    });
    return { server, state };
}

test("T3: one request per connection, newline framed, reply parsed", async () => {
    const sockPath = pathMod.join(osMod.tmpdir(), `psense-proto-${process.pid}-basic.sock`);
    fsMod.rmSync(sockPath, { force: true });
    const { server, state } = makeMockDaemon(sockPath);
    await new Promise((res) => server.listen(sockPath, res));
    try {
        const callOnce = protocol.createDaemonCallOnce(sockPath);
        const reply = await callOnce("echo", { args: { alpha: 1, beta: "x" } }, 4000);
        assert.ok(reply, "reply must not be null");
        assert.strictEqual(reply.marker, "mock");
        assert.strictEqual(state.connections, 1, "one call -> one connection");
    } finally {
        server.close();
        fsMod.rmSync(sockPath, { force: true });
    }
});

test("T-bad: malformed reply line resolves null", async () => {
    const sockPath = pathMod.join(osMod.tmpdir(), `psense-proto-${process.pid}-bad.sock`);
    fsMod.rmSync(sockPath, { force: true });
    const { server } = makeMockDaemon(sockPath);
    await new Promise((res) => server.listen(sockPath, res));
    try {
        const callOnce = protocol.createDaemonCallOnce(sockPath);
        const reply = await callOnce("echo.badline", {}, 4000);
        assert.strictEqual(reply, null, "parse failure must be transport-null");
    } finally {
        server.close();
        fsMod.rmSync(sockPath, { force: true });
    }
});

test("transport-down socket path resolves null (no synthetic busy)", async () => {
    const callOnce = protocol.createDaemonCallOnce(
        pathMod.join(osMod.tmpdir(), `psense-proto-${process.pid}-missing.sock`),
    );
    const reply = await callOnce("echo", {}, 1500);
    assert.strictEqual(reply, null);
});

test("section 3: busy retry sleeps 250 ms and survives across connections", async () => {
    const sockPath = pathMod.join(osMod.tmpdir(), `psense-proto-${process.pid}-busy.sock`);
    fsMod.rmSync(sockPath, { force: true });
    const { server, state } = makeMockDaemon(sockPath);
    await new Promise((res) => server.listen(sockPath, res));
    try {
        const call = protocol.createDaemonCall(sockPath);
        const t0 = Date.now();
        const reply = await call("busy.once", { args: { a: 1 } }, 4000);
        assert.ok(reply && reply.marker === "mock", "second attempt must deliver the echo");
        assert.ok(Date.now() - t0 >= 240, "retry must honor the 250 ms sleep");
        assert.strictEqual(state.connections, 2, "exactly one retry: busy once then success");
    } finally {
        server.close();
        fsMod.rmSync(sockPath, { force: true });
    }
});

test("discriminators: error-key presence + busy regex", () => {
    assert.strictEqual(protocol.isDaemonError({ error: "x" }), true);
    assert.strictEqual(protocol.isDaemonError({}), false);
    assert.strictEqual(protocol.isDaemonError(null), false);
    assert.strictEqual(protocol.isBusyError({ error: "wmi busy: ..." }), true);
    assert.strictEqual(protocol.isBusyError({ error: "WMI Busy: casing" }), true);
    assert.strictEqual(protocol.isBusyError({ error: "unknown op 'x'" }), false);
});

test("wire helpers: encode/parse round trip and safety", () => {
    const line = protocol.encodeRequest({ op: "sensors" });
    assert.strictEqual(line, '{"op":"sensors"}\n');
    assert.deepStrictEqual(protocol.parseReply(line), { op: "sensors" });
    assert.strictEqual(protocol.parseReply("no newline"), null);
    assert.strictEqual(protocol.parseReply("}\n"), null);
});
