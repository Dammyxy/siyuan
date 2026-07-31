import {beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {LearningControls} from "./LearningControls";
import {TestDocument, TestElement} from "./testDom";

let documentFixture: TestDocument;
let container: TestElement;
let tabPanel: TestElement;
let actions: Array<{kind: string; rawGrade?: number}>;
let controls: LearningControls;

const languages: Record<string, string> = {
    symemoLearn: "Learn",
    symemoNext: "Next",
    symemoShowAnswer: "Show Answer",
    symemoGradeGreat: "5 Great",
    symemoGradeGood: "4 Good",
    symemoGradePass: "3 Pass",
    symemoGradeFail: "2 Fail",
    symemoGradeBad: "1 Bad",
    symemoGradeNull: "0 Null",
    symemoPendingConfirmation: "Continue with new material?",
    symemoAcceptPending: "Continue",
    symemoDeclinePending: "Skip new material",
    symemoContinueLearning: "Continue",
    symemoResumeLearning: "Resume learning",
    symemoFinalDrillDeferred: "Final Drill is not available in this version.",
    symemoEndLearning: "End learning",
    symemoLearningTargetPreview: "Another learning target is active.",
    symemoLearningReadOnly: "Learning changes are unavailable in read-only mode.",
    symemoUnsupportedLearningStage: "This learning stage is not available yet.",
};

const render = (values: Record<string, unknown>) => controls.render({
    phase: "idle",
    busy: false,
    displayedElementId: "item-alpha",
    ...values,
} as any);

beforeEach(() => {
    documentFixture = new TestDocument();
    container = documentFixture.createElement("div");
    tabPanel = documentFixture.createElement("div");
    tabPanel.append(container);
    (globalThis as unknown as {document: Document}).document = documentFixture as unknown as Document;
    actions = [];
    controls = new LearningControls({
        container: container as unknown as HTMLElement,
        language: (key: string) => languages[key] || key,
        onIntent: (action: {kind: string; rawGrade?: number}) => actions.push(action),
    });
});

describe("LearningControls Item review", () => {
    it("renders Show Answer for the question and exact visible grade order 5 4 3 2 1 for the answer", () => {
        render({phase: "activeItemQuestion", primaryAction: "showAnswer"});
        const reveal = container.querySelector("button") as TestElement;
        assert.equal(reveal.textContent, "Show Answer");
        reveal.dispatch("click");
        assert.deepEqual(actions, [{kind: "showAnswer"}]);

        render({phase: "activeItemAnswer"});
        const grades = container.querySelectorAll("button[data-grade]");
        assert.deepEqual(grades.map((button) => button.getAttribute("data-grade")), ["5", "4", "3", "2", "1"]);
        assert.deepEqual(grades.map((button) => button.title), ["5 Great", "4 Good", "3 Pass", "2 Fail", "1 Bad"]);
        assert.equal(container.querySelector('button[data-grade="0"]'), null);
        assert.equal(container.querySelector('[data-role="grade-null-assistive"]')?.textContent, "0 Null");
    });

    it("supports pointer 1..5 and keyboard-only 0 after reveal", () => {
        render({phase: "activeItemAnswer", targetElementId: "item-alpha"});
        (container.querySelector('button[data-grade="4"]') as TestElement).dispatch("click");
        render({phase: "activeItemAnswer", targetElementId: "item-alpha"});
        tabPanel.dispatch("keydown", {key: "0", code: "Digit0", target: container, preventDefault() {}});
        assert.deepEqual(actions, [{kind: "grade", rawGrade: 4}, {kind: "grade", rawGrade: 0}]);
    });

    it("handles grade digits from the active Element tab outside the sibling controls container", () => {
        render({phase: "activeItemAnswer", targetElementId: "item-alpha"});

        tabPanel.dispatch("keydown", {key: "3", target: tabPanel, preventDefault() {}});

        assert.deepEqual(actions, [{kind: "grade", rawGrade: 3}]);
    });

    it("suppresses grades while busy and before answer reveal", () => {
        render({phase: "activeItemQuestion", primaryAction: "showAnswer", busy: true});
        (container.querySelector("button") as TestElement).dispatch("click");
        tabPanel.dispatch("keydown", {key: "5", target: container, preventDefault() {}});
        assert.deepEqual(actions, []);
    });

    it("owns digits only for the active matching answer target outside editable or modified events", () => {
        render({phase: "activeItemAnswer", targetElementId: "item-alpha"});
        const textarea = documentFixture.createElement("textarea");
        const input = documentFixture.createElement("input");
        const button = documentFixture.createElement("button");
        const editable = documentFixture.createElement("div");
        editable.setAttribute("contenteditable", "true");
        for (const target of [textarea, input, button, editable]) {
            tabPanel.dispatch("keydown", {key: "3", target, preventDefault() {}});
        }
        for (const event of [
            {key: "3", target: container, ctrlKey: true},
            {key: "3", target: container, repeat: true},
            {key: "3", target: container, isComposing: true},
        ]) tabPanel.dispatch("keydown", {...event, target: tabPanel, preventDefault() {}});
        assert.deepEqual(actions, []);

        tabPanel.dispatch("keydown", {key: "3", target: tabPanel, preventDefault() {}});
        assert.deepEqual(actions, [{kind: "grade", rawGrade: 3}]);
    });

    it("projects Pending actions and only the deferred Final Drill exit", () => {
        render({phase: "pendingConfirmation"});
        assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), ["Continue", "Skip new material"]);
        render({phase: "finalDrillConfirmation", primaryAction: "declineFinalDrill"});
        assert.equal(container.querySelector('[aria-live="polite"]')?.textContent, "Final Drill is not available in this version.");
        assert.equal(container.querySelectorAll("button").length, 1);
        assert.equal(container.querySelector("[data-grade]"), null);
    });

    it("renders no controls from another target kind across mixed and closed states", () => {
        render({phase: "activeTopic", primaryAction: "next"});
        assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), ["Next"]);
        assert.equal(container.querySelector("[data-grade]"), null);

        render({phase: "activeItemQuestion", primaryAction: "showAnswer"});
        assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), ["Show Answer"]);

        render({phase: "preview", primaryAction: "learn"});
        assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), ["Learn"]);
        assert.equal(container.querySelector("[data-grade]"), null);

        render({phase: "readOnly", secondaryAction: "stop"});
        assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), ["End learning"]);

        render({phase: "unsupportedSession", secondaryAction: "stop"});
        assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), ["End learning"]);
    });

    it("rejects cross-kind actions and keeps preview, read-only, and unsupported messages specific", () => {
        render({phase: "activeTopic", primaryAction: "showAnswer"});
        assert.deepEqual(container.querySelectorAll("button"), []);

        render({phase: "activeItemQuestion", primaryAction: "next"});
        assert.deepEqual(container.querySelectorAll("button"), []);

        render({
            phase: "preview",
            primaryAction: "learn",
            messageKey: "symemoLearningTargetPreview",
        });
        assert.equal(container.querySelector('[aria-live="polite"]')?.textContent, "Another learning target is active.");
        assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), ["Learn"]);

        render({
            phase: "readOnly",
            primaryAction: "showAnswer",
            secondaryAction: "stop",
            messageKey: "symemoLearningReadOnly",
        });
        assert.equal(container.querySelector('[aria-live="polite"]')?.textContent, "Learning changes are unavailable in read-only mode.");
        assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), ["End learning"]);

        render({
            phase: "unsupportedSession",
            primaryAction: "next",
            secondaryAction: "stop",
            messageKey: "symemoUnsupportedLearningStage",
        });
        assert.equal(container.querySelector('[aria-live="polite"]')?.textContent, "This learning stage is not available yet.");
        assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), ["End learning"]);
    });

    it("exposes only the owning recovery action and never exposes a grade or new intent", () => {
        for (const recovery of [
            {phase: "retryableReview", primaryAction: "resume", label: "Resume learning"},
            {phase: "acceptedNotAdvanced", primaryAction: "continue", label: "Continue"},
            {phase: "acceptedRecovering", primaryAction: "resume", label: "Resume learning"},
        ]) {
            render(recovery);
            assert.deepEqual(container.querySelectorAll("button").map((button) => button.textContent), [recovery.label]);
            assert.equal(container.querySelector("[data-grade]"), null);
        }

        render({phase: "acceptedNotAdvanced", primaryAction: "resume"});
        assert.deepEqual(container.querySelectorAll("button"), []);
    });

    it("suppresses duplicate activation for a retained recovery intent", () => {
        render({phase: "acceptedNotAdvanced", primaryAction: "continue"});
        const button = container.querySelector("button") as TestElement;

        button.dispatch("click");
        button.dispatch("click");

        assert.deepEqual(actions, [{kind: "continue"}]);
    });
});
