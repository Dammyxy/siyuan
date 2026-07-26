import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {TopicLearningCoordinator} from "./topicLearning";
import type {LearningSessionProjection, ModelTransitionResult, SessionCallResult} from "./types";
import {deferred} from "./testDom";
import {serializeSymemoLayoutData} from "./layoutState";

interface EditorAdapterFixture {
    name: string;
    html: string;
    prepareTransition(): Promise<ModelTransitionResult>;
}

class DirectHtmlAdapter implements EditorAdapterFixture {
    public readonly name = "direct-html-adapter";
    public readonly html = "";
    public async prepareTransition(): Promise<ModelTransitionResult> {
        return {allowed: true};
    }
}

class BufferedHtmlAdapter implements EditorAdapterFixture {
    public readonly name = "buffered-html-adapter";
    public readonly html = "";
    public async prepareTransition(): Promise<ModelTransitionResult> {
        await Promise.resolve();
        return {allowed: true};
    }
}

const completed = (): LearningSessionProjection => ({
    status: "completed",
    stage: "completed",
    phase: "completed",
    remainingElementIds: [],
});

const active = (elementId: string): LearningSessionProjection => ({
    sessionId: "session-007",
    status: "active",
    stage: "outstanding",
    phase: "question",
    current: {kind: "element.topic", elementId},
    remainingElementIds: [],
});

const ok = (session: LearningSessionProjection): SessionCallResult => ({ok: true, session});

const runScenario = async (editor: EditorAdapterFixture) => {
    const trace: string[] = [];
    let current = completed();
    const coordinator = new TopicLearningCoordinator({
        displayedElementId: "topic-empty",
        getDisplayedEligibility: () => ({known: true, supportedTopic: true, readOnly: false, barrierActive: false}),
        prepareTransition: async () => {
            trace.push("prepare");
            return editor.prepareTransition();
        },
        getCurrent: async () => {
            trace.push("current");
            return ok(current);
        },
        start: async () => {
            trace.push("start");
            current = active("topic-next");
            return ok(current);
        },
        stop: async () => ok(completed()),
        next: async (elementId, eventId) => {
            trace.push(`next:${elementId}:${eventId}`);
            return {ok: true, eventId, reviewAccepted: true, session: current};
        },
        createEventId: () => "event-editor-adapter",
        followTarget: async (elementId) => {
            trace.push(`follow:${elementId}`);
            return true;
        },
        publish: (state) => trace.push(`state:${state.phase}:${state.primaryAction || "none"}`),
        runOperation: async (_name, callback) => ({started: true, value: await callback({isCancelled: false})}),
    });
    await coordinator.initialized;
    await coordinator.learn();
    current = completed();
    await coordinator.refresh();
    return {
        html: editor.html,
        transportAndControlTrace: trace.filter((item) => !item.startsWith("state:busy")),
        nextRequests: trace.filter((item) => item.startsWith("next:")),
    };
};

describe("Feature 007 editor-independent Start tracer", () => {
    it("keeps transport, identity, scheduling, and control scenarios unchanged across HTML editor Adapters", async () => {
        const direct = await runScenario(new DirectHtmlAdapter());
        const buffered = await runScenario(new BufferedHtmlAdapter());

        assert.equal(direct.html, "");
        assert.deepEqual(buffered, direct);
        assert.deepEqual(direct.nextRequests, []);
        assert.equal(direct.transportAndControlTrace.includes("start"), true);
        assert.equal(direct.transportAndControlTrace.includes("follow:topic-next"), true);
    });
});

describe("Feature 007 durable Next tracer", () => {
    it("flushes dirty title/body before one identity and accepted navigation", async () => {
        const trace: string[] = [];
        let dirtyTitle = true;
        let dirtyBody = true;
        const coordinator = new TopicLearningCoordinator({
            displayedElementId: "topic-a",
            getDisplayedEligibility: () => ({known: true, supportedTopic: true, readOnly: false, barrierActive: false}),
            prepareTransition: async () => {
                trace.push("flush:title");
                dirtyTitle = false;
                trace.push("flush:body");
                dirtyBody = false;
                return {allowed: true};
            },
            getCurrent: async () => {
                trace.push("current");
                return ok(active("topic-a"));
            },
            start: async () => ok(active("topic-a")),
            stop: async () => ok(completed()),
            next: async (elementId, eventId) => {
                assert.equal(dirtyTitle, false);
                assert.equal(dirtyBody, false);
                trace.push(`next:${elementId}:${eventId}`);
                return {ok: true, eventId, reviewAccepted: true, session: active("topic-b")};
            },
            createEventId: () => {
                trace.push("id:event-007");
                return "event-007";
            },
            followTarget: async (elementId) => {
                trace.push(`follow:${elementId}`);
                return true;
            },
            publish: (state) => trace.push(`state:${state.phase}`),
            runOperation: async (_name, callback) => ({started: true, value: await callback({isCancelled: false})}),
        });
        await coordinator.initialized;
        trace.length = 0;

        await coordinator.next();

        assert.deepEqual(trace.filter((item) => !item.startsWith("state:")), [
            "current",
            "flush:title",
            "flush:body",
            "id:event-007",
            "next:topic-a:event-007",
            "follow:topic-b",
        ]);
    });
});

describe("Feature 007 Next recovery tracer", () => {
    it("keeps one identity through pre-acceptance retry and accepted queue continuation", async () => {
        const trace: string[] = [];
        let calls = 0;
        const coordinator = new TopicLearningCoordinator({
            displayedElementId: "topic-a",
            getDisplayedEligibility: () => ({known: true, supportedTopic: true, readOnly: false, barrierActive: false}),
            prepareTransition: async () => ({allowed: true}),
            getCurrent: async () => ok(active("topic-a")),
            start: async () => ok(active("topic-a")),
            stop: async () => ok(completed()),
            next: async (_elementId, eventId) => {
                trace.push(`next:${eventId}`);
                calls++;
                if (calls === 1) return {
                    ok: false,
                    failure: {
                        errorCode: "durable-write-failed", retryable: true, acceptance: "notAccepted" as const,
                        acceptedEventId: eventId, kind: "domain" as const,
                    },
                };
                if (calls === 2) return {
                    ok: false,
                    failure: {
                        errorCode: "response", retryable: true, acceptance: "unknown" as const,
                        kind: "response" as const,
                    },
                };
                if (calls === 3) return {
                    ok: false,
                    failure: {
                        errorCode: "queue-advance-failed", retryable: true, acceptance: "accepted" as const,
                        acceptedEventId: eventId,
                        session: {...active("topic-a"), pendingAcceptedEventId: eventId},
                        kind: "domain" as const,
                    },
                };
                return {ok: true, eventId, reviewAccepted: true, session: completed()};
            },
            createEventId: () => {
                trace.push("id:event-recovery");
                return "event-recovery";
            },
            followTarget: async () => true,
            publish: (state) => trace.push(`state:${state.phase}`),
            runOperation: async (_name, callback) => ({started: true, value: await callback({isCancelled: false})}),
        });
        await coordinator.initialized;
        trace.length = 0;

        await coordinator.next();
        await coordinator.retryNext();
        await coordinator.retryNext();
        await coordinator.continueNext();

        assert.equal(trace.filter((item) => item === "id:event-recovery").length, 1);
        assert.deepEqual(trace.filter((item) => item.startsWith("next:")), [
            "next:event-recovery",
            "next:event-recovery",
            "next:event-recovery",
            "next:event-recovery",
        ]);
        assert.equal(trace.at(-1), "state:completed");
    });

    it("keeps accepted projection recovery schedule-neutral until Resume adopts replacement authority", async () => {
        let current = active("topic-a");
        let nextCalls = 0;
        const states: string[] = [];
        const coordinator = new TopicLearningCoordinator({
            displayedElementId: "topic-a",
            getDisplayedEligibility: () => ({known: true, supportedTopic: true, readOnly: false, barrierActive: false}),
            prepareTransition: async () => ({allowed: true}),
            getCurrent: async () => ok(current),
            start: async () => ok(completed()),
            stop: async () => ok(completed()),
            next: async (_elementId, eventId) => {
                nextCalls++;
                return {
                    ok: false,
                    failure: {
                        errorCode: "projection-refresh-failed",
                        retryable: true,
                        acceptance: "accepted",
                        acceptedEventId: eventId,
                        session: current,
                        kind: "domain",
                    },
                };
            },
            createEventId: () => "event-projection",
            followTarget: async () => true,
            publish: (state) => states.push(state.phase),
            runOperation: async (_name, callback) => ({started: true, value: await callback({isCancelled: false})}),
        });
        await coordinator.initialized;
        await coordinator.next();
        await coordinator.next();
        assert.equal(nextCalls, 1);
        assert.equal(states.at(-1), "acceptedRecovering");

        current = completed();
        await coordinator.resume();
        assert.equal(nextCalls, 1);
        assert.equal(states.at(-1), "noDue");
    });

    it("sends no Next behind a host barrier and makes cancelled or destroyed late acceptance inert", async () => {
        let barrierActive = true;
        let requests = 0;
        const blocked = new TopicLearningCoordinator({
            displayedElementId: "topic-a",
            getDisplayedEligibility: () => ({known: true, supportedTopic: true, readOnly: false, barrierActive}),
            prepareTransition: async () => ({allowed: true}),
            getCurrent: async () => ok(active("topic-a")),
            start: async () => ok(active("topic-a")),
            stop: async () => ok(completed()),
            next: async (_elementId, eventId) => {
                requests++;
                return {ok: true, eventId, reviewAccepted: true, session: completed()};
            },
            createEventId: () => "event-blocked",
            followTarget: async () => true,
            publish: () => undefined,
            runOperation: async (_name, callback) => ({started: true, value: await callback({isCancelled: false})}),
        });
        await blocked.initialized;
        await blocked.next();
        assert.equal(requests, 0);
        barrierActive = false;

        const response = deferred<ReturnType<typeof completed>>();
        const operation = {isCancelled: false};
        const effects: string[] = [];
        const closing = new TopicLearningCoordinator({
            displayedElementId: "topic-a",
            getDisplayedEligibility: () => ({known: true, supportedTopic: true, readOnly: false, barrierActive: false}),
            prepareTransition: async () => ({allowed: true}),
            getCurrent: async () => ok(active("topic-a")),
            start: async () => ok(active("topic-a")),
            stop: async () => ok(completed()),
            next: async (_elementId, eventId) => ({
                ok: true,
                eventId,
                reviewAccepted: true,
                session: await response.promise,
            }),
            createEventId: () => "event-late",
            followTarget: async (elementId) => {
                effects.push(`follow:${elementId}`);
                return true;
            },
            publish: (state) => effects.push(`state:${state.phase}`),
            runOperation: async (_name, callback) => ({started: true, value: await callback(operation)}),
        });
        await closing.initialized;
        effects.length = 0;
        const pending = closing.next();
        await new Promise<void>((resolve) => setImmediate(resolve));
        operation.isCancelled = true;
        closing.destroy();
        const effectCount = effects.length;
        response.resolve(active("topic-b"));
        await pending;

        assert.equal(effects.length, effectCount);
        assert.equal(effects.some((item) => item.startsWith("follow:")), false);
    });
});

describe("Feature 007 restart authority tracer", () => {
    it("discards the local cursor and event identity, then re-enters only through Current and Start", async () => {
        const submitted: string[] = [];
        const first = new TopicLearningCoordinator({
            displayedElementId: "topic-a",
            getDisplayedEligibility: () => ({known: true, supportedTopic: true, readOnly: false, barrierActive: false}),
            prepareTransition: async () => ({allowed: true}),
            getCurrent: async () => ok(active("topic-a")),
            start: async () => ok(active("topic-a")),
            stop: async () => ok(completed()),
            next: async (_elementId, eventId) => {
                submitted.push(eventId);
                return {ok: true, eventId, reviewAccepted: true, session: completed()};
            },
            createEventId: () => "event-before-restart",
            followTarget: async () => true,
            publish: () => undefined,
            runOperation: async (_name, callback) => ({started: true, value: await callback({isCancelled: false})}),
        });
        await first.initialized;
        await first.next();
        first.destroy();

        let current = completed();
        const states: string[] = [];
        const second = new TopicLearningCoordinator({
            displayedElementId: "topic-a",
            getDisplayedEligibility: () => ({known: true, supportedTopic: true, readOnly: false, barrierActive: false}),
            prepareTransition: async () => ({allowed: true}),
            getCurrent: async () => ok(current),
            start: async () => {
                current = active("topic-a");
                return ok(current);
            },
            stop: async () => ok(completed()),
            next: async (_elementId, eventId) => {
                submitted.push(eventId);
                return {ok: true, eventId, reviewAccepted: true, session: completed()};
            },
            createEventId: () => "event-after-restart",
            followTarget: async () => true,
            publish: (state) => states.push(state.phase),
            runOperation: async (_name, callback) => ({started: true, value: await callback({isCancelled: false})}),
        });
        await second.initialized;
        assert.equal(states.at(-1), "idle");
        await second.learn();
        assert.equal(states.at(-1), "activeTopic");
        await second.next();

        assert.deepEqual(submitted, ["event-before-restart", "event-after-restart"]);
        const identity = serializeSymemoLayoutData({elementId: "topic-a", title: "Topic", icon: "icon"});
        assert.deepEqual(Object.keys(identity).sort(), ["elementId", "icon", "instance", "title"]);
        const serialized = JSON.stringify(identity);
        for (const forbidden of ["session", "event", "control", "editor", "pendingAcceptedEventId"]) {
            assert.equal(serialized.includes(forbidden), false);
        }
    });
});
