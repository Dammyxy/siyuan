import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {
    claimLocatedTabTransfer,
    commitOfferedTabTransfer,
    HostTabTransferCoordinator,
    createOpaqueTransferId,
    materializeReservedDestination,
    reserveOfferedTabTransfer,
} from "./hostTabTransfer";

describe("host tab transfer coordinator", () => {
    it("keeps a drag offer claimable after dragend until deferred expiry runs", () => {
        const scheduled: Array<() => void> = [];
        const tab = {id: "tab-a"};
        const coordinator = new HostTabTransferCoordinator({
            randomId: () => "offer-a",
            scheduleExpiry: (_ms, cb) => {
                scheduled.push(cb);
                return () => scheduled.splice(scheduled.indexOf(cb), 1);
            },
        });

        const offer = coordinator.createOffer(tab);
        coordinator.markDragEnd(offer.offerId);

        assert.equal(coordinator.claimOffer(offer.offerId, tab)?.tab, tab);
        assert.equal(scheduled.length, 0);
    });

    it("rejects stale or duplicate source claims and exposes non-cancelable handoff", () => {
        const tab = {id: "tab-a"};
        const coordinator = new HostTabTransferCoordinator({randomId: createOpaqueTransferId});
        const offer = coordinator.createOffer(tab);
        const transfer = coordinator.reserveDestination({wndId: "wnd-b"});

        assert.equal(coordinator.bindSourceClaim(transfer.transferId, offer.offerId, tab), true);
        assert.equal(coordinator.bindSourceClaim(transfer.transferId, offer.offerId, tab), false);

        coordinator.markSourceCommitted(transfer.transferId);
        assert.equal(coordinator.isCommittedHandoffActive(), true);
        assert.equal(coordinator.cancelTransfer(transfer.transferId), false);

        coordinator.materializeDestination(transfer.transferId, {instance: "SymemoElement", elementId: "topic-a"});
        assert.equal(coordinator.isCommittedHandoffActive(), false);
    });

    it("removes the exact offered tab before reporting an identity-only source commit", async () => {
        const trace: string[] = [];
        const coordinator = new HostTabTransferCoordinator({randomId: () => "offer-a"});
        const tab = {
            id: "tab-a",
            title: "Topic",
            icon: "iconFile",
            model: {elementId: "topic-a"},
            parent: {
                detachTab: async (_tab: unknown, options: {commit: () => boolean}) => {
                    trace.push("guard-source");
                    if (!options.commit()) return false;
                    trace.push("remove-source");
                    return true;
                },
                closeIfEmptyAfterTransfer: () => trace.push("close-empty-source"),
            },
        };
        coordinator.createOffer(tab);

        const committed = await commitOfferedTabTransfer({
            coordinator,
            offerId: "offer-a",
            transferId: "transfer-a",
            enterHandoff: (afterRelease) => {
                trace.push("enter-handoff");
                return () => {
                    trace.push("release-handoff");
                    afterRelease();
                };
            },
            invoke: async (_channel, payload) => {
                trace.push(payload.action);
                assert.deepEqual(payload.identity, {
                    instance: "SymemoElement",
                    elementId: "topic-a",
                    title: "Topic",
                    icon: "iconFile",
                });
                return true;
            },
        });

        assert.equal(committed.ok, true);
        assert.deepEqual(trace, ["guard-source", "enter-handoff", "remove-source", "source-committed"]);
        if (!committed.ok) throw new Error("expected committed transfer");
        committed.release();
        assert.deepEqual(trace, [
            "guard-source",
            "enter-handoff",
            "remove-source",
            "source-committed",
            "release-handoff",
            "close-empty-source",
        ]);
    });

    it("cancels a blocked offered transfer without reporting source commitment", async () => {
        const actions: string[] = [];
        const coordinator = new HostTabTransferCoordinator({randomId: () => "offer-blocked"});
        coordinator.createOffer({
            id: "tab-a",
            title: "Topic",
            icon: "iconFile",
            model: {elementId: "topic-a"},
            parent: {detachTab: async () => false},
        });

        const committed = await commitOfferedTabTransfer({
            coordinator,
            offerId: "offer-blocked",
            transferId: "transfer-blocked",
            enterHandoff: () => () => undefined,
            invoke: async (_channel, payload) => {
                actions.push(payload.action);
                return true;
            },
        });

        assert.deepEqual(committed, {ok: false});
        assert.deepEqual(actions, ["cancel"]);
    });

    it("claims a located offer only while it still points to the exact live tab", async () => {
        const coordinator = new HostTabTransferCoordinator({randomId: () => "offer-live"});
        const wnd = {children: [] as unknown[]};
        const tab = {id: "tab-live", parent: wnd};
        wnd.children.push(tab);
        coordinator.createOffer(tab);
        const claims: unknown[] = [];

        assert.equal(await claimLocatedTabTransfer({
            coordinator,
            offerId: "offer-live",
            transferId: "transfer-live",
            invoke: async (_channel, payload) => {
                claims.push(payload);
                return true;
            },
        }), true);
        assert.deepEqual(claims, [{action: "claim", transferId: "transfer-live", offerId: "offer-live"}]);

        wnd.children = [];
        assert.equal(await claimLocatedTabTransfer({
            coordinator,
            offerId: "offer-live",
            transferId: "transfer-stale",
            invoke: async () => true,
        }), false);
    });

    it("accepts a broker claim when source preparation consumes the already-claimed local offer", async () => {
        const coordinator = new HostTabTransferCoordinator({randomId: () => "offer-lost"});
        const wnd = {children: [] as unknown[]};
        const tab = {id: "tab-lost", parent: wnd};
        wnd.children.push(tab);
        coordinator.createOffer(tab);
        const actions: string[] = [];

        assert.equal(await claimLocatedTabTransfer({
            coordinator,
            offerId: "offer-lost",
            transferId: "transfer-lost",
            invoke: async (_channel, payload) => {
                actions.push(payload.action);
                if (payload.action === "claim") coordinator.takeOffer("offer-lost");
                return true;
            },
        }), true);
        assert.deepEqual(actions, ["claim"]);
    });

    it("retains a preclaimed local offer when the broker claim response is uncertain", async () => {
        const scheduled: Array<() => void> = [];
        const coordinator = new HostTabTransferCoordinator({
            randomId: () => "offer-uncertain-claim",
            scheduleExpiry: (_ms, callback) => {
                scheduled.push(callback);
                return () => scheduled.splice(scheduled.indexOf(callback), 1);
            },
        });
        const wnd = {children: [] as unknown[]};
        const tab = {id: "tab-uncertain", parent: wnd};
        wnd.children.push(tab);
        coordinator.createOffer(tab);

        assert.equal(await claimLocatedTabTransfer({
            coordinator,
            offerId: "offer-uncertain-claim",
            transferId: "transfer-uncertain-claim",
            invoke: async () => {
                throw new Error("response lost");
            },
        }), true);
        assert.equal(coordinator.getLiveOffer("offer-uncertain-claim")?.tab, tab);
        assert.equal(scheduled.length, 1);
        scheduled[0]();
        assert.equal(coordinator.getLiveOffer("offer-uncertain-claim"), undefined);
    });

    it("releases the source handoff when source commitment is rejected", async () => {
        const trace: string[] = [];
        const coordinator = new HostTabTransferCoordinator({randomId: () => "offer-rejected"});
        coordinator.createOffer({
            id: "tab-a",
            title: "Topic",
            icon: "iconFile",
            model: {elementId: "topic-a"},
            parent: {
                detachTab: async (_tab: unknown, options: {commit: () => boolean}) => options.commit(),
            },
        });

        assert.deepEqual(await commitOfferedTabTransfer({
            coordinator,
            offerId: "offer-rejected",
            transferId: "transfer-rejected",
            enterHandoff: () => () => trace.push("released"),
            invoke: async () => false,
        }), {ok: false});
        assert.deepEqual(trace, ["released"]);
    });

    it("keeps the source handoff when source commitment delivery is uncertain", async () => {
        const trace: string[] = [];
        let releaseSource: (() => void) | undefined;
        const coordinator = new HostTabTransferCoordinator({randomId: () => "offer-uncertain"});
        coordinator.createOffer({
            id: "tab-a",
            title: "Topic",
            icon: "iconFile",
            model: {elementId: "topic-a"},
            parent: {
                detachTab: async (_tab: unknown, options: {commit: () => boolean}) => options.commit(),
                closeIfEmptyAfterTransfer: () => trace.push("close-empty-source"),
            },
        });

        assert.deepEqual(await commitOfferedTabTransfer({
            coordinator,
            offerId: "offer-uncertain",
            transferId: "transfer-uncertain",
            enterHandoff: (afterRelease) => {
                releaseSource = () => {
                    trace.push("released");
                    afterRelease();
                };
                return releaseSource;
            },
            invoke: async () => {
                throw new Error("response lost");
            },
        }), {ok: false});
        assert.deepEqual(trace, []);

        releaseSource?.();
        assert.deepEqual(trace, ["released", "close-empty-source"]);
    });

    it("keeps destination protection through synchronous insertion and failure reporting", async () => {
        const trace: string[] = [];

        assert.equal(await materializeReservedDestination({
            identity: {instance: "SymemoElement", elementId: "topic-a"},
            releaseHandoff: () => trace.push("release"),
            materialize: () => {
                trace.push("materialize");
                return false;
            },
            report: async (action) => {
                trace.push(action);
                return true;
            },
        }), false);
        assert.deepEqual(trace, ["materialize", "materialization-failed", "release"]);
    });

    it("activates an inert destination only after materialization is acknowledged and protection is released", async () => {
        const trace: string[] = [];

        assert.equal(await materializeReservedDestination({
            identity: {instance: "SymemoElement", elementId: "topic-a"},
            releaseHandoff: () => trace.push("release"),
            materialize: () => {
                trace.push("materialize");
                return {ok: true, activate: () => trace.push("activate")};
            },
            report: async (action) => {
                trace.push(action);
                return true;
            },
        }), true);
        assert.deepEqual(trace, ["materialize", "materialized", "release", "activate"]);
    });

    it("reserves and readies an existing destination before reporting success", async () => {
        const trace: string[] = [];
        const materialize = () => true;
        const result = await reserveOfferedTabTransfer({
            offerId: "offer-a",
            invoke: async (_channel, payload) => {
                trace.push(payload.action);
                return {ok: true, transferId: "transfer-a"};
            },
            registerDestination: async (transferId, closure) => {
                trace.push(`ready:${transferId}`);
                assert.strictEqual(closure, materialize);
                return true;
            },
            materialize,
        });

        assert.equal(result, true);
        assert.deepEqual(trace, ["reserve", "ready:transfer-a"]);
    });
});
