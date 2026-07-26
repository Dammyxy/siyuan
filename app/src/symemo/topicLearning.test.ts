import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {TopicLearningCoordinator} from "./topicLearning";
import type {
    LearningControlProjection,
    LearningSessionProjection,
    ModelTransitionResult,
    SessionCallResult,
    TopicNextCallResult,
} from "./types";
import {deferred} from "./testDom";

const topicId = "topic-007-a";
const otherTopicId = "topic-007-b";

const completedSession = (): LearningSessionProjection => ({
    status: "completed",
    stage: "completed",
    phase: "completed",
    remainingElementIds: [],
});

const activeTopicSession = (elementId = topicId): LearningSessionProjection => ({
    sessionId: "session-007",
    status: "active",
    stage: "outstanding",
    phase: "question",
    current: {kind: "element.topic", elementId},
    remainingElementIds: elementId === topicId ? [otherTopicId] : [],
});

const success = (session: LearningSessionProjection): SessionCallResult => ({ok: true, session});

const createHarness = (options: {
    current?: () => Promise<SessionCallResult>;
    start?: () => Promise<SessionCallResult>;
    stop?: () => Promise<SessionCallResult>;
    prepare?: () => Promise<ModelTransitionResult>;
    follow?: (elementId: string) => Promise<boolean>;
    readOnly?: boolean;
    next?: (elementId: string, eventId: string) => Promise<TopicNextCallResult>;
    createEventId?: () => string;
} = {}) => {
    const trace: string[] = [];
    const projections: LearningControlProjection[] = [];
    let current = options.current || (async () => success(activeTopicSession()));
    let readOnly = options.readOnly || false;
    const coordinator = new TopicLearningCoordinator({
        displayedElementId: topicId,
        getDisplayedEligibility: () => ({
            known: true,
            supportedTopic: true,
            readOnly,
            barrierActive: false,
        }),
        prepareTransition: async () => {
            trace.push("prepare:target-change");
            return options.prepare ? options.prepare() : {allowed: true};
        },
        getCurrent: async () => {
            trace.push("current");
            return current();
        },
        start: async () => {
            trace.push("start");
            return options.start ? options.start() : success(activeTopicSession());
        },
        stop: async () => {
            trace.push("stop");
            return options.stop ? options.stop() : success(completedSession());
        },
        next: async (elementId, eventId) => {
            trace.push(`next:${elementId}:${eventId}`);
            return options.next ? options.next(elementId, eventId) : {
                ok: true,
                eventId,
                reviewAccepted: true,
                session: activeTopicSession(otherTopicId),
            };
        },
        createEventId: () => {
            const eventId = options.createEventId ? options.createEventId() : "event-007-next";
            trace.push(`id:${eventId}`);
            return eventId;
        },
        followTarget: async (elementId) => {
            trace.push(`follow:${elementId}`);
            return options.follow ? options.follow(elementId) : true;
        },
        publish: (projection) => projections.push(projection),
        runOperation: async (_name, callback) => ({
            started: true,
            value: await callback({isCancelled: false}),
        }),
    });
    return {
        coordinator,
        projections,
        trace,
        setCurrent(value: () => Promise<SessionCallResult>) {
            current = value;
        },
        setReadOnly(value: boolean) {
            readOnly = value;
        },
    };
};

describe("TopicLearningCoordinator US1", () => {
    it("queries Current on construction and projects a matching Topic without Start or navigation", async () => {
        const harness = createHarness();
        await harness.coordinator.initialized;

        assert.deepEqual(harness.trace, ["current"]);
        assert.equal(harness.projections.at(-1)?.phase, "activeTopic");
        assert.equal(harness.projections.at(-1)?.primaryAction, "next");
    });

    it("returns from a preview only after target-change preparation", async () => {
        const harness = createHarness({current: async () => success(activeTopicSession(otherTopicId))});
        await harness.coordinator.initialized;
        harness.trace.length = 0;

        await harness.coordinator.learn();

        assert.deepEqual(harness.trace, ["current", "prepare:target-change", `follow:${otherTopicId}`]);
        assert.equal(harness.projections.at(-1)?.phase, "preview");
    });

    it("keeps preview navigation controls busy until target following settles", async () => {
        const follow = deferred<boolean>();
        const harness = createHarness({
            current: async () => success(activeTopicSession(otherTopicId)),
            follow: async () => follow.promise,
        });
        await harness.coordinator.initialized;

        const pending = harness.coordinator.learn();
        while (!harness.trace.some((item) => item.startsWith("follow:"))) await new Promise(setImmediate);

        assert.equal(harness.projections.at(-1)?.phase, "busy");
        assert.equal(harness.projections.at(-1)?.primaryAction, undefined);

        follow.resolve(true);
        await pending;
        assert.equal(harness.projections.at(-1)?.phase, "preview");
        assert.equal(harness.projections.at(-1)?.primaryAction, "learn");
    });

    it("starts a completed session only after target-change preparation and follows another Topic", async () => {
        const harness = createHarness({
            current: async () => success(completedSession()),
            start: async () => success(activeTopicSession(otherTopicId)),
        });
        await harness.coordinator.initialized;
        harness.trace.length = 0;

        await harness.coordinator.learn();

        assert.deepEqual(harness.trace, ["current", "prepare:target-change", "start", `follow:${otherTopicId}`]);
    });

    it("projects no-due and unsupported Alpha states without inventing Item actions", async () => {
        const noDue = createHarness({
            current: async () => success(completedSession()),
            start: async () => success(completedSession()),
        });
        await noDue.coordinator.initialized;
        await noDue.coordinator.learn();
        assert.equal(noDue.projections.at(-1)?.phase, "noDue");

        const unsupported = createHarness({current: async () => success({
            sessionId: "session-item",
            status: "active",
            stage: "outstanding",
            phase: "answer",
            current: {kind: "element.item", elementId: "item-007"},
            remainingElementIds: [],
        })});
        await unsupported.coordinator.initialized;
        assert.deepEqual(unsupported.projections.at(-1), {
            phase: "unsupportedSession",
            secondaryAction: "stop",
            busy: false,
            messageKey: "symemoUnsupportedLearningStage",
            displayedElementId: topicId,
        });
        await unsupported.coordinator.stop();
        assert.deepEqual(unsupported.trace.slice(-2), ["current", "stop"]);
        assert.equal(unsupported.projections.at(-1)?.phase, "idle");
    });

    it("sends no Start or navigation when authoring preparation blocks", async () => {
        const harness = createHarness({
            current: async () => success(completedSession()),
            prepare: async () => ({allowed: false, reason: "conflict"}),
        });
        await harness.coordinator.initialized;
        harness.trace.length = 0;

        await harness.coordinator.learn();

        assert.deepEqual(harness.trace, ["current", "prepare:target-change"]);
        assert.equal(harness.projections.at(-1)?.phase, "failure");
    });

    it("serializes duplicate activation and makes a late result inert after destroy", async () => {
        const request = deferred<SessionCallResult>();
        const harness = createHarness();
        await harness.coordinator.initialized;
        harness.trace.length = 0;
        harness.setCurrent(() => request.promise);
        const first = harness.coordinator.learn();
        const second = harness.coordinator.learn();

        assert.equal(harness.trace.filter((item) => item === "current").length, 1);
        harness.coordinator.destroy();
        request.resolve(success(activeTopicSession(otherTopicId)));
        await Promise.all([first, second]);

        assert.equal(harness.trace.includes(`follow:${otherTopicId}`), false);
    });
});

describe("TopicLearningCoordinator US2", () => {
    it("orders Current, target-change preparation, one identity, Next, and different-target follow", async () => {
        const harness = createHarness();
        await harness.coordinator.initialized;
        harness.trace.length = 0;

        await harness.coordinator.next();

        assert.deepEqual(harness.trace, [
            "current",
            "prepare:target-change",
            "id:event-007-next",
            `next:${topicId}:event-007-next`,
            `follow:${otherTopicId}`,
        ]);
    });

    it("suppresses duplicate Next activation and creates one event identity", async () => {
        const request = deferred<TopicNextCallResult>();
        let ids = 0;
        const harness = createHarness({
            createEventId: () => `event-${++ids}`,
            next: () => request.promise,
        });
        await harness.coordinator.initialized;
        harness.trace.length = 0;
        const first = harness.coordinator.next();
        const second = harness.coordinator.next();
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(ids, 1);
        assert.equal(harness.trace.filter((item) => item.startsWith("next:")).length, 1);
        request.resolve({
            ok: true,
            eventId: "event-1",
            reviewAccepted: true,
            session: activeTopicSession(topicId),
        });
        await Promise.all([first, second]);
        assert.equal(harness.trace.some((item) => item.startsWith("follow:")), false);
        assert.equal(harness.projections.at(-1)?.phase, "activeTopic");
    });

    it("reconciles an accepted same-target identity so the authoritative Next remains actionable", async () => {
        let ids = 0;
        const harness = createHarness({
            createEventId: () => `event-${++ids}`,
            next: async (_elementId, eventId) => ({
                ok: true,
                eventId,
                reviewAccepted: true,
                session: activeTopicSession(topicId),
            }),
        });
        await harness.coordinator.initialized;

        await harness.coordinator.next();
        await harness.coordinator.next();

        assert.equal(ids, 2);
        assert.equal(harness.projections.at(-1)?.primaryAction, "next");
        assert.equal(harness.projections.at(-1)?.messageKey, "symemoTopicReviewSaved");
    });

    it("projects completion without navigation after accepted Next", async () => {
        const harness = createHarness({
            next: async (_elementId, eventId) => ({
                ok: true,
                eventId,
                reviewAccepted: true,
                session: completedSession(),
            }),
        });
        await harness.coordinator.initialized;
        harness.trace.length = 0;

        await harness.coordinator.next();

        assert.equal(harness.projections.at(-1)?.phase, "completed");
        assert.equal(harness.projections.at(-1)?.primaryAction, "learn");
        assert.equal(harness.trace.some((item) => item.startsWith("follow:")), false);
    });
});

describe("TopicLearningCoordinator US3", () => {
    it("retries a pre-acceptance failure with the same identity", async () => {
        let calls = 0;
        let ids = 0;
        const harness = createHarness({
            createEventId: () => `event-${++ids}`,
            next: async (_elementId, eventId) => ++calls === 1 ? {
                ok: false,
                failure: {
                    errorCode: "durable-write-failed",
                    retryable: true,
                    acceptance: "notAccepted",
                    acceptedEventId: eventId,
                    kind: "domain",
                },
            } : {ok: true, eventId, reviewAccepted: true, session: completedSession()},
        });
        await harness.coordinator.initialized;
        harness.trace.length = 0;

        await harness.coordinator.next();
        assert.equal(harness.projections.at(-1)?.phase, "retryableNext");
        await harness.coordinator.retryNext();

        assert.equal(ids, 1);
        assert.deepEqual(harness.trace.filter((item) => item.startsWith("next:")), [
            `next:${topicId}:event-1`,
            `next:${topicId}:event-1`,
        ]);
        assert.equal(harness.projections.at(-1)?.phase, "completed");
    });

    it("reconciles a stale retry against Current and follows without resubmitting", async () => {
        const harness = createHarness({next: async (_elementId, eventId) => ({
            ok: false,
            failure: {
                errorCode: "durable-write-failed",
                retryable: true,
                acceptance: "notAccepted",
                acceptedEventId: eventId,
                kind: "domain",
            },
        })});
        await harness.coordinator.initialized;
        await harness.coordinator.next();
        harness.setCurrent(async () => success(activeTopicSession(otherTopicId)));
        harness.trace.length = 0;

        await harness.coordinator.retryNext();

        assert.deepEqual(harness.trace, ["current", "prepare:target-change", `follow:${otherTopicId}`]);
    });

    it("continues an accepted queue failure with the same identity only", async () => {
        let calls = 0;
        const harness = createHarness({next: async (_elementId, eventId) => ++calls === 1 ? {
            ok: false,
            failure: {
                errorCode: "queue-advance-failed",
                retryable: true,
                acceptance: "accepted",
                acceptedEventId: eventId,
                session: {...activeTopicSession(), pendingAcceptedEventId: eventId},
                kind: "domain",
            },
        } : {ok: true, eventId, reviewAccepted: true, session: activeTopicSession(otherTopicId)}});
        await harness.coordinator.initialized;
        harness.trace.length = 0;

        await harness.coordinator.next();
        assert.equal(harness.projections.at(-1)?.phase, "acceptedNotAdvanced");
        await harness.coordinator.continueNext();

        assert.deepEqual(harness.trace.filter((item) => item.startsWith("next:")), [
            `next:${topicId}:event-007-next`,
            `next:${topicId}:event-007-next`,
        ]);
        assert.equal(harness.trace.at(-1), `follow:${otherTopicId}`);
    });

    it("keeps accepted target navigation controls busy until presentation settles", async () => {
        const follow = deferred<boolean>();
        const harness = createHarness({follow: async () => follow.promise});
        await harness.coordinator.initialized;

        const pending = harness.coordinator.next();
        while (!harness.trace.some((item) => item.startsWith("follow:"))) await new Promise(setImmediate);

        assert.equal(harness.projections.at(-1)?.phase, "busy");
        assert.equal(harness.projections.at(-1)?.primaryAction, undefined);

        follow.resolve(true);
        await pending;
        assert.equal(harness.projections.at(-1)?.phase, "preview");
        assert.equal(harness.projections.at(-1)?.primaryAction, "learn");
    });

    it("keeps accepted queue recovery monotonic when a Continue response is lost", async () => {
        let calls = 0;
        const harness = createHarness({next: async (_elementId, eventId) => {
            calls++;
            if (calls === 1) {
                return {
                    ok: false,
                    failure: {
                        errorCode: "queue-advance-failed",
                        retryable: true,
                        acceptance: "accepted",
                        acceptedEventId: eventId,
                        session: {...activeTopicSession(), pendingAcceptedEventId: eventId},
                        kind: "domain",
                    },
                };
            }
            if (calls === 2) {
                return {
                    ok: false,
                    failure: {
                        errorCode: "request",
                        retryable: true,
                        acceptance: "unknown",
                        kind: "request",
                    },
                };
            }
            return {ok: true, eventId, reviewAccepted: true, session: completedSession()};
        }});
        await harness.coordinator.initialized;

        await harness.coordinator.next();
        await harness.coordinator.continueNext();

        assert.equal(harness.projections.at(-1)?.phase, "acceptedNotAdvanced");
        assert.equal(harness.projections.at(-1)?.primaryAction, "continue");
        assert.equal(harness.projections.at(-1)?.messageKey, "symemoTopicReviewSavedNotAdvanced");

        await harness.coordinator.continueNext();
        assert.deepEqual(harness.trace.filter((item) => item.startsWith("next:")), [
            `next:${topicId}:event-007-next`,
            `next:${topicId}:event-007-next`,
            `next:${topicId}:event-007-next`,
        ]);
        assert.equal(harness.projections.at(-1)?.phase, "completed");
    });

    it("holds accepted projection recovery and resumes without resubmitting the old identity", async () => {
        const harness = createHarness({
            current: async () => success(completedSession()),
            start: async () => success(activeTopicSession(otherTopicId)),
            next: async (_elementId, eventId) => ({
                ok: false,
                failure: {
                    errorCode: "projection-refresh-failed",
                    retryable: true,
                    acceptance: "accepted",
                    acceptedEventId: eventId,
                    session: activeTopicSession(),
                    kind: "domain",
                },
            }),
        });
        await harness.coordinator.initialized;
        harness.setCurrent(async () => success(activeTopicSession()));
        await harness.coordinator.next();
        assert.equal(harness.projections.at(-1)?.phase, "acceptedRecovering");
        const requests = harness.trace.filter((item) => item.startsWith("next:")).length;
        await harness.coordinator.next();
        assert.equal(harness.trace.filter((item) => item.startsWith("next:")).length, requests);

        harness.setCurrent(async () => success(completedSession()));
        harness.trace.length = 0;
        await harness.coordinator.resume();
        assert.deepEqual(harness.trace, ["current", "prepare:target-change", "start", `follow:${otherTopicId}`]);
    });

    it("retains accepted session after presentation failure and later Learn follows Current", async () => {
        let canFollow = false;
        const harness = createHarness({follow: async () => canFollow});
        await harness.coordinator.initialized;
        await harness.coordinator.next();
        assert.equal(harness.projections.at(-1)?.phase, "failure");
        canFollow = true;
        harness.setCurrent(async () => success(activeTopicSession(otherTopicId)));
        harness.trace.length = 0;

        await harness.coordinator.learn();

        assert.deepEqual(harness.trace, ["current", "prepare:target-change", `follow:${otherTopicId}`]);
    });

    it("never submits an old retry identity against a replacement session", async () => {
        const harness = createHarness({next: async (_elementId, eventId) => ({
            ok: false,
            failure: {
                errorCode: "durable-write-failed",
                retryable: true,
                acceptance: "notAccepted",
                acceptedEventId: eventId,
                kind: "domain",
            },
        })});
        await harness.coordinator.initialized;
        await harness.coordinator.next();
        harness.setCurrent(async () => success({...activeTopicSession(), sessionId: "session-008"}));
        harness.trace.length = 0;

        await harness.coordinator.retryNext();

        assert.equal(harness.trace.some((item) => item.startsWith("next:")), false);
        assert.equal(harness.projections.at(-1)?.messageKey, "symemoLearningStateChanged");
    });

    it("keeps history repair fail-closed without Resume or a replacement identity", async () => {
        let ids = 0;
        const harness = createHarness({
            createEventId: () => `event-${++ids}`,
            next: async (_elementId, eventId) => ({
                ok: false,
                failure: {
                    errorCode: "history-requires-repair",
                    retryable: false,
                    acceptance: "notAccepted",
                    acceptedEventId: eventId,
                    kind: "domain",
                },
            }),
        });
        await harness.coordinator.initialized;

        await harness.coordinator.next();
        assert.equal(harness.projections.at(-1)?.phase, "failure");
        assert.equal(harness.projections.at(-1)?.primaryAction, undefined);

        await harness.coordinator.resume();
        await harness.coordinator.learn();
        await harness.coordinator.next();

        assert.equal(ids, 1);
        assert.deepEqual(harness.trace.filter((item) => item.startsWith("next:")), [
            `next:${topicId}:event-1`,
        ]);
        assert.equal(harness.projections.at(-1)?.primaryAction, undefined);
    });

    it("hides Retry Next when the host becomes read-only before an unknown failure returns", async () => {
        const response = deferred<TopicNextCallResult>();
        const harness = createHarness({next: async () => response.promise});
        await harness.coordinator.initialized;

        const pending = harness.coordinator.next();
        while (!harness.trace.some((item) => item.startsWith("next:"))) await new Promise(setImmediate);
        harness.setReadOnly(true);
        response.resolve({
            ok: false,
            failure: {
                errorCode: "host-rejected",
                retryable: false,
                acceptance: "unknown",
                kind: "domain",
            },
        });
        await pending;

        assert.equal(harness.projections.at(-1)?.phase, "readOnly");
        assert.equal(harness.projections.at(-1)?.primaryAction, undefined);
        assert.equal(harness.projections.at(-1)?.secondaryAction, "stop");
        const requests = harness.trace.filter((item) => item.startsWith("next:")).length;
        await harness.coordinator.retryNext();
        assert.equal(harness.trace.filter((item) => item.startsWith("next:")).length, requests);
    });

    it("preserves a recoverable Current failure when eligibility is reprojected", async () => {
        const harness = createHarness({current: async () => ({
            ok: false,
            failure: {errorCode: "request", retryable: true, kind: "request"},
        })});
        await harness.coordinator.initialized;
        assert.equal(harness.projections.at(-1)?.phase, "failure");
        assert.equal(harness.projections.at(-1)?.primaryAction, "resume");

        harness.coordinator.reproject();

        assert.equal(harness.projections.at(-1)?.phase, "failure");
        assert.equal(harness.projections.at(-1)?.primaryAction, "resume");
    });
});
