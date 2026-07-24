import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {
    buildDetailEnvelope,
    buildItem,
    buildOrderedMixedTree,
    buildRawEnvelope,
    buildSupportedTopic,
    buildTreeEnvelope,
    FIXTURE_ELEMENT_IDS,
    RawFixtureEnvelope,
    RawFixtureObject,
} from "./testFixtures";

interface FetchCall {
    url: string;
    data?: unknown;
}

const fetchModulePath = require.resolve("../util/fetch");
const originalFetchModule = require.cache[fetchModulePath];
let getElement: typeof import("./api").getElement;
let getElementTree: typeof import("./api").getElementTree;
let calls: FetchCall[] = [];
let nextEnvelope: RawFixtureEnvelope<unknown>;
let nextError: unknown;

before(async () => {
    require.cache[fetchModulePath] = {
        exports: {
            fetchSyncPost: async (url: string, data?: unknown) => {
                calls.push({url, data});
                if (nextError) throw nextError;
                return nextEnvelope;
            },
        },
    } as NodeModule;
    ({getElement, getElementTree} = await import("./api"));
});

const installFetchResponse = (envelope: RawFixtureEnvelope<unknown>) => {
    nextEnvelope = envelope;
};

beforeEach(() => {
    calls = [];
    nextError = undefined;
    installFetchResponse(buildTreeEnvelope());
});

after(() => {
    if (originalFetchModule) {
        require.cache[fetchModulePath] = originalFetchModule;
    } else {
        delete require.cache[fetchModulePath];
    }
});

describe("getElementTree", () => {
    it("posts only the complete-tree read with schedule summaries disabled", async () => {
        const result = await getElementTree();

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "/api/symemo/getElementTree");
        assert.deepEqual(calls[0].data, {
            rootElementId: "",
            includeScheduleSummary: false,
        });
    });

    it("validates and projects an ordered mixed tree without sorting or filtering", async () => {
        installFetchResponse(buildTreeEnvelope(buildOrderedMixedTree()));

        const result = await getElementTree();

        assert.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        assert.deepEqual(result.nodes.map((node) => node.elementId), [
            FIXTURE_ELEMENT_IDS.rootConcept,
            FIXTURE_ELEMENT_IDS.futureParent,
            FIXTURE_ELEMENT_IDS.unsupportedRead,
        ]);
        assert.deepEqual(result.nodes[0].children.map((node) => node.elementId), [
            FIXTURE_ELEMENT_IDS.supportedTopic,
            FIXTURE_ELEMENT_IDS.item,
            FIXTURE_ELEMENT_IDS.blockTopic,
        ]);
        assert.equal(result.nodes[1].type, "future-collection");
        assert.equal(result.nodes[1].sourceMode, "future-source");
        assert.equal(result.nodes[1].supportStatus, "future-support");
        assert.equal(result.nodes[1].children[0].elementId, FIXTURE_ELEMENT_IDS.futureChild);
    });

    it("treats a valid empty node array as a successful empty tree", async () => {
        installFetchResponse(buildRawEnvelope({nodes: []}));

        assert.deepEqual(await getElementTree(), {ok: true, nodes: []});
    });

    it("normalizes the kernel omitempty empty-tree envelope to an empty node array", async () => {
        installFetchResponse({code: 0, msg: "", data: {}});

        assert.deepEqual(await getElementTree(), {ok: true, nodes: []});
    });
});

describe("getElement", () => {
    it("posts the exact detail read and decodes the envelope data directly", async () => {
        installFetchResponse(buildDetailEnvelope(buildSupportedTopic()));

        const result = await getElement(FIXTURE_ELEMENT_IDS.supportedTopic);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "/api/symemo/getElement");
        assert.deepEqual(calls[0].data, {elementId: FIXTURE_ELEMENT_IDS.supportedTopic});
        assert.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        assert.equal(result.element.elementId, FIXTURE_ELEMENT_IDS.supportedTopic);
        assert.equal(result.element.title, "Supported Topic");
        assert.deepEqual(result.element.topicMaterial, {
            kind: "html",
            html: '<h1 id="topic-title">Supported Topic</h1><p>Body with <a href="#topic-title">a fragment</a>.</p>',
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
        });
    });

    it("normalizes an invalid title but preserves valid future common strings", async () => {
        installFetchResponse(buildDetailEnvelope(buildSupportedTopic({
            title: 42,
            sourceMode: "future-source-mode",
            supportStatus: "future-support-status",
        })));

        const result = await getElement(FIXTURE_ELEMENT_IDS.supportedTopic);

        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.element.title, "");
            assert.equal(result.element.sourceMode, "future-source-mode");
            assert.equal(result.element.supportStatus, "future-support-status");
        }
    });

    it("projects no Item prompt, answer, schedule, relation, source, material, or opaque payload", async () => {
        installFetchResponse(buildDetailEnvelope(buildItem()));

        const result = await getElement(FIXTURE_ELEMENT_IDS.item);

        assert.equal(result.ok, true);
        if (!result.ok) {
            return;
        }
        assert.deepEqual(result.element, {
            elementId: FIXTURE_ELEMENT_IDS.item,
            type: "item",
            title: "Recall Item",
            sourceMode: "opaque",
            supportStatus: "supported",
        });
        const projected = JSON.stringify(result.element);
        for (const forbidden of [
            "prompt", "answer", "schedule", "relation", "sourcePath", "block", "payload", "material",
        ]) {
            assert.equal(projected.includes(forbidden), false, forbidden);
        }
    });

    it("does not accept an erroneous data.element wrapper as a valid direct detail", async () => {
        installFetchResponse(buildRawEnvelope({element: buildSupportedTopic()}));

        assert.deepEqual(await getElement(FIXTURE_ELEMENT_IDS.supportedTopic), {ok: false, kind: "response"});
    });
});

describe("failure classification and atomic validation", () => {
    it("classifies request rejection separately from malformed JSON", async () => {
        nextError = new TypeError("network");
        assert.deepEqual(await getElementTree(), {ok: false, kind: "request"});
        nextError = new SyntaxError("json");
        assert.deepEqual(await getElementTree(), {ok: false, kind: "response"});
    });

    it("classifies only element-not-found as missing", async () => {
        installFetchResponse(buildRawEnvelope({errorCode: "element-not-found"}, {code: -1, msg: "hidden"}));
        assert.deepEqual(await getElement(FIXTURE_ELEMENT_IDS.missing), {ok: false, kind: "missing"});
        installFetchResponse(buildRawEnvelope({errorCode: "other"}, {code: -1, msg: "hidden"}));
        assert.deepEqual(await getElement(FIXTURE_ELEMENT_IDS.missing), {ok: false, kind: "response"});
    });

    it("rejects malformed or duplicate trees without partial publication", async () => {
        const tree = buildOrderedMixedTree() as {nodes: RawFixtureObject[]};
        installFetchResponse(buildRawEnvelope({nodes: [
            {...tree.nodes[0]},
            {...tree.nodes[0]},
        ]}));
        assert.deepEqual(await getElementTree(), {ok: false, kind: "response"});
        installFetchResponse({code: 0, msg: "", data: null});
        assert.deepEqual(await getElementTree(), {ok: false, kind: "response"});
        installFetchResponse(buildRawEnvelope({nodes: null}));
        assert.deepEqual(await getElementTree(), {ok: false, kind: "response"});
        installFetchResponse(buildRawEnvelope({unexpected: true}));
        assert.deepEqual(await getElementTree(), {ok: false, kind: "response"});
    });

    it("uses no endpoint beyond the two approved reads", async () => {
        installFetchResponse(buildTreeEnvelope());
        await getElementTree();
        installFetchResponse(buildDetailEnvelope());
        await getElement(FIXTURE_ELEMENT_IDS.supportedTopic);
        assert.deepEqual([...new Set(calls.map((call) => call.url))].sort(), [
            "/api/symemo/getElement", "/api/symemo/getElementTree",
        ]);
    });
});
