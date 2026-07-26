import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {deferred} from "./testDom";
import {
    HostAuthoringTransitionOwner,
    createHostTransitionIntentKey,
} from "./hostAuthoringTransition";

describe("host authoring transition owner", () => {
    it("deduplicates identical complete intents and rejects incompatible ones as busy", async () => {
        const begin = deferred<{allowed: true; token: string}>();
        const calls: unknown[] = [];
        const owner = new HostAuthoringTransitionOwner({
            begin: (intent) => {
                calls.push(intent);
                return begin.promise;
            },
            commit: async () => undefined,
            cancel: async () => undefined,
        });

        const first = owner.begin({kind: "workspace-replace", target: "H:/ws-a", requester: "menu", requestId: "r1"});
        const second = owner.begin({kind: "workspace-replace", target: "H:/ws-a", requester: "menu", requestId: "r1"});
        const busy = await owner.begin({kind: "workspace-replace", target: "H:/ws-b", requester: "menu", requestId: "r2"});
        begin.resolve({allowed: true, token: "token-a"});

        assert.deepEqual(busy, {allowed: false, reason: "busy"});
        assert.equal((await first).allowed, true);
        assert.equal(await first, await second);
        assert.equal(calls.length, 1);
    });

    it("sends only complete transition intent metadata to the broker", async () => {
        const payloads: unknown[] = [];
        const owner = new HostAuthoringTransitionOwner({
            begin: async (intent) => {
                payloads.push(intent);
                return {allowed: true, token: "token-a"};
            },
            commit: async () => undefined,
            cancel: async () => undefined,
        });

        await owner.begin({kind: "application-exit", requester: "toolbar", requestId: "exit-a"});

        const serialized = JSON.stringify(payloads);
        assert.equal(serialized.includes("elementId"), false);
        assert.equal(serialized.includes("html"), false);
        assert.equal(serialized.includes("revision"), false);
        assert.equal(createHostTransitionIntentKey({kind: "workspace-open", target: "H:/ws", requester: "x", requestId: "1"}), "workspace-open:x:H:/ws");
        assert.equal(createHostTransitionIntentKey({kind: "workspace-open", target: "H:\\ws\\", requester: "x"}), "workspace-open:x:H:/ws");
    });

    it("keeps a committed host action terminal while cancellation releases ownership", async () => {
        const calls: string[] = [];
        const owner = new HostAuthoringTransitionOwner({
            begin: async (intent) => ({allowed: true, token: intent.kind}),
            commit: async (token) => { calls.push(`commit:${token}`); },
            cancel: async (token) => { calls.push(`cancel:${token}`); },
        });
        const committed = await owner.begin({kind: "application-exit", requester: "toolbar"});
        assert.equal(committed.allowed, true);
        if (committed.allowed === false) throw new Error("expected lease");
        await committed.commit();
        await committed.commit();

        assert.deepEqual(await owner.begin({kind: "workspace-open", target: "H:/ws", requester: "menu"}), {
            allowed: false,
            reason: "busy",
        });
        assert.deepEqual(calls, ["commit:application-exit"]);

        const cancellableOwner = new HostAuthoringTransitionOwner({
            begin: async (intent) => ({allowed: true, token: intent.kind}),
            commit: async () => undefined,
            cancel: async (token) => { calls.push(`cancel:${token}`); },
        });
        const cancellable = await cancellableOwner.begin({kind: "workspace-open", target: "H:/ws-a", requester: "menu"});
        assert.equal(cancellable.allowed, true);
        if (cancellable.allowed === false) throw new Error("expected lease");
        await cancellable.cancel();
        assert.equal((await cancellableOwner.begin({kind: "workspace-open", target: "H:/ws-b", requester: "menu"})).allowed, true);
    });
});
