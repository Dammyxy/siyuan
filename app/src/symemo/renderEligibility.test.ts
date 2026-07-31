import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {getRenderDecision} from "./renderEligibility";
import type {ElementDetailView} from "./types";

const eligible = (overrides: Partial<ElementDetailView> = {}): ElementDetailView => ({
    elementId: "topic-id",
    type: "topic",
    title: "Topic",
    sourceMode: "html",
    supportStatus: "supported",
    topicMaterial: {
        kind: "html",
        html: "  <h1>Exact HTML</h1>  ",
        cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
    },
    ...overrides,
});

describe("getRenderDecision", () => {
    it("returns the exact untrimmed HTML only when every v1 predicate holds", () => {
        assert.deepEqual(getRenderDecision(eligible()), {
            kind: "renderedTopic",
            html: "  <h1>Exact HTML</h1>  ",
        });
    });

    it("fails closed for every partial eligibility predicate", () => {
        const cases: Array<[ElementDetailView, string]> = [
            [eligible({supportStatus: "unsupportedReadOnly"}), "unsupportedRead"],
            [eligible({type: "item"}), "unsupportedElementType"],
            [eligible({sourceMode: "block"}), "blockBackedTopic"],
            [eligible({sourceMode: "opaque"}), "unsupportedTopicMaterial"],
            [eligible({topicMaterial: undefined}), "unsupportedTopicMaterial"],
            [eligible({topicMaterial: {kind: "opaque"}}), "unsupportedTopicMaterial"],
            [eligible({topicMaterial: {kind: "html", html: "   ", cleaningPolicyVersion: "siyuanmemo-topic-html-v1"}}), "emptyTopicHTML"],
            [eligible({topicMaterial: {kind: "html", html: "<p>x</p>"}}), "unsupportedCleaningPolicy"],
            [eligible({topicMaterial: {kind: "html", html: "<p>x</p>", cleaningPolicyVersion: "future"}}), "unsupportedCleaningPolicy"],
        ];

        for (const [detail, reason] of cases) {
            assert.deepEqual(getRenderDecision(detail), {kind: "rendererUnavailable", reason});
        }
    });

    it("selects ordinary supported Q/A Items without exposing an answer", () => {
        const item: ElementDetailView = {
            elementId: "item-id",
            type: "item",
            title: "Question",
            sourceMode: "opaque",
            supportStatus: "supported",
            item: {
                kind: "qa",
                prompt: "Question",
                revision: "rev-v1-item",
            },
        } as ElementDetailView;

        assert.deepEqual(getRenderDecision(item), {kind: "itemAuthoring"});
        assert.equal(JSON.stringify(item).includes("answer"), false);
    });
});
