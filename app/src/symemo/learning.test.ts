import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {ElementLearningCoordinator} from "./learning";
import type {ItemGradeCallResult, LearningSessionProjection} from "./types";

const itemId = "item-alpha";
const question = (): LearningSessionProjection => ({
    sessionId: "session-alpha",
    status: "active",
    stage: "outstanding",
    phase: "question",
    current: {kind: "element.item", elementId: itemId, prompt: "Question"},
    remainingElementIds: [],
});
const answer = (): LearningSessionProjection => ({
    ...question(),
    phase: "answer",
    current: {kind: "element.item", elementId: itemId, prompt: "Question", answer: "Answer"},
});
const completed = (): LearningSessionProjection => ({status: "completed", stage: "completed", phase: "completed", remainingElementIds: []});

const harness = (initial = question(), readOnly = false) => {
    const trace: string[] = [];
    const projections: any[] = [];
    let current = initial;
    let nextEvent = 0;
    const coordinator = new ElementLearningCoordinator({
        displayedElementId: itemId,
        getDisplayedEligibility: () => ({known: true, supportedTopic: false, supportedItem: true, readOnly, barrierActive: false}),
        prepareTransition: async () => ({allowed: true as const}),
        getCurrent: async () => { trace.push("current"); return {ok: true as const, session: current}; },
        start: async () => { trace.push("start"); return {ok: true as const, session: current}; },
        stop: async () => { trace.push("stop"); current = completed(); return {ok: true as const, session: current}; },
        showAnswer: async (elementId: string) => {
            trace.push(`show:${elementId}`);
            current = answer();
            return {ok: true as const, session: current};
        },
        gradeItem: async (elementId: string, eventId: string, rawGrade: number) => {
            trace.push(`grade:${elementId}:${eventId}:${rawGrade}`);
            current = completed();
            return {ok: true as const, eventId, rawGrade: rawGrade as 0 | 1 | 2 | 3 | 4 | 5, reviewAccepted: true as const, session: current};
        },
        nextTopic: async () => { throw new Error("Topic Next is not available for an Item"); },
        acceptStage: async (stage: string) => { trace.push(`accept:${stage}`); return {ok: true as const, session: current}; },
        declineStage: async (stage: string) => { trace.push(`decline:${stage}`); current = completed(); return {ok: true as const, session: current}; },
        createEventId: () => `event-${++nextEvent}`,
        followTarget: async () => true,
        publish: (projection: unknown) => projections.push(projection),
        publishPresentation: () => undefined,
        runOperation: async <T>(_name: string, callback: (operation: {isCancelled: boolean}) => Promise<T>) => ({
            started: true,
            value: await callback({isCancelled: false}),
        }),
    });
    return {coordinator, projections, trace, setCurrent: (session: LearningSessionProjection) => { current = session; }};
};

describe("ElementLearningCoordinator Item flow", () => {
    it("reads Current before Show Answer and projects the captured answer", async () => {
        const test = harness();
        await test.coordinator.initialized;
        assert.equal(test.projections.at(-1)?.phase, "activeItemQuestion");
        test.trace.length = 0;
        await test.coordinator.showAnswer();
        assert.deepEqual(test.trace, ["current", `show:${itemId}`]);
        assert.equal(test.projections.at(-1)?.phase, "activeItemAnswer");
        assert.equal(test.projections.at(-1)?.session.current.answer, "Answer");
    });

    it("uses one retained formal-review identity and exact raw grade 0..5", async () => {
        for (const rawGrade of [0, 1, 2, 3, 4, 5] as const) {
            const test = harness(answer());
            await test.coordinator.initialized;
            test.trace.length = 0;
            await test.coordinator.grade(rawGrade);
            assert.deepEqual(test.trace, ["current", `grade:${itemId}:event-1:${rawGrade}`]);
            assert.equal(test.projections.at(-1)?.phase, "completed");
        }
    });

    it("projects Pending confirmation and Final Drill as decline-only", async () => {
        const pending: LearningSessionProjection = {
            sessionId: "session-alpha", status: "active", stage: "pending", phase: "confirmation", remainingElementIds: [],
        };
        const test = harness(pending);
        await test.coordinator.initialized;
        assert.equal(test.projections.at(-1)?.phase, "pendingConfirmation");

        test.setCurrent({...pending, stage: "finalDrill"});
        await test.coordinator.refresh();
        assert.equal(test.projections.at(-1)?.phase, "finalDrillConfirmation");
        assert.equal(test.projections.at(-1)?.primaryAction, "declineFinalDrill");
        assert.equal("gradeDrill" in test.coordinator, false);
    });

    it("fails closed when an unexpected active Final Drill Item target is returned", async () => {
        const questionTest = harness({...question(), stage: "finalDrill"});
        await questionTest.coordinator.initialized;
        assert.equal(questionTest.projections.at(-1)?.phase, "unsupportedSession");
        assert.equal(questionTest.projections.at(-1)?.secondaryAction, "stop");
        questionTest.trace.length = 0;
        await questionTest.coordinator.showAnswer();
        assert.deepEqual(questionTest.trace, ["current"]);

        const answerTest = harness({...answer(), stage: "finalDrill"});
        await answerTest.coordinator.initialized;
        assert.equal(answerTest.projections.at(-1)?.phase, "unsupportedSession");
        answerTest.trace.length = 0;
        await answerTest.coordinator.grade(3);
        assert.deepEqual(answerTest.trace, ["current"]);
    });

    it("fails closed in read-only mode without revealing or grading", async () => {
        const test = harness(question(), true);
        await test.coordinator.initialized;
        assert.equal(test.projections.at(-1)?.phase, "readOnly");
        await test.coordinator.showAnswer();
        assert.deepEqual(test.trace, ["current"]);
    });
});

describe("ElementLearningCoordinator mixed presentation", () => {
    const mixedHarness = (options: {
        displayedElementId: string;
        supportedTopic: boolean;
        supportedItem: boolean;
        current: LearningSessionProjection;
    }) => {
        const controls: any[] = [];
        const presentations: any[] = [];
        const trace: string[] = [];
        let current = options.current;
        const coordinator = new ElementLearningCoordinator({
            displayedElementId: options.displayedElementId,
            getDisplayedEligibility: () => ({
                known: true,
                supportedTopic: options.supportedTopic,
                supportedItem: options.supportedItem,
                readOnly: false,
                barrierActive: false,
            }),
            prepareTransition: async () => {
                trace.push("prepare");
                return {allowed: true as const};
            },
            getCurrent: async () => ({ok: true as const, session: current}),
            start: async () => ({ok: true as const, session: current}),
            stop: async () => ({ok: true as const, session: completed()}),
            showAnswer: async () => ({ok: true as const, session: current}),
            gradeItem: async (_elementId: string, eventId: string, rawGrade: number) => ({
                ok: true as const,
                eventId,
                rawGrade,
                reviewAccepted: true as const,
                session: completed(),
            }),
            nextTopic: async (_elementId: string, eventId: string) => ({
                ok: true as const,
                eventId,
                reviewAccepted: true as const,
                session: completed(),
            }),
            acceptStage: async () => ({ok: true as const, session: current}),
            declineStage: async () => ({ok: true as const, session: current}),
            createEventId: () => "mixed-event",
            followTarget: async (elementId: string) => {
                trace.push(`follow:${elementId}`);
                return true;
            },
            publish: (projection: unknown) => controls.push(projection),
            publishPresentation: (presentation: unknown) => presentations.push(presentation),
        runOperation: async <T>(_name: string, callback: (operation: {isCancelled: boolean}) => Promise<T>) => ({
            started: true,
            value: await callback({isCancelled: false}),
        }),
        } as ConstructorParameters<typeof ElementLearningCoordinator>[0] & {
            publishPresentation(presentation: unknown): void;
        });
        return {
            controls,
            coordinator,
            presentations,
            trace,
            setCurrent: (session: LearningSessionProjection) => {
                current = session;
            },
        };
    };

    it("selects target-native actions and publishes only the matching content presentation", async () => {
        const topic = mixedHarness({
            displayedElementId: "topic-alpha",
            supportedTopic: true,
            supportedItem: false,
            current: {
                sessionId: "mixed-session",
                status: "active",
                stage: "outstanding",
                phase: "question",
                current: {kind: "element.topic", elementId: "topic-alpha"},
                remainingElementIds: ["item-alpha"],
            },
        });
        await topic.coordinator.initialized;
        assert.equal(topic.controls.at(-1)?.phase, "activeTopic");
        assert.deepEqual(topic.presentations.at(-1), {kind: "ordinary"});

        const item = mixedHarness({
            displayedElementId: "item-alpha",
            supportedTopic: false,
            supportedItem: true,
            current: question(),
        });
        await item.coordinator.initialized;
        assert.equal(item.controls.at(-1)?.phase, "activeItemQuestion");
        assert.equal(item.presentations.at(-1)?.kind, "activeItemReview");
        assert.equal(item.presentations.at(-1)?.target.elementId, "item-alpha");
    });

    it("keeps a preview ordinary and prepares it before Learn returns to Current", async () => {
        const preview = mixedHarness({
            displayedElementId: "item-preview",
            supportedTopic: false,
            supportedItem: true,
            current: question(),
        });
        await preview.coordinator.initialized;
        assert.equal(preview.controls.at(-1)?.phase, "preview");
        assert.deepEqual(preview.presentations.at(-1), {kind: "ordinary"});

        await preview.coordinator.learn();

        assert.deepEqual(preview.trace, ["prepare", "follow:item-alpha"]);
    });

    it("fails closed on target-kind mismatch and restores ordinary presentation on completion", async () => {
        const mismatch = mixedHarness({
            displayedElementId: "item-alpha",
            supportedTopic: false,
            supportedItem: true,
            current: {
                sessionId: "mixed-session",
                status: "active",
                stage: "outstanding",
                phase: "question",
                current: {kind: "element.topic", elementId: "item-alpha"},
                remainingElementIds: [],
            },
        });
        await mismatch.coordinator.initialized;
        assert.equal(mismatch.controls.at(-1)?.phase, "unsupportedSession");
        assert.deepEqual(mismatch.presentations.at(-1), {kind: "ordinary"});

        mismatch.setCurrent(completed());
        await mismatch.coordinator.refresh();
        assert.equal(mismatch.controls.at(-1)?.phase, "idle");
        assert.deepEqual(mismatch.presentations.at(-1), {kind: "ordinary"});
    });
});

describe("ElementLearningCoordinator Item recovery", () => {
    const createRecoveryHarness = (results: ItemGradeCallResult[]) => {
        const projections: any[] = [];
        const trace: string[] = [];
        let current = answer();
        let ids = 0;
        let canFollow = true;
        const coordinator = new ElementLearningCoordinator({
            displayedElementId: itemId,
            getDisplayedEligibility: () => ({
                known: true,
                supportedTopic: false,
                supportedItem: true,
                readOnly: false,
                barrierActive: false,
            }),
            prepareTransition: async () => ({allowed: true as const}),
            getCurrent: async () => {
                trace.push("current");
                return {ok: true as const, session: current};
            },
            start: async () => {
                trace.push("start");
                return {ok: true as const, session: current};
            },
            stop: async () => ({ok: true as const, session: completed()}),
            showAnswer: async () => ({ok: true as const, session: current}),
            gradeItem: async (elementId: string, eventId: string, rawGrade: number) => {
                trace.push(`grade:${elementId}:${eventId}:${rawGrade}`);
                const result = results.shift();
                assert.ok(result, "unexpected grade request");
                return result;
            },
            nextTopic: async () => { throw new Error("unexpected Topic Next"); },
            acceptStage: async () => ({ok: true as const, session: current}),
            declineStage: async () => ({ok: true as const, session: current}),
            createEventId: () => {
                ids++;
                return `event-${ids}`;
            },
            followTarget: async (elementId: string) => {
                trace.push(`follow:${elementId}`);
                return canFollow;
            },
            publish: (projection: unknown) => projections.push(projection),
            publishPresentation: () => undefined,
            runOperation: async <T>(_name: string, callback: (operation: {isCancelled: boolean}) => Promise<T>) => ({
                started: true,
                value: await callback({isCancelled: false}),
            }),
        });
        return {
            coordinator,
            projections,
            trace,
            get ids() { return ids; },
            setCurrent: (session: LearningSessionProjection) => { current = session; },
            setCanFollow: (value: boolean) => { canFollow = value; },
        };
    };

    for (const acceptance of ["notAccepted", "unknown"] as const) {
        it(`retries an ${acceptance} grade with the same Item, event, session, and raw grade`, async () => {
            const test = createRecoveryHarness([{
                ok: false,
                failure: {
                    errorCode: acceptance === "unknown" ? "request" : "durable-write-failed",
                    retryable: true,
                    acceptance,
                    kind: acceptance === "unknown" ? "request" : "domain",
                },
            }, {
                ok: true,
                eventId: "event-1",
                rawGrade: 2,
                reviewAccepted: true,
                session: completed(),
            }]);
            await test.coordinator.initialized;
            test.trace.length = 0;

            await test.coordinator.grade(2);
            assert.equal(test.projections.at(-1)?.phase, "retryableReview");
            assert.equal(test.projections.at(-1)?.primaryAction, "resume");
            await test.coordinator.resume();

            assert.equal(test.ids, 1);
            assert.deepEqual(test.trace.filter((entry) => entry.startsWith("grade:")), [
                `grade:${itemId}:event-1:2`,
                `grade:${itemId}:event-1:2`,
            ]);
            assert.equal(test.projections.at(-1)?.phase, "completed");
        });
    }

    it("blocks a different raw grade and creates no new intent while a retry is retained", async () => {
        const test = createRecoveryHarness([{
            ok: false,
            failure: {errorCode: "request", retryable: true, acceptance: "unknown", kind: "request"},
        }]);
        await test.coordinator.initialized;
        await test.coordinator.grade(1);
        const gradeCalls = test.trace.filter((entry) => entry.startsWith("grade:")).length;

        await test.coordinator.grade(5);

        assert.equal(test.ids, 1);
        assert.equal(test.trace.filter((entry) => entry.startsWith("grade:")).length, gradeCalls);
        assert.equal(test.projections.at(-1)?.phase, "retryableReview");
    });

    it("continues an accepted queue failure with the exact retained grade intent", async () => {
        const retained = {...answer(), pendingAcceptedEventId: "event-1"};
        const test = createRecoveryHarness([{
            ok: false,
            failure: {
                errorCode: "queue-advance-failed",
                retryable: true,
                acceptance: "accepted",
                acceptedEventId: "event-1",
                session: retained,
                kind: "domain",
            },
        }, {
            ok: true,
            eventId: "event-1",
            rawGrade: 0,
            reviewAccepted: true,
            session: completed(),
        }]);
        await test.coordinator.initialized;
        test.trace.length = 0;

        await test.coordinator.grade(0);
        assert.equal(test.projections.at(-1)?.phase, "acceptedNotAdvanced");
        assert.equal(test.projections.at(-1)?.primaryAction, "continue");
        await test.coordinator.continueNext();

        assert.equal(test.ids, 1);
        assert.deepEqual(test.trace.filter((entry) => entry.startsWith("grade:")), [
            `grade:${itemId}:event-1:0`,
            `grade:${itemId}:event-1:0`,
        ]);
    });

    it("resumes accepted projection recovery through Current without resubmitting the grade", async () => {
        const test = createRecoveryHarness([{
            ok: false,
            failure: {
                errorCode: "projection-refresh-failed",
                retryable: true,
                acceptance: "accepted",
                acceptedEventId: "event-1",
                kind: "domain",
            },
        }]);
        await test.coordinator.initialized;
        test.trace.length = 0;

        await test.coordinator.grade(4);
        assert.equal(test.projections.at(-1)?.phase, "acceptedRecovering");
        test.setCurrent(completed());
        await test.coordinator.resume();

        assert.deepEqual(test.trace.filter((entry) => entry.startsWith("grade:")), [
            `grade:${itemId}:event-1:4`,
        ]);
        assert.equal(test.projections.at(-1)?.phase, "idle");
    });

    it("never resubmits an accepted grade after next-target presentation fails", async () => {
        const next: LearningSessionProjection = {
            ...question(),
            sessionId: "session-alpha",
            current: {kind: "element.item", elementId: "item-next", prompt: "Next"},
        };
        const test = createRecoveryHarness([{
            ok: true,
            eventId: "event-1",
            rawGrade: 5,
            reviewAccepted: true,
            session: next,
        }]);
        await test.coordinator.initialized;
        test.setCanFollow(false);
        test.trace.length = 0;

        await test.coordinator.grade(5);
        assert.equal(test.projections.at(-1)?.phase, "failure");
        test.setCanFollow(true);
        test.setCurrent(next);
        await test.coordinator.learn();

        assert.deepEqual(test.trace.filter((entry) => entry.startsWith("grade:")), [
            `grade:${itemId}:event-1:5`,
        ]);
        assert.equal(test.trace.filter((entry) => entry === "follow:item-next").length, 2);
    });

    it("reconciles a retained grade against a replacement session without submitting it", async () => {
        const test = createRecoveryHarness([{
            ok: false,
            failure: {errorCode: "request", retryable: true, acceptance: "unknown", kind: "request"},
        }]);
        await test.coordinator.initialized;
        await test.coordinator.grade(3);
        test.setCurrent({...answer(), sessionId: "replacement-session"});
        test.trace.length = 0;

        await test.coordinator.resume();

        assert.equal(test.trace.some((entry) => entry.startsWith("grade:")), false);
        assert.equal(test.projections.at(-1)?.messageKey, "symemoLearningStateChanged");
    });
});
