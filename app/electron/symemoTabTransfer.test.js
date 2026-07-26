const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const {createSymemoTabTransferBroker} = require("./symemoTabTransfer");

describe("electron Symemo tab transfer broker", () => {
    it("binds source and destination to trusted sender windows only", async () => {
        const events = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-a",
            listWindows: () => [
                {id: 1, port: "6806", kind: "app"},
                {id: 2, port: "6806", kind: "app"},
                {id: 3, port: "6807", kind: "app"},
            ],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({ok: true});
            },
            log: () => undefined,
        });

        const reserved = await broker.reserve({senderId: 2, port: "6806", offerId: "offer-a"});
        assert.deepEqual(reserved, {ok: true, transferId: "transfer-a"});
        assert.deepEqual(events, [{
            windowId: 1,
            payload: {action: "locate", transferId: "transfer-a", offerId: "offer-a"},
        }]);
        assert.equal(await broker.ready({senderId: 2, transferId: "transfer-a"}), true);
        assert.equal(await broker.claim({senderId: 3, port: "6807", transferId: "transfer-a", offerId: "offer-a"}), false);
        assert.equal(await broker.claim({senderId: 1, port: "6806", transferId: "transfer-a", offerId: "offer-a"}), true);
        assert.equal(await broker.claim({senderId: 3, port: "6806", transferId: "transfer-a", offerId: "offer-a"}), false);

        assert.deepEqual(events.at(-1), {
            windowId: 2,
            payload: {action: "ready", transferId: "transfer-a"},
        });
        assert.equal(events.some((event) => event.payload.action === "prepare-source"), false);
        assert.equal(await broker.ready({senderId: 2, transferId: "transfer-a", handoff: true}), true);
        assert.deepEqual(events.at(-1), {
            windowId: 1,
            payload: {action: "prepare-source", transferId: "transfer-a", offerId: "offer-a"},
        });
        assert.equal(await broker.sourceCommitted({senderId: 1, transferId: "transfer-a", identity: {instance: "SymemoElement", elementId: "topic-a"}}), true);
        assert.deepEqual(events.at(-1), {
            windowId: 2,
            payload: {
                action: "materialize",
                transferId: "transfer-a",
                identity: {instance: "SymemoElement", elementId: "topic-a"},
            },
        });
    });

    it("acknowledges cancellation to both bound renderers before settlement", async () => {
        const events = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-cancelled",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}, {id: 2, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({ok: true});
            },
            log: () => undefined,
        });
        await broker.reserve({senderId: 2, port: "6806", offerId: "offer-a"});
        await broker.claim({senderId: 1, port: "6806", transferId: "transfer-cancelled", offerId: "offer-a"});
        await broker.ready({senderId: 2, transferId: "transfer-cancelled"});

        assert.deepEqual(events.at(-1), {
            windowId: 2,
            payload: {action: "ready", transferId: "transfer-cancelled"},
        });
        assert.equal(events.some((event) => event.payload.action === "prepare-source"), false);

        assert.equal(await broker.cancel({senderId: 2, transferId: "transfer-cancelled"}), true);
        assert.deepEqual(events.slice(-2), [
            {windowId: 1, payload: {action: "cancelled", transferId: "transfer-cancelled"}},
            {windowId: 2, payload: {action: "cancelled", transferId: "transfer-cancelled"}},
        ]);
    });

    it("materializes a hidden destination only after the exact source commits", async () => {
        const events = [];
        const shown = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-new-window",
            createDestination: async (request) => {
                events.push({action: "create-destination", request});
                return 2;
            },
            showDestination: (windowId) => shown.push(windowId),
            destroyDestination: () => undefined,
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({ok: true});
            },
            log: () => undefined,
        });

        const opening = broker.openNewWindow({senderId: 1, port: "6806", offerId: "offer-a", options: {width: 800}});
        await Promise.resolve();
        assert.equal(await broker.ready({senderId: 3, transferId: "transfer-new-window"}), false);
        assert.equal(await broker.ready({senderId: 2, transferId: "transfer-new-window"}), true);
        assert.deepEqual(events.at(-1), {
            windowId: 2,
            payload: {action: "ready", transferId: "transfer-new-window"},
        });
        assert.equal(await broker.ready({senderId: 2, transferId: "transfer-new-window", handoff: true}), true);
        assert.deepEqual(events.at(-1), {
            windowId: 1,
            payload: {action: "prepare-source", transferId: "transfer-new-window", offerId: "offer-a"},
        });

        assert.equal(await broker.sourceCommitted({
            senderId: 3,
            transferId: "transfer-new-window",
            identity: {instance: "SymemoElement", elementId: "topic-a"},
        }), false);
        assert.equal(await broker.sourceCommitted({
            senderId: 1,
            transferId: "transfer-new-window",
            identity: {instance: "SymemoElement", elementId: "topic-a", title: "Topic", icon: "iconFile"},
        }), true);
        assert.deepEqual(events.at(-1), {
            windowId: 2,
            payload: {
                action: "materialize",
                transferId: "transfer-new-window",
                identity: {instance: "SymemoElement", elementId: "topic-a", title: "Topic", icon: "iconFile"},
            },
        });

        assert.equal(await broker.materialized({senderId: 2, transferId: "transfer-new-window"}), true);
        assert.equal(await opening, true);
        assert.deepEqual(shown, [2]);
        assert.deepEqual(events.at(-1), {
            windowId: 1,
            payload: {action: "complete", transferId: "transfer-new-window", completed: true},
        });
    });

    it("rejects authoring payloads and destroys an uncommitted hidden destination on cancel", async () => {
        const destroyed = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-cancel",
            createDestination: async () => 2,
            showDestination: () => undefined,
            destroyDestination: (windowId) => destroyed.push(windowId),
            send: () => Promise.resolve({ok: true}),
            log: () => undefined,
        });
        const opening = broker.openNewWindow({senderId: 1, port: "6806", offerId: "offer-a", options: {}});
        await Promise.resolve();
        await broker.ready({senderId: 2, transferId: "transfer-cancel"});

        assert.equal(await broker.sourceCommitted({
            senderId: 1,
            transferId: "transfer-cancel",
            identity: {instance: "SymemoElement", elementId: "topic-a", html: "<p>forbidden</p>"},
        }), false);
        assert.equal(await broker.cancel({senderId: 1, transferId: "transfer-cancel"}), true);
        assert.equal(await opening, false);
        assert.deepEqual(destroyed, [2]);
    });

    it("settles a reservation when source preparation cannot be delivered", async () => {
        const events = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-send-failed",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}, {id: 2, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve(payload.action === "prepare-source" ? {ok: false} : {ok: true});
            },
            log: () => undefined,
        });
        await broker.reserve({senderId: 2, port: "6806", offerId: "offer-a"});
        assert.equal(await broker.ready({senderId: 2, transferId: "transfer-send-failed"}), true);

        assert.equal(await broker.claim({
            senderId: 1,
            port: "6806",
            transferId: "transfer-send-failed",
            offerId: "offer-a",
        }), true);
        assert.equal(await broker.ready({
            senderId: 2,
            transferId: "transfer-send-failed",
            handoff: true,
        }), false);
        assert.deepEqual(events.slice(-2).map((event) => event.payload.action), ["cancelled", "cancelled"]);
    });

    it("settles a reservation when source preparation throws", async () => {
        const events = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-prepare-threw",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}, {id: 2, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                if (payload.action === "prepare-source") {
                    throw new Error("renderer unavailable");
                }
                return Promise.resolve({ok: true});
            },
            log: () => undefined,
        });
        await broker.reserve({senderId: 2, port: "6806", offerId: "offer-a"});
        assert.equal(await broker.ready({senderId: 2, transferId: "transfer-prepare-threw"}), true);

        assert.equal(await broker.claim({
            senderId: 1,
            port: "6806",
            transferId: "transfer-prepare-threw",
            offerId: "offer-a",
        }), true);
        assert.equal(await broker.ready({
            senderId: 2,
            transferId: "transfer-prepare-threw",
            handoff: true,
        }), false);
        assert.deepEqual(events.slice(-2).map((event) => event.payload.action), ["cancelled", "cancelled"]);
    });

    it("settles cancellation even when one renderer notification throws", async () => {
        const events = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-cancel-notify-threw",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}, {id: 2, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                if (payload.action === "cancelled" && windowId === 1) {
                    throw new Error("source gone");
                }
                return Promise.resolve({ok: true});
            },
            log: () => undefined,
        });
        await broker.reserve({senderId: 2, port: "6806", offerId: "offer-a"});
        await broker.claim({senderId: 1, port: "6806", transferId: "transfer-cancel-notify-threw", offerId: "offer-a"});

        assert.equal(await broker.cancel({senderId: 2, transferId: "transfer-cancel-notify-threw"}), true);
        assert.deepEqual(events.slice(-2).map((event) => [event.windowId, event.payload.action]), [
            [1, "cancelled"],
            [2, "cancelled"],
        ]);
        assert.equal(await broker.cancel({senderId: 2, transferId: "transfer-cancel-notify-threw"}), false);
    });

    it("releases a destination waiting for handoff acknowledgement when the reservation expires", async () => {
        const events = [];
        const scheduled = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-ready-expired",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}, {id: 2, port: "6806", kind: "app"}],
            scheduleExpiry: (callback) => {
                scheduled.push(callback);
                return undefined;
            },
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({ok: true});
            },
            log: () => undefined,
        });
        await broker.reserve({senderId: 2, port: "6806", offerId: "offer-a"});
        await broker.claim({senderId: 1, port: "6806", transferId: "transfer-ready-expired", offerId: "offer-a"});
        await broker.ready({senderId: 2, transferId: "transfer-ready-expired"});

        await scheduled[0]();

        assert.equal(events.some((event) => event.payload.action === "prepare-source"), false);
        assert.deepEqual(events.slice(-2).map((event) => event.payload.action), ["cancelled", "cancelled"]);
    });

    it("releases a destination waiting for handoff acknowledgement when it unregisters", async () => {
        const events = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-ready-unregistered",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}, {id: 2, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({ok: true});
            },
            log: () => undefined,
        });
        await broker.reserve({senderId: 2, port: "6806", offerId: "offer-a"});
        await broker.claim({senderId: 1, port: "6806", transferId: "transfer-ready-unregistered", offerId: "offer-a"});
        await broker.ready({senderId: 2, transferId: "transfer-ready-unregistered"});

        await broker.unregister({senderId: 2});

        assert.equal(events.some((event) => event.payload.action === "prepare-source"), false);
        assert.deepEqual(events.slice(-2).map((event) => event.payload.action), ["cancelled", "cancelled"]);
    });

    it("releases a committed source when the destination reports materialization failure", async () => {
        const events = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-materialize-failed",
            listWindows: () => [{id: 1, port: "6806", kind: "app"}, {id: 2, port: "6806", kind: "app"}],
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({ok: true});
            },
            log: () => undefined,
        });
        await broker.reserve({senderId: 2, port: "6806", offerId: "offer-a"});
        await broker.claim({senderId: 1, port: "6806", transferId: "transfer-materialize-failed", offerId: "offer-a"});
        await broker.ready({senderId: 2, transferId: "transfer-materialize-failed"});
        await broker.ready({senderId: 2, transferId: "transfer-materialize-failed", handoff: true});
        await broker.sourceCommitted({
            senderId: 1,
            transferId: "transfer-materialize-failed",
            identity: {instance: "SymemoElement", elementId: "topic-a"},
        });

        assert.equal(await broker.materializationFailed({senderId: 2, transferId: "transfer-materialize-failed"}), true);
        assert.deepEqual(events.at(-1), {
            windowId: 1,
            payload: {action: "complete", transferId: "transfer-materialize-failed", completed: false},
        });
    });

    it("settles a committed hidden-window transfer when its destination is destroyed", async () => {
        const events = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-destroyed",
            createDestination: async () => 2,
            send: (windowId, payload) => {
                events.push({windowId, payload});
                return Promise.resolve({ok: true});
            },
            destroyDestination: () => undefined,
            log: () => undefined,
        });
        const opening = broker.openNewWindow({senderId: 1, port: "6806", offerId: "offer-a", options: {}});
        await Promise.resolve();
        await broker.ready({senderId: 2, transferId: "transfer-destroyed"});
        await broker.ready({senderId: 2, transferId: "transfer-destroyed", handoff: true});
        await broker.sourceCommitted({
            senderId: 1,
            transferId: "transfer-destroyed",
            identity: {instance: "SymemoElement", elementId: "topic-a"},
        });

        await broker.unregister({senderId: 2});

        assert.equal(await opening, false);
        assert.deepEqual(events.at(-1), {
            windowId: 1,
            payload: {action: "complete", transferId: "transfer-destroyed", completed: false},
        });
    });

    it("does not report success when the destination is destroyed during final acknowledgement", async () => {
        let resolveCompletion;
        const events = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-destroyed-during-ack",
            createDestination: async () => 2,
            send: (windowId, payload) => {
                events.push({windowId, payload});
                if (payload.action === "complete" && payload.completed === true) {
                    return new Promise((resolve) => {
                        resolveCompletion = resolve;
                    });
                }
                return Promise.resolve({ok: true});
            },
            destroyDestination: () => undefined,
            log: () => undefined,
        });
        const opening = broker.openNewWindow({senderId: 1, port: "6806", offerId: "offer-a", options: {}});
        await Promise.resolve();
        await broker.ready({senderId: 2, transferId: "transfer-destroyed-during-ack"});
        await broker.ready({senderId: 2, transferId: "transfer-destroyed-during-ack", handoff: true});
        await broker.sourceCommitted({
            senderId: 1,
            transferId: "transfer-destroyed-during-ack",
            identity: {instance: "SymemoElement", elementId: "topic-a"},
        });

        const materialized = broker.materialized({senderId: 2, transferId: "transfer-destroyed-during-ack"});
        await Promise.resolve();
        await broker.unregister({senderId: 2});
        resolveCompletion({ok: true});

        assert.equal(await materialized, false);
        assert.equal(await opening, false);
        assert.deepEqual(events.at(-1), {
            windowId: 1,
            payload: {action: "complete", transferId: "transfer-destroyed-during-ack", completed: false},
        });
    });

    it("destroys a destination created after its source was already unregistered", async () => {
        let resolveDestination;
        const destroyed = [];
        const broker = createSymemoTabTransferBroker({
            createToken: () => "transfer-late-destination",
            createDestination: () => new Promise((resolve) => {
                resolveDestination = resolve;
            }),
            destroyDestination: (windowId) => destroyed.push(windowId),
            send: () => Promise.resolve({ok: true}),
            log: () => undefined,
        });
        const opening = broker.openNewWindow({senderId: 1, port: "6806", offerId: "offer-a", options: {}});
        await Promise.resolve();

        await broker.unregister({senderId: 1});
        resolveDestination(2);

        assert.equal(await opening, false);
        assert.deepEqual(destroyed, [2]);
    });
});
