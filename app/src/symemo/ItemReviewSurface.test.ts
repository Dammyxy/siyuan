import {beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {ItemReviewSurface} from "./ItemReviewSurface";
import type {LearningSessionProjection} from "./types";
import {TestDocument, TestElement} from "./testDom";

const question = (): LearningSessionProjection => ({
    sessionId: "session-item-review",
    status: "active",
    stage: "outstanding",
    phase: "question",
    current: {kind: "element.item", elementId: "item-review", prompt: "Question\n第二行"},
    remainingElementIds: [],
});

const answer = (): LearningSessionProjection => ({
    ...question(),
    phase: "answer",
    current: {...question().current!, kind: "element.item", prompt: "Question\n第二行", answer: "Answer\n第二行"},
});

let documentFixture: TestDocument;
let container: TestElement;

beforeEach(() => {
    documentFixture = new TestDocument();
    container = documentFixture.createElement("div");
    (globalThis as unknown as {document: Document}).document = documentFixture as unknown as Document;
});

describe("ItemReviewSurface", () => {
    it("renders multiline prompt text with no answer node, attribute, dataset, or accessibility text", () => {
        const surface = new ItemReviewSurface({container: container as unknown as HTMLElement});
        surface.mount(question());

        assert.equal(container.querySelector('[data-role="item-question"]')?.textContent, "Question\n第二行");
        assert.equal(container.querySelector('[data-role="item-answer"]'), null);
        assert.equal(container.textContent.includes("Answer"), false);
        assert.equal(container.querySelector("textarea"), null);
        assert.equal(container.querySelector("input"), null);
        assert.equal(container.querySelectorAll("[aria-label]").some((node) => node.getAttribute("aria-label")?.includes("Answer")), false);
    });

    it("reveals only the answer captured by an answer-phase session snapshot", () => {
        const surface = new ItemReviewSurface({container: container as unknown as HTMLElement});
        surface.mount(question());
        surface.update(answer());

        assert.equal(container.querySelector('[data-role="item-question"]')?.textContent, "Question\n第二行");
        assert.equal(container.querySelector('[data-role="item-answer"]')?.textContent, "Answer\n第二行");
        assert.deepEqual(surface.prepareTransition("target-change"), {allowed: true});
    });

    it("keeps the review text programmatically focusable and focuses the revealed answer", () => {
        const surface = new ItemReviewSurface({container: container as unknown as HTMLElement});
        surface.mount(question());
        const questionElement = container.querySelector('[data-role="item-question"]') as TestElement;
        assert.equal(questionElement.getAttribute("tabindex"), "-1");

        surface.update(answer());
        const answerElement = container.querySelector('[data-role="item-answer"]') as TestElement;
        assert.equal(answerElement.getAttribute("tabindex"), "-1");
        assert.equal(answerElement.focused, true);
    });

    it("uses no authoring transport and destroys idempotently", () => {
        const surface = new ItemReviewSurface({container: container as unknown as HTMLElement});
        surface.mount(answer());
        surface.destroy();
        surface.destroy();
        assert.equal(container.children.length, 0);
    });
});
