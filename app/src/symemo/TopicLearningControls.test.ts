import {beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {TopicLearningControls} from "./TopicLearningControls";
import type {LearningControlProjection, LearningPrimaryAction} from "./types";
import {TestDocument, TestElement} from "./testDom";

let documentFixture: TestDocument;
let container: TestElement;
let actions: string[];
let controls: TopicLearningControls;

const render = (projection: Partial<LearningControlProjection> & Pick<LearningControlProjection, "phase">) => {
    controls.render({
        busy: false,
        displayedElementId: "topic-007-a",
        ...projection,
    });
};

beforeEach(() => {
    documentFixture = new TestDocument();
    container = documentFixture.createElement("div");
    (globalThis as unknown as {document: Document}).document = documentFixture as unknown as Document;
    (globalThis as unknown as {window: Window}).window = {
        siyuan: {
            languages: {
                symemoLearn: "Learn",
                symemoNext: "Next",
                symemoLearningComplete: "Learning complete.",
                symemoRetryNext: "Retry Next",
                symemoContinueLearning: "Continue",
                symemoResumeLearning: "Resume learning",
                symemoTopicReviewFailed: "Unable to advance safely.",
                symemoTopicReviewSavedNotAdvanced: "Review saved; continue to advance.",
                symemoTopicReviewSavedRecovering: "Review saved; reconnecting...",
                symemoLearningStateChanged: "The learning session changed; refreshing...",
                symemoLearningUnavailable: "Learning is temporarily unavailable.",
                symemoEndLearning: "End learning",
                symemoLearningLoading: "Loading learning session...",
                symemoLearningBusy: "Updating learning session...",
                symemoLearningPreview: "Another Topic is active.",
                symemoNoDueTopics: "No due Topics.",
                symemoUnsupportedLearningStage: "Unsupported stage.",
                symemoLearningReadOnly: "Read-only.",
            },
        },
    } as unknown as Window;
    actions = [];
    controls = new TopicLearningControls({
        container: container as unknown as HTMLElement,
        onIntent: (action) => actions.push(action),
    });
});

describe("TopicLearningControls US1", () => {
    it("renders accessible Learn and Stop actions for idle and unsupported states", () => {
        render({phase: "idle", primaryAction: "learn"});
        const region = container;
        const learn = container.querySelector("button") as TestElement;
        assert.equal(region.getAttribute("role"), "region");
        assert.equal(region.getAttribute("aria-label"), "Learn");
        assert.equal(region.getAttribute("aria-busy"), "false");
        assert.equal(container.querySelector("[aria-live=\"polite\"]")?.textContent, "");
        assert.equal(learn.tagName, "BUTTON");
        assert.equal(learn.getAttribute("type"), "button");
        learn.dispatch("click");
        assert.deepEqual(actions, ["learn"]);

        render({
            phase: "unsupportedSession",
            secondaryAction: "stop",
            messageKey: "symemoUnsupportedLearningStage",
        });
        const stop = container.querySelector("button") as TestElement;
        assert.equal(stop.textContent, "End learning");
        stop.dispatch("click");
        assert.deepEqual(actions, ["learn", "stop"]);
    });

    it("projects loading, busy, preview, no-due, unsupported, and read-only messages", () => {
        const cases: Array<[LearningControlProjection["phase"], string, string]> = [
            ["loading", "symemoLearningLoading", "Loading learning session..."],
            ["busy", "symemoLearningBusy", "Updating learning session..."],
            ["preview", "symemoLearningPreview", "Another Topic is active."],
            ["noDue", "symemoNoDueTopics", "No due Topics."],
            ["unsupportedSession", "symemoUnsupportedLearningStage", "Unsupported stage."],
            ["readOnly", "symemoLearningReadOnly", "Read-only."],
        ];
        cases.forEach(([phase, messageKey, expected]) => {
            render({phase, messageKey});
            assert.equal(container.querySelector("[aria-live=\"polite\"]")?.textContent, expected);
        });
    });

    it("does not expose a Next action in US1 active-target projection", () => {
        render({phase: "activeTopic"});

        assert.equal(container.querySelector("button"), null);
        assert.equal(container.textContent.includes("Next"), false);
    });

    it("suppresses activation while busy", () => {
        const primaryActions: LearningPrimaryAction[] = ["learn"];
        render({phase: "busy", primaryAction: primaryActions[0], busy: true, messageKey: "symemoLearningBusy"});
        const button = container.querySelector("button") as TestElement;
        button.dispatch("click");

        assert.deepEqual(actions, []);
        assert.equal((button as unknown as {disabled: boolean}).disabled, true);
        assert.equal(container.getAttribute("aria-busy"), "true");
    });
});

describe("TopicLearningControls US2", () => {
    it("renders the first actionable Next and completion projection", () => {
        render({phase: "activeTopic", primaryAction: "next"});
        const next = container.querySelector("button") as TestElement;
        assert.equal(next.textContent, "Next");
        next.dispatch("click");
        assert.deepEqual(actions, ["next"]);

        render({
            phase: "completed",
            primaryAction: "learn",
            messageKey: "symemoLearningComplete",
        });
        assert.equal(container.querySelector("[aria-live=\"polite\"]")?.textContent, "Learning complete.");
        assert.equal(container.querySelector("button")?.textContent, "Learn");
    });
});

describe("TopicLearningControls US3", () => {
    it("renders only the recovery action owned by each retained-intent phase", () => {
        const cases: Array<[LearningControlProjection["phase"], LearningPrimaryAction, string, string]> = [
            ["retryableNext", "retryNext", "symemoTopicReviewFailed", "Retry Next"],
            ["acceptedNotAdvanced", "continue", "symemoTopicReviewSavedNotAdvanced", "Continue"],
            ["acceptedRecovering", "resume", "symemoTopicReviewSavedRecovering", "Resume learning"],
            ["failure", "resume", "symemoLearningUnavailable", "Resume learning"],
        ];
        cases.forEach(([phase, primaryAction, messageKey, label]) => {
            render({phase, primaryAction, messageKey});
            const button = container.querySelector("button") as TestElement;
            assert.equal(button.textContent, label);
            assert.equal(container.querySelector("[aria-live=\"polite\"]")?.textContent.length > 0, true);
            button.dispatch("click");
        });
        assert.deepEqual(actions, ["retryNext", "continue", "resume", "resume"]);
    });

    it("announces session changes without exposing raw event or backend identity", () => {
        render({
            phase: "failure",
            primaryAction: "resume",
            messageKey: "symemoLearningStateChanged",
        });
        const status = container.querySelector("[aria-live=\"polite\"]")?.textContent || "";
        assert.equal(status.includes("The learning session changed; refreshing..."), true);
        assert.equal(status.includes("event-"), false);
        assert.equal(status.includes("target-mismatch"), false);
    });
});
