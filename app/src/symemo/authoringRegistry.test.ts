import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {deferred} from "./testDom";
import type {ModelTransitionResult} from "./types";
import {
    isTabEvictionCandidate,
    removeTabsSequentially,
    WindowAuthoringRegistry,
    WindowTabMutationQueue,
} from "./authoringRegistry";

describe("window authoring registry", () => {
    it("blocks new registrations during a reversible barrier and restores them on cancel", async () => {
        const registry = new WindowAuthoringRegistry();
        const barriers: boolean[] = [];
        registry.register({
            id: "topic-a",
            prepareTransition: async () => ({allowed: true}),
            setWindowBarrier: (active) => barriers.push(active),
        });

        const lease = await registry.beginTransition("workspace-switch", "workspace-a");

        assert.equal(lease.allowed, true);
        if (lease.allowed === false) throw new Error("expected allowed lease");
        assert.equal(registry.canRegister(), false);
        assert.deepEqual(barriers, [true]);

        lease.cancel();

        assert.equal(registry.canRegister(), true);
        assert.deepEqual(barriers, [true, false]);
    });

    it("cancels and waits for preparing host operations before participant guards", async () => {
        const registry = new WindowAuthoringRegistry();
        const operation = registry.createOperation("open-element");
        const operationSettled = deferred<void>();
        const trace: string[] = [];
        operation.onCancel(() => {
            trace.push("cancel-open");
            operationSettled.resolve();
        });
        operation.waitUntilSettled(operationSettled.promise);
        registry.register({
            id: "topic-a",
            prepareTransition: async () => {
                trace.push("guard-topic");
                return {allowed: true};
            },
            setWindowBarrier: (): void => undefined,
        });

        const lease = await registry.beginTransition("application-exit", "exit");

        assert.equal(lease.allowed, true);
        assert.deepEqual(trace, ["cancel-open", "guard-topic"]);
    });

    it("keeps the window busy for a committed handoff until its exact release", () => {
        const registry = new WindowAuthoringRegistry();

        const release = registry.enterCommittedHandoff();

        assert.equal(registry.isBusy(), true);
        assert.equal(registry.canRegister(), false);
        release();
        assert.equal(registry.isBusy(), false);
        assert.equal(registry.canRegister(), true);
    });

    it("allows only the synchronous destination materialization to register during a committed handoff", () => {
        const registry = new WindowAuthoringRegistry();
        const release = registry.enterCommittedHandoff();
        const participant = {
            id: "transferred-topic",
            prepareTransition: async () => ({allowed: true} as const),
            setWindowBarrier: (): void => undefined,
        };

        assert.throws(() => registry.register(participant), /barrier is active/);
        const unregister = registry.materializeCommittedHandoff(() => {
            assert.equal(registry.isBusy(), true);
            return registry.register(participant);
        });
        assert.equal(registry.canRegister(), false);

        unregister();
        release();
        assert.equal(registry.canRegister(), true);
    });

    it("keeps a committed host barrier terminal until the renderer is destroyed", async () => {
        const registry = new WindowAuthoringRegistry();
        const trace: string[] = [];
        registry.register({
            id: "topic-a",
            prepareTransition: async () => ({allowed: true}),
            setWindowBarrier: (active) => trace.push(`barrier:${active}`),
            cleanup: () => trace.push("cleanup"),
        });
        const lease = await registry.beginTransition("application-exit", "exit-terminal");
        if (lease.allowed === false) throw new Error("expected allowed lease");

        lease.commit();

        assert.equal(registry.isBusy(), true);
        assert.equal(registry.canRegister(), false);
        lease.cancel();
        assert.equal(registry.isBusy(), true);
        assert.deepEqual(trace, ["barrier:true", "cleanup"]);
    });

    it("cancels and awaits a tracked creation before preparing participants", async () => {
        const registry = new WindowAuthoringRegistry();
        const started = deferred<void>();
        const finish = deferred<void>();
        const trace: string[] = [];
        const running = registry.runOperation("create-topic", async (operation) => {
            operation.onCancel(() => trace.push("cancel-create"));
            started.resolve();
            await finish.promise;
            if (!operation.isCancelled) trace.push("open-created-topic");
        });
        await started.promise;
        registry.register({
            id: "topic-a",
            prepareTransition: async () => {
                trace.push("guard-topic");
                return {allowed: true};
            },
            setWindowBarrier: () => undefined,
        });

        const transition = registry.beginTransition("application-exit", "exit");
        await Promise.resolve();
        assert.deepEqual(trace, ["cancel-create"]);

        finish.resolve();
        const lease = await transition;
        await running;

        assert.equal(lease.allowed, true);
        assert.deepEqual(trace, ["cancel-create", "guard-topic"]);
    });

    it("cancels every prepared participant when one surface blocks", async () => {
        const registry = new WindowAuthoringRegistry();
        const trace: string[] = [];
        registry.register({
            id: "clean",
            prepareTransition: async () => ({allowed: true}),
            setWindowBarrier: (active) => trace.push(`clean:${active}`),
        });
        registry.register({
            id: "dirty",
            prepareTransition: async () => ({allowed: false, reason: "conflict"}),
            setWindowBarrier: (active) => trace.push(`dirty:${active}`),
        });

        const lease = await registry.beginTransition("window-close", "close");

        assert.deepEqual(lease, {allowed: false, reason: "conflict"});
        assert.deepEqual(trace, ["clean:true", "dirty:true", "clean:false", "dirty:false"]);
        assert.equal(registry.canRegister(), true);
    });

    it("joins only the exact in-progress renderer transition", async () => {
        const registry = new WindowAuthoringRegistry();
        const guard = deferred<ModelTransitionResult>();
        registry.register({
            id: "topic-a",
            prepareTransition: () => guard.promise,
            setWindowBarrier: () => undefined,
        });

        const first = registry.beginTransition("workspace-switch", "workspace-a");
        const duplicate = registry.beginTransition("workspace-switch", "workspace-a");
        const incompatible = await registry.beginTransition("application-exit", "workspace-a");

        assert.equal(first, duplicate);
        assert.deepEqual(incompatible, {allowed: false, reason: "busy"});
        guard.resolve({allowed: true});
        const lease = await first;
        assert.equal(lease.allowed, true);
        if (lease.allowed) lease.cancel();
    });
});

describe("window tab mutation coordination", () => {
    it("serializes mutations and continues after a rejected operation", async () => {
        const queue = new WindowTabMutationQueue();
        const firstMayFinish = deferred<void>();
        const trace: string[] = [];

        const first = queue.run(async () => {
            trace.push("first:start");
            await firstMayFinish.promise;
            trace.push("first:fail");
            throw new Error("blocked");
        });
        const second = queue.run(async () => {
            trace.push("second");
            return 2;
        });
        await Promise.resolve();
        assert.deepEqual(trace, ["first:start"]);

        firstMayFinish.resolve();
        await assert.rejects(first, /blocked/);
        assert.equal(await second, 2);
        assert.deepEqual(trace, ["first:start", "first:fail", "second"]);
    });

    it("stops an ordered destructive pass at the first blocked tab", async () => {
        const attempted: string[] = [];
        const result = await removeTabsSequentially(["a", "b", "c"], async (id) => {
            attempted.push(id);
            return id !== "b";
        });

        assert.deepEqual(result, {completed: false, removed: ["a"]});
        assert.deepEqual(attempted, ["a", "b"]);
    });

    it("accepts only connected, unpinned, unfocused tab headers for eviction", () => {
        const tab = (classes: string[], head = true) => ({
            headElement: head ? {classList: {contains: (name: string) => classes.includes(name)}} : undefined,
        });

        assert.equal(isTabEvictionCandidate(tab([])), true);
        assert.equal(isTabEvictionCandidate(tab(["item--pin"])), false);
        assert.equal(isTabEvictionCandidate(tab(["item--focus"])), false);
        assert.equal(isTabEvictionCandidate(tab([], false)), false);
    });
});
