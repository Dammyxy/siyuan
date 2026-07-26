const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createSymemoAuthoringTransitionBroker} = require("./symemoAuthoringTransition");

describe("electron Symemo authoring transition broker", () => {
    it("keeps readonly as a built-in desktop argument and forwards it to the kernel", () => {
        const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

        assert.match(source, /arg\.startsWith\("--readonly="\) \|\| arg === "--readonly"/);
        assert.match(source, /const readOnly = getArg\("--readonly"\) === "true";/);
        assert.match(source, /cmds\.push\("--readonly", "true"\);/);
        assert.match(source, /const readOnly = argv\.some\(\(arg\) => arg === "--readonly" \|\| arg === "--readonly=true"\);/);
        assert.match(source, /initKernel\(workspace, port, lang, false, readOnly\)/);
    });

    it("prepares every same-port renderer and rejects incompatible complete intents", async () => {
        const events = [];
        const broker = createSymemoAuthoringTransitionBroker({
            createToken: () => "token-a",
            listWindows: () => [
                {id: 1, port: "6806", kind: "app"},
                {id: 2, port: "6806", kind: "app"},
            ],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({allowed: true});
            },
            log: () => undefined,
        });

        const first = await broker.begin({
            senderId: 1,
            requestId: "r1",
            intent: {kind: "application-exit", requester: "toolbar"},
            port: "6806",
        });
        const busy = await broker.begin({
            senderId: 1,
            requestId: "r2",
            intent: {kind: "workspace-open", target: "H:\\other\\", requester: "menu"},
            port: "6806",
        });

        assert.deepEqual(first, {allowed: true, token: "token-a"});
        assert.deepEqual(busy, {allowed: false, reason: "busy"});
        assert.deepEqual(events.map((event) => event.payload.action), ["prepare", "prepare"]);
    });

    it("cancels prepared renderers and clears the broker when one window blocks", async () => {
        const events = [];
        const broker = createSymemoAuthoringTransitionBroker({
            createToken: () => "token-b",
            listWindows: () => [
                {id: 1, port: "6806", kind: "app"},
                {id: 2, port: "6806", kind: "app"},
            ],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve(windowId === 2 ? {allowed: false, reason: "conflict"} : {allowed: true});
            },
            log: () => undefined,
        });

        const result = await broker.begin({
            senderId: 1,
            requestId: "r1",
            intent: {kind: "application-exit", requester: "toolbar"},
            port: "6806",
        });

        assert.deepEqual(result, {allowed: false, reason: "conflict"});
        assert.deepEqual(events.map((event) => event.payload.action), ["prepare", "prepare", "cancel"]);
    });

    it("binds commit, cancel, and normal host exit to the exact transition owner", async () => {
        const events = [];
        const broker = createSymemoAuthoringTransitionBroker({
            createToken: () => "token-owner",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({allowed: true});
            },
            log: () => undefined,
        });
        const started = await broker.begin({
            senderId: 1,
            requestId: "exit-owner",
            intent: {kind: "application-exit", requester: "toolbar"},
            port: "6806",
        });

        assert.deepEqual(started, {allowed: true, token: "token-owner"});
        assert.equal(await broker.commit({token: "token-owner", senderId: 2, port: "6806"}), false);
        assert.equal(await broker.commit({token: "token-owner", senderId: 1, port: "6807"}), false);
        assert.equal(await broker.cancel({token: "token-owner", senderId: 2, port: "6806"}), false);
        assert.equal(await broker.commit({token: "token-owner", senderId: 1, port: "6806"}), true);
        assert.equal(await broker.commit({token: "token-owner", senderId: 1, port: "6806"}), true);
        assert.deepEqual(events.map((event) => event.payload.action), ["prepare", "commit"]);

        assert.equal(broker.consumeCommitted({token: "token-owner", senderId: 2, port: "6806"}), false);
        assert.equal(broker.consumeCommitted({token: "token-owner", senderId: 1, port: "6807"}), false);
        assert.equal(broker.consumeCommitted({
            token: "token-owner",
            senderId: 1,
            port: "6806",
            allowedKinds: ["application-exit"],
        }), true);
        assert.equal(broker.consumeCommitted({
            token: "token-owner",
            senderId: 1,
            port: "6806",
            allowedKinds: ["application-exit"],
        }), false);
        assert.deepEqual(await broker.begin({
            senderId: 1,
            requestId: "exit-second",
            intent: {kind: "application-exit", requester: "toolbar"},
            port: "6806",
        }), {allowed: false, reason: "busy"});
        broker.unregister({senderId: 1});
        assert.equal(broker.consumeCommitted({token: "token-owner", senderId: 1, port: "6806"}), false);
    });

    it("validates complete intents and binds prepared workspace authority to the exact target", async () => {
        const broker = createSymemoAuthoringTransitionBroker({
            createToken: () => "token-workspace",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}],
            send: () => Promise.resolve({allowed: true}),
            log: () => undefined,
        });

        assert.deepEqual(await broker.begin({
            senderId: 1,
            requestId: "bad",
            intent: {kind: "workspace-open", target: "", requester: "menu"},
            port: "6806",
        }), {allowed: false, reason: "unavailable"});

        assert.deepEqual(await broker.begin({
            senderId: 1,
            requestId: "workspace",
            intent: {kind: "workspace-open", target: "h:\\Other\\", requester: "menu"},
            port: "6806",
        }), {allowed: true, token: "token-workspace"});
        assert.equal(broker.authorizePrepared({
            token: "token-workspace",
            senderId: 1,
            port: "6806",
            intent: {kind: "workspace-open", target: "H:/Other", requester: "menu"},
        }), true);
        assert.equal(broker.authorizePrepared({
            token: "token-workspace",
            senderId: 1,
            port: "6806",
            intent: {kind: "workspace-open", target: "H:/Different", requester: "menu"},
        }), false);
    });

    it("does not join an otherwise identical intent from a different requester", async () => {
        const broker = createSymemoAuthoringTransitionBroker({
            createToken: () => "token-requester",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}],
            send: () => Promise.resolve({allowed: true}),
            log: () => undefined,
        });
        const first = broker.begin({
            senderId: 1,
            requestId: "same-request",
            intent: {kind: "application-exit", requester: "toolbar"},
            port: "6806",
        });

        assert.deepEqual(await first, {allowed: true, token: "token-requester"});
        assert.deepEqual(await broker.begin({
            senderId: 1,
            requestId: "same-request",
            intent: {kind: "application-exit", requester: "tray"},
            port: "6806",
        }), {allowed: false, reason: "busy"});
    });

    it("treats commit as terminal after every renderer prepared even when one commit ACK is lost", async () => {
        const events = [];
        const broker = createSymemoAuthoringTransitionBroker({
            createToken: () => "token-terminal",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}, {id: 2, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                if (payload.action === "commit" && windowId === 2) {
                    return Promise.resolve({allowed: false, reason: "unavailable"});
                }
                return Promise.resolve({allowed: true});
            },
            log: () => undefined,
        });
        await broker.begin({
            senderId: 1,
            requestId: "terminal",
            intent: {kind: "application-exit", requester: "toolbar"},
            port: "6806",
        });

        assert.equal(await broker.commit({token: "token-terminal", senderId: 1, port: "6806"}), true);
        assert.equal(broker.consumeCommitted({
            token: "token-terminal",
            senderId: 1,
            port: "6806",
            allowedKinds: ["application-exit"],
        }), true);
        assert.deepEqual(events.filter((event) => event.payload.action === "commit").map((event) => event.windowId), [1, 2]);
    });

    it("waits for pending authoring windows to register before resolving preparation", async () => {
        const events = [];
        const broker = createSymemoAuthoringTransitionBroker({
            createToken: () => "token-pending",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({allowed: true});
            },
            log: () => undefined,
        });
        broker.markPending({id: 2, port: "6806", kind: "app"});

        let settled = false;
        const beginning = broker.begin({
            senderId: 1,
            requestId: "exit-pending",
            intent: {kind: "application-exit", requester: "toolbar"},
            port: "6806",
        }).then((result) => {
            settled = true;
            return result;
        });
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(settled, false);
        assert.deepEqual(events.map((event) => event.windowId), [1]);

        assert.equal(broker.register({senderId: 2, port: "6806", kind: "app"}), true);
        assert.deepEqual(await beginning, {allowed: true, token: "token-pending"});
        assert.deepEqual(events.map((event) => event.windowId), [1, 2]);
        assert.equal(broker.markPending({id: 3, port: "6806", kind: "app"}), false);
    });

    it("cancels preparation when a pending authoring window never registers", async () => {
        const scheduled = [];
        const events = [];
        const broker = createSymemoAuthoringTransitionBroker({
            createToken: () => "token-registration-timeout",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({allowed: true});
            },
            scheduleRegistrationTimeout: (callback) => {
                scheduled.push(callback);
                return () => scheduled.splice(scheduled.indexOf(callback), 1);
            },
            log: () => undefined,
        });
        broker.markPending({id: 2, port: "6806", kind: "app"});
        const beginning = broker.begin({
            senderId: 1,
            requestId: "registration-timeout",
            intent: {kind: "application-exit", requester: "toolbar"},
            port: "6806",
        });
        await Promise.resolve();
        await Promise.resolve();

        assert.equal(scheduled.length, 1);
        scheduled[0]();

        assert.deepEqual(await beginning, {allowed: false, reason: "unavailable"});
        assert.deepEqual(events.map((event) => event.payload.action), ["prepare", "cancel"]);
    });

    it("derives normal transition and quit authority from the Electron sender", () => {
        const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

        assert.match(source, /const getAuthoringSenderPort = \(sender\) =>/);
        assert.match(source, /port: getAuthoringSenderPort\(event\.sender\)/);
        assert.doesNotMatch(source, /port: data\.port,\s*\}\);/);
        assert.match(source, /symemoAuthoringBroker\.commit\(\{[\s\S]*?senderId: event\.sender\.id/);
        assert.match(source, /symemoAuthoringBroker\.consumeCommitted\(\{[\s\S]*?senderId: event\.sender\.id/);
    });

    it("preflights update installation before committing renderer barriers", () => {
        const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
        const rendererSource = fs.readFileSync(path.resolve(__dirname, "../src/dialog/processSystem.ts"), "utf8");
        const preflightIndex = rendererSource.indexOf('phase: "preflight"');
        const commitIndex = rendererSource.indexOf("await lease.commit()", preflightIndex);

        assert.ok(preflightIndex >= 0 && commitIndex > preflightIndex);
        assert.match(mainSource, /data\?\.phase === "preflight"[\s\S]*?symemoAuthoringBroker\.authorizePrepared/);
        assert.match(mainSource, /intent: \{kind: "update-install", requester: "update-install"\}/);
    });

    it("reserves update installation atomically from preflight through start", () => {
        const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
        const timeoutStart = mainSource.indexOf("const timeout = setTimeout", mainSource.indexOf('data?.phase === "preflight"'));
        const timeoutEnd = mainSource.indexOf("}, 30000)", timeoutStart);
        const timeoutBody = mainSource.slice(timeoutStart, timeoutEnd);

        assert.match(mainSource, /updateInstallOwners\.set\(data\.token, \{[\s\S]*?phase: "preflight"[\s\S]*?request/);
        assert.match(mainSource, /beginGracefulSystemShutdown[\s\S]*?hasPendingUpdateInstallReservation\(\)/);
        assert.match(mainSource, /data\.action === "cancel"[\s\S]*?releaseUpdateInstallPreflight/);
        assert.match(mainSource, /existingOwner\.phase === "started"/);
        assert.match(mainSource, /existingOwner\.phase !== "preflight"/);
        assert.match(mainSource, /beginUpdateInstall\(event, data, existingOwner\.request\)/);
        assert.ok(timeoutBody.indexOf("symemoAuthoringBroker.cancel") < timeoutBody.indexOf("releaseUpdateInstallPreflight"));
    });
});
