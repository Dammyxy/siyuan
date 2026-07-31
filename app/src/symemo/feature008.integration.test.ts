import {beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {ItemReviewSurface} from "./ItemReviewSurface";
import {LearningControls} from "./LearningControls";
import {ElementLearningCoordinator} from "./learning";
import type {ItemGradeCallResult, LearningSessionProjection, SessionCallResult} from "./types";
import {TestDocument, TestElement} from "./testDom";

let documentFixture: TestDocument;
let content: TestElement;
let footer: TestElement;

beforeEach(() => {
    documentFixture = new TestDocument();
    content = documentFixture.createElement("div");
    footer = documentFixture.createElement("div");
    (globalThis as unknown as {document: Document}).document = documentFixture as unknown as Document;
});

describe("Feature 008 single Item tracer", () => {
    it("keeps 100 independent question DOM and accessibility snapshots answer-free", () => {
        for (let fixture = 0; fixture < 100; fixture++) {
            const surface = new ItemReviewSurface({container: content as unknown as HTMLElement});
            const answer = `private-answer-${fixture}`;
            surface.mount({
                sessionId: `privacy-${fixture}`,
                status: "active",
                stage: "pending",
                phase: "question",
                current: {kind: "element.item", elementId: `item-${fixture}`, prompt: `Question ${fixture}`},
                remainingElementIds: [],
            });
            assert.equal(content.querySelector('[data-role="item-answer"]'), null);
            assert.equal(content.querySelectorAll("[aria-label]").some((node) => node.getAttribute("aria-label")?.includes(answer)), false);
            assert.equal(content.querySelectorAll("[data-role]").some((node) => node.textContent.includes(answer)), false);
            surface.destroy();
        }
    });

    it("keeps the question private, reveals once, grades once, and declines Final Drill", () => {
        const actions: Array<{kind: string; rawGrade?: number}> = [];
        const surface = new ItemReviewSurface({container: content as unknown as HTMLElement});
        const controls = new LearningControls({
            container: footer as unknown as HTMLElement,
            language: (key: string) => key,
            onIntent: (action: {kind: string; rawGrade?: number}) => actions.push(action),
        });
        const question: LearningSessionProjection = {
            sessionId: "feature-008", status: "active", stage: "pending", phase: "question",
            current: {kind: "element.item", elementId: "item-008", prompt: "Question"}, remainingElementIds: [],
        };
        surface.mount(question);
        controls.render({phase: "activeItemQuestion", primaryAction: "showAnswer", busy: false, displayedElementId: "item-008"} as any);
        assert.equal(content.querySelector('[data-role="item-answer"]'), null);
        assert.equal(content.querySelectorAll("[aria-label]").some((node) => node.getAttribute("aria-label")?.includes("Answer")), false);

        const revealed: LearningSessionProjection = {
            ...question, phase: "answer",
            current: {kind: "element.item", elementId: "item-008", prompt: "Question", answer: "Answer"},
        };
        surface.update(revealed);
        controls.render({phase: "activeItemAnswer", busy: false, displayedElementId: "item-008", targetElementId: "item-008"} as any);
        (footer.querySelector('button[data-grade="2"]') as TestElement).dispatch("click");
        assert.deepEqual(actions, [{kind: "grade", rawGrade: 2}]);

        controls.render({phase: "finalDrillConfirmation", primaryAction: "declineFinalDrill", busy: false, displayedElementId: "item-008"} as any);
        assert.equal(footer.querySelector("[data-grade]"), null);
        assert.equal(footer.querySelectorAll("button").length, 1);
    });
});

describe("Feature 008 mixed Topic and Item tracer", () => {
    it("flushes type-native Surfaces, follows Current in one native tab, and keeps previews event-free", async () => {
        const nativeTabId = "native-element-tab";
        const trace: string[] = [];
        const formalEvents: string[] = [];
        let eventCounter = 0;
        let session: LearningSessionProjection = {
            sessionId: "mixed-session",
            status: "active",
            stage: "outstanding",
            phase: "question",
            current: {kind: "element.topic", elementId: "topic-current"},
            remainingElementIds: ["item-current"],
        };

        const coordinatorFor = (displayedElementId: string, kind: "topic" | "item") => {
            const controls: any[] = [];
            const presentations: any[] = [];
            const coordinator = new ElementLearningCoordinator({
                displayedElementId,
                getDisplayedEligibility: () => ({
                    known: true,
                    supportedTopic: kind === "topic",
                    supportedItem: kind === "item",
                    readOnly: false,
                    barrierActive: false,
                }),
                prepareTransition: async () => {
                    trace.push(`flush:${displayedElementId}`);
                    return {allowed: true as const};
                },
                getCurrent: async () => ({ok: true as const, session}),
                start: async () => ({ok: true as const, session}),
                stop: async () => ({ok: true as const, session}),
                showAnswer: async (elementId: string) => {
                    trace.push(`show:${elementId}`);
                    session = {
                        ...session,
                        phase: "answer",
                        current: {kind: "element.item", elementId, prompt: "Captured question", answer: "Captured answer"},
                    };
                    return {ok: true as const, session};
                },
                nextTopic: async (elementId: string, eventId: string) => {
                    trace.push(`next:${elementId}:${eventId}`);
                    formalEvents.push(eventId);
                    session = {
                        sessionId: "mixed-session",
                        status: "active",
                        stage: "outstanding",
                        phase: "question",
                        current: {kind: "element.item", elementId: "item-current", prompt: "Captured question"},
                        remainingElementIds: [],
                    };
                    return {ok: true as const, eventId, reviewAccepted: true as const, session};
                },
                gradeItem: async (elementId: string, eventId: string, rawGrade: number) => {
                    trace.push(`grade:${elementId}:${eventId}:${rawGrade}`);
                    formalEvents.push(eventId);
                    session = {status: "completed", stage: "completed", phase: "completed", remainingElementIds: []};
                    return {ok: true as const, eventId, rawGrade, reviewAccepted: true as const, session};
                },
                acceptStage: async () => ({ok: true as const, session}),
                declineStage: async () => ({ok: true as const, session}),
                createEventId: () => `mixed-event-${++eventCounter}`,
                followTarget: async (elementId: string) => {
                    trace.push(`follow:${elementId}:${nativeTabId}`);
                    return true;
                },
                publish: (projection: unknown) => controls.push(projection),
                publishPresentation: (presentation: unknown) => presentations.push(presentation),
                runOperation: async (_name: string, callback: (operation: {isCancelled: boolean}) => Promise<unknown>) => ({
                    started: true,
                    value: await callback({isCancelled: false}),
                }),
            } as ConstructorParameters<typeof ElementLearningCoordinator>[0] & {
                publishPresentation(presentation: unknown): void;
            });
            return {controls, coordinator, presentations};
        };

        const topic = coordinatorFor("topic-current", "topic");
        await topic.coordinator.initialized;
        assert.equal(topic.controls.at(-1)?.phase, "activeTopic");
        await topic.coordinator.next();
        assert.deepEqual(trace.slice(0, 3), [
            "flush:topic-current",
            "next:topic-current:mixed-event-1",
            `follow:item-current:${nativeTabId}`,
        ]);

        const item = coordinatorFor("item-current", "item");
        await item.coordinator.initialized;
        assert.equal(item.presentations.at(-1)?.kind, "activeItemReview");
        await item.coordinator.showAnswer();
        assert.equal(item.controls.at(-1)?.phase, "activeItemAnswer");
        await item.coordinator.grade(4);
        assert.equal(item.controls.at(-1)?.phase, "completed");
        assert.deepEqual(item.presentations.at(-1), {kind: "ordinary"});

        session = {
            sessionId: "mixed-preview-session",
            status: "active",
            stage: "outstanding",
            phase: "question",
            current: {kind: "element.topic", elementId: "topic-current"},
            remainingElementIds: [],
        };
        const previewEventCount = formalEvents.length;
        const preview = coordinatorFor("item-preview", "item");
        await preview.coordinator.initialized;
        assert.equal(preview.controls.at(-1)?.phase, "preview");
        assert.deepEqual(preview.presentations.at(-1), {kind: "ordinary"});
        await preview.coordinator.learn();
        assert.deepEqual(trace.slice(-2), ["flush:item-preview", `follow:topic-current:${nativeTabId}`]);
        assert.equal(formalEvents.length, previewEventCount);
        assert.deepEqual(formalEvents, ["mixed-event-1", "mixed-event-2"]);
    });
});

describe("Feature 008 recovery tracer", () => {
    const question = (): LearningSessionProjection => ({
        sessionId: "recovery-session",
        status: "active",
        stage: "outstanding",
        phase: "question",
        current: {kind: "element.item", elementId: "recovery-item", prompt: "Question"},
        remainingElementIds: [],
    });
    const answer = (): LearningSessionProjection => ({
        ...question(),
        phase: "answer",
        current: {kind: "element.item", elementId: "recovery-item", prompt: "Question", answer: "Answer"},
    });
    const completed = (): LearningSessionProjection => ({
        status: "completed", stage: "completed", phase: "completed", remainingElementIds: [],
    });

    const createTracer = (options: {
        initial?: LearningSessionProjection;
        showResults?: SessionCallResult[];
        gradeResults?: ItemGradeCallResult[];
    }) => {
        const events: string[] = [];
        const projections: any[] = [];
        let session = options.initial || answer();
        let ids = 0;
        let canFollow = true;
        const controls = new LearningControls({
            container: footer as unknown as HTMLElement,
            language: (key: string) => key,
            onIntent: (intent) => {
                if (intent.kind === "showAnswer") void coordinator.showAnswer();
                if (intent.kind === "grade") void coordinator.grade(intent.rawGrade);
                if (intent.kind === "continue") void coordinator.continueNext();
                if (intent.kind === "resume") void coordinator.resume();
                if (intent.kind === "learn") void coordinator.learn();
            },
        });
        const surface = new ItemReviewSurface({container: content as unknown as HTMLElement});
        const coordinator = new ElementLearningCoordinator({
            displayedElementId: "recovery-item",
            getDisplayedEligibility: () => ({
                known: true, supportedTopic: false, supportedItem: true, readOnly: false, barrierActive: false,
            }),
            prepareTransition: async () => ({allowed: true as const}),
            getCurrent: async () => ({ok: true as const, session}),
            start: async () => ({ok: true as const, session}),
            stop: async () => ({ok: true as const, session: completed()}),
            showAnswer: async () => {
                const result = options.showResults?.shift() || {ok: true as const, session: answer()};
                if (result.ok) session = result.session;
                return result;
            },
            gradeItem: async (elementId: string, eventId: string, rawGrade: number) => {
                events.push(`${elementId}:${eventId}:${rawGrade}`);
                const result = options.gradeResults?.shift();
                assert.ok(result, "unexpected grade request");
                if (result.ok) session = result.session;
                return result;
            },
            nextTopic: async () => { throw new Error("unexpected Topic Next"); },
            acceptStage: async () => ({ok: true as const, session}),
            declineStage: async () => ({ok: true as const, session}),
            createEventId: () => `recovery-event-${++ids}`,
            followTarget: async () => canFollow,
            publish: (projection) => {
                projections.push(projection);
                controls.render(projection);
            },
            publishPresentation: (presentation) => {
                if (presentation.kind === "activeItemReview") {
                    surface.mount({
                        sessionId: presentation.sessionId,
                        status: "active",
                        stage: session.stage,
                        phase: presentation.phase,
                        current: presentation.target,
                        remainingElementIds: session.remainingElementIds,
                    });
                }
            },
            runOperation: async <T>(_name: string, callback: (operation: {isCancelled: boolean}) => Promise<T>) => ({
                started: true,
                value: await callback({isCancelled: false}),
            }),
        });
        return {
            controls,
            coordinator,
            events,
            projections,
            setCanFollow(value: boolean) { canFollow = value; },
            setSession(value: LearningSessionProjection) { session = value; },
        };
    };

    it("keeps Show Answer failure question-only and allows a safe reveal retry", async () => {
        const test = createTracer({
            initial: question(),
            showResults: [
                {ok: false, failure: {errorCode: "request", retryable: true, kind: "request"}},
                {ok: true, session: answer()},
            ],
            gradeResults: [],
        });
        await test.coordinator.initialized;

        await test.coordinator.showAnswer();
        assert.equal(content.querySelector('[data-role="item-answer"]'), null);
        assert.equal(footer.querySelector("[data-grade]"), null);
        await test.coordinator.showAnswer();
        assert.equal(content.querySelector('[data-role="item-answer"]')?.textContent, "Answer");
    });

    it("retries a lost grade response and accepted queue continuation through the owning UI action only", async () => {
        const test = createTracer({gradeResults: [
            {ok: false, failure: {errorCode: "request", retryable: true, acceptance: "unknown", kind: "request"}},
            {
                ok: false,
                failure: {
                    errorCode: "queue-advance-failed",
                    retryable: true,
                    acceptance: "accepted",
                    acceptedEventId: "recovery-event-1",
                    session: {...answer(), pendingAcceptedEventId: "recovery-event-1"},
                    kind: "domain",
                },
            },
            {
                ok: true,
                eventId: "recovery-event-1",
                rawGrade: 2,
                reviewAccepted: true,
                session: completed(),
            },
        ]});
        await test.coordinator.initialized;

        await test.coordinator.grade(2);
        (footer.querySelector("button") as TestElement).dispatch("click");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(footer.querySelector("button")?.textContent, "symemoContinueLearning");
        (footer.querySelector("button") as TestElement).dispatch("click");
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.deepEqual(test.events, [
            "recovery-item:recovery-event-1:2",
            "recovery-item:recovery-event-1:2",
            "recovery-item:recovery-event-1:2",
        ]);
        assert.equal(footer.querySelector("[data-grade]"), null);
    });

    it("holds accepted projection recovery and never repeats a grade after presentation failure", async () => {
        const next: LearningSessionProjection = {
            ...question(),
            current: {kind: "element.item", elementId: "next-item", prompt: "Next"},
        };
        const projection = createTracer({gradeResults: [{
            ok: false,
            failure: {
                errorCode: "projection-refresh-failed",
                retryable: true,
                acceptance: "accepted",
                acceptedEventId: "recovery-event-1",
                kind: "domain",
            },
        }]});
        await projection.coordinator.initialized;
        await projection.coordinator.grade(4);
        assert.equal(projection.projections.at(-1)?.phase, "acceptedRecovering");
        assert.equal(footer.querySelector("[data-grade]"), null);
        projection.setSession(completed());
        await projection.coordinator.resume();
        assert.deepEqual(projection.events, ["recovery-item:recovery-event-1:4"]);

        content.replaceChildren();
        footer.replaceChildren();
        const presentation = createTracer({gradeResults: [{
            ok: true,
            eventId: "recovery-event-1",
            rawGrade: 5,
            reviewAccepted: true,
            session: next,
        }]});
        await presentation.coordinator.initialized;
        presentation.setCanFollow(false);
        await presentation.coordinator.grade(5);
        assert.equal(presentation.projections.at(-1)?.phase, "failure");
        presentation.setCanFollow(true);
        presentation.setSession(next);
        await presentation.coordinator.learn();
        assert.deepEqual(presentation.events, ["recovery-item:recovery-event-1:5"]);
    });

    it("keeps 100 rapid/retry/accepted-failure fixtures on one Item event identity", async () => {
        const acceptedEventIds: string[] = [];
        for (let fixture = 0; fixture < 100; fixture++) {
            const elementId = `recovery-item-${fixture}`;
            const eventId = `recovery-event-${fixture}`;
            const calls: string[] = [];
            let current: LearningSessionProjection = {
                sessionId: `recovery-session-${fixture}`,
                status: "active",
                stage: "outstanding",
                phase: "answer",
                current: {kind: "element.item", elementId, prompt: "Question", answer: "Answer"},
                remainingElementIds: [],
            };
            const coordinator = new ElementLearningCoordinator({
                displayedElementId: elementId,
                getDisplayedEligibility: () => ({known: true, supportedTopic: false, supportedItem: true, readOnly: false, barrierActive: false}),
                prepareTransition: async () => ({allowed: true as const}),
                getCurrent: async () => ({ok: true as const, session: current}),
                start: async () => ({ok: true as const, session: current}),
                stop: async () => ({ok: true as const, session: completed()}),
                showAnswer: async () => ({ok: true as const, session: current}),
                gradeItem: async (_id, submittedEventId, rawGrade) => {
                    calls.push(`${submittedEventId}:${rawGrade}`);
                    if (calls.length === 1) {
                        return {
                            ok: false as const,
                            failure: {
                                errorCode: "queue-advance-failed", retryable: true, acceptance: "accepted" as const,
                                acceptedEventId: submittedEventId, session: {...current, pendingAcceptedEventId: submittedEventId}, kind: "domain" as const,
                            },
                        };
                    }
                    current = completed();
                    return {ok: true as const, eventId: submittedEventId, rawGrade: rawGrade as 0 | 1 | 2 | 3 | 4 | 5, reviewAccepted: true as const, session: current};
                },
                nextTopic: async () => { throw new Error("unexpected Topic Next"); },
                acceptStage: async () => ({ok: true as const, session: current}),
                declineStage: async () => ({ok: true as const, session: current}),
                createEventId: () => eventId,
                followTarget: async () => true,
                publish: () => undefined,
                publishPresentation: () => undefined,
                runOperation: async (_name, callback) => ({started: true, value: await callback({isCancelled: false})}),
            });
            await coordinator.initialized;
            const first = coordinator.grade(fixture % 6);
            const second = coordinator.grade((fixture + 1) % 6);
            await Promise.all([first, second]);
            await coordinator.continueNext();
            assert.deepEqual(calls, [`${eventId}:${fixture % 6}`, `${eventId}:${fixture % 6}`]);
            acceptedEventIds.push(eventId);
            coordinator.destroy();
        }
        assert.equal(new Set(acceptedEventIds).size, 100);
    });
});
