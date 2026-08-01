import {beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {ItemReviewSurface} from "./ItemReviewSurface";
import {ItemAuthoringSession} from "./itemAuthoring";
import {importImages} from "./assetStore";
import {buildAssetFiles, buildAssetUploadResponse} from "./assetTestFixtures";
import type {LearningSessionProjection} from "./types";
import {TestDocument, TestElement} from "./testDom";
import {parse5TopicDom} from "./testTopicDom";

let documentFixture: TestDocument;
let container: TestElement;

beforeEach(() => {
    documentFixture = new TestDocument();
    container = documentFixture.createElement("div");
    (globalThis as unknown as {document: Document}).document = documentFixture as unknown as Document;
});

const question = (): LearningSessionProjection => ({
    sessionId: "feature-009",
    status: "active",
    stage: "outstanding",
    phase: "question",
    current: {
        kind: "element.item",
        elementId: "item-009",
        prompt: '<p>Prompt<img src="assets/prompt.png"></p>',
    },
    remainingElementIds: [],
});

describe("Feature 009 Item image integration", () => {
    it("keeps question transport and DOM answer-free, then reveals only captured answer HTML", () => {
        const surface = new ItemReviewSurface({
            container: container as unknown as HTMLElement,
            topicDomParser: parse5TopicDom,
        });
        surface.mount(question());
        assert.equal(container.querySelector('[data-role="item-question"]')?.innerHTML,
            '<p>Prompt<img src="assets/prompt.png"></p>');
        assert.equal(container.querySelector('[data-role="item-answer"]'), null);
        assert.equal(container.textContent.includes("answer.png"), false);

        surface.update({
            ...question(),
            phase: "answer",
            current: {
                kind: "element.item",
                elementId: "item-009",
                prompt: '<p>Prompt<img src="assets/prompt.png"></p>',
                answer: '<p>Answer<img src="assets/answer.png"></p>',
            },
        });
        assert.equal(container.querySelector('[data-role="item-answer"]')?.innerHTML,
            '<p>Answer<img src="assets/answer.png"></p>');
    });

    it("keeps an uploaded image local after Item save failure and protects only persisted references", async () => {
        const [file] = buildAssetFiles("draft.png");
        const upload = await importImages([file], {side: "prompt"}, async () => buildAssetUploadResponse({
            "draft.png": "assets/draft-native.png",
        }));
        assert.equal(upload.ok, true);
        if (!upload.ok) return;

        let submittedPrompt = "";
        let persistedPrompt = "";
        let acceptSave = false;
        const session = new ItemAuthoringSession({
            elementId: "item-009",
            getItemAuthoring: async () => ({
                ok: true,
                authoring: {
                    elementId: "item-009",
                    prompt: "<p>Question</p>",
                    answer: "<p>Answer</p>",
                    contentRevision: "rev-1",
                },
            }),
            saveItemQA: async (_elementId, _revision, prompt) => {
                submittedPrompt = prompt;
                if (!acceptSave) {
                    return {ok: false, failure: {kind: "failed", errorCode: "request", retryable: true, acceptanceUnknown: false}};
                }
                persistedPrompt = prompt;
                return {
                    ok: true,
                    change: {
                        kind: "SaveItemQA",
                        elementId: "item-009",
                        changedField: "itemQA",
                        revision: "rev-2",
                        itemQA: {prompt, answer: "<p>Answer</p>", contentRevision: "rev-2"},
                        changed: true,
                        changeAccepted: true,
                    },
                };
            },
            debounceMs: -1,
        });
        await session.load();
        const localPrompt = `<p>Question<img src="${upload.references[0]}"></p>`;
        session.editPrompt(localPrompt);

        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "save-failed"});
        assert.equal(session.snapshot().localPrompt, localPrompt);
        assert.equal(submittedPrompt, localPrompt);

        const afterFailedSave = [...upload.references, "assets/orphan.png"].filter((reference) => !persistedPrompt.includes(reference));
        assert.deepEqual(afterFailedSave, ["assets/draft-native.png", "assets/orphan.png"]);

        acceptSave = true;
        assert.equal(session.retry(), true);
        assert.deepEqual(await session.flush("tab-close"), {allowed: true});
        const afterAcceptedSave = [...upload.references, "assets/orphan.png"].filter((reference) => !persistedPrompt.includes(reference));
        assert.deepEqual(afterAcceptedSave, ["assets/orphan.png"]);
    });
});
