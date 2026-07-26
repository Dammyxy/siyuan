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
let createHTMLTopic: typeof import("./api").createHTMLTopic;
let renameElement: typeof import("./api").renameElement;
let saveTopicHTML: typeof import("./api").saveTopicHTML;
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
    ({createHTMLTopic, getElement, getElementTree, renameElement, saveTopicHTML} = await import("./api"));
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
        assert.equal(result.element.rootElementId, FIXTURE_ELEMENT_IDS.supportedTopic);
        assert.equal(result.element.storageKind, "rootDocument");
        assert.equal(result.element.title, "Supported Topic");
        assert.equal(result.element.titleRevision, "rev-v1-title-fixture");
        assert.deepEqual(result.element.topicMaterial, {
            kind: "html",
            html: '<h1 id="topic-title">Supported Topic</h1><p>Body with <a href="#topic-title">a fragment</a>.</p>',
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            revision: "rev-v1-material-fixture",
        });
    });

    it("fails closed when a supported writable HTML Topic omits either authoring revision", async () => {
        installFetchResponse(buildDetailEnvelope(buildSupportedTopic({titleRevision: ""})));
        assert.deepEqual(await getElement(FIXTURE_ELEMENT_IDS.supportedTopic), {ok: false, kind: "response"});

        installFetchResponse(buildDetailEnvelope(buildSupportedTopic({
            payload: {
                material: {
                    kind: "html",
                    html: "<p>Body</p>",
                    cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
                    revision: "",
                },
            },
        })));
        assert.deepEqual(await getElement(FIXTURE_ELEMENT_IDS.supportedTopic), {ok: false, kind: "response"});
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
            rootElementId: FIXTURE_ELEMENT_IDS.item,
            storageKind: "rootDocument",
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

describe("writable Element transport clients", () => {
    it("creates an empty HTML Topic with exactly the frozen two-field request", async () => {
        installFetchResponse(buildRawEnvelope({
            elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
            eventId: "20260725060100-event01",
            createAccepted: true,
            reviewAccepted: true,
            retryable: false,
            topic: {
                elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
                processingState: "new",
                scheduleProfile: "topic-afactor-v1",
                acceptedReviewAction: "NextTopic",
                cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            },
        }));

        const result = await createHTMLTopic("", "");

        assert.equal(result.ok, true);
        assert.deepEqual(calls, [{
            url: "/api/symemo/createHTMLTopic",
            data: {title: "", html: ""},
        }]);
        if (result.ok) {
            assert.equal(result.elementId, FIXTURE_ELEMENT_IDS.supportedTopic);
            assert.equal(result.createAccepted, true);
            assert.equal(result.reviewAccepted, true);
        }
    });

    it("posts closed rename/save commands and decodes accepted changes", async () => {
        installFetchResponse(buildRawEnvelope({
            kind: "RenameElement",
            elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
            changedField: "title",
            canonicalValue: "New title",
            revision: "rev-v1-title-next",
            changed: true,
            changeAccepted: true,
        }));

        const rename = await renameElement(FIXTURE_ELEMENT_IDS.supportedTopic, "rev-v1-title-fixture", "New title");

        assert.equal(rename.ok, true);
        assert.deepEqual(calls[0], {
            url: "/api/symemo/renameElement",
            data: {
                elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
                expectedTitleRevision: "rev-v1-title-fixture",
                title: "New title",
            },
        });

        installFetchResponse(buildRawEnvelope({
            kind: "SaveTopicHTML",
            elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
            changedField: "material",
            canonicalValue: "<p>Saved</p>",
            revision: "rev-v1-material-next",
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            nodeIdentityAssignments: [{clientNodeKey: "client-v1-20260725060100-abcdefghijklmnopqrstuv", nodeId: "20260725060200-node001"}],
            changed: true,
            changeAccepted: true,
        }));

        const save = await saveTopicHTML(FIXTURE_ELEMENT_IDS.supportedTopic, "rev-v1-material-fixture", "<p>Saved</p>");

        assert.equal(save.ok, true);
        assert.deepEqual(calls[1], {
            url: "/api/symemo/saveTopicHTML",
            data: {
                elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
                expectedMaterialRevision: "rev-v1-material-fixture",
                html: "<p>Saved</p>",
            },
        });
        if (save.ok) {
            assert.deepEqual(save.change.nodeIdentityAssignments, [{
                clientNodeKey: "client-v1-20260725060100-abcdefghijklmnopqrstuv",
                nodeId: "20260725060200-node001",
            }]);
        }
    });

    it("classifies conflict, accepted-recovering, host rejection, and uncertain transport failure", async () => {
        installFetchResponse(buildRawEnvelope({
            errorCode: "element-revision-conflict",
            retryable: false,
            elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
            changedField: "material",
            currentRevision: "rev-v1-current",
        }, {code: -1, msg: "conflict"}));
        assert.deepEqual(await saveTopicHTML(FIXTURE_ELEMENT_IDS.supportedTopic, "stale", "<p>x</p>"), {
            ok: false,
            failure: {
                kind: "conflict",
                elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
                changedField: "material",
                currentRevision: "rev-v1-current",
            },
        });

        installFetchResponse(buildRawEnvelope({
            errorCode: "projection-refresh-failed",
            retryable: false,
            changeAccepted: true,
            change: {
                kind: "SaveTopicHTML",
                elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
                changedField: "material",
                canonicalValue: "<p>accepted</p>",
                revision: "rev-v1-material-next",
                changed: true,
                changeAccepted: true,
            },
        }, {code: -1, msg: "accepted"}));
        const acceptedRecovering = await saveTopicHTML(FIXTURE_ELEMENT_IDS.supportedTopic, "rev-v1-material-fixture", "<p>accepted</p>");
        assert.equal(acceptedRecovering.ok, false);
        if (acceptedRecovering.ok === false) {
            assert.equal(acceptedRecovering.failure.kind, "acceptedRecovering");
        }

        installFetchResponse(buildRawEnvelope({closeTimeout: 5000}, {code: -1, msg: "booting"}));
        assert.deepEqual(await renameElement(FIXTURE_ELEMENT_IDS.supportedTopic, "rev", "x"), {
            ok: false,
            failure: {kind: "failed", errorCode: "host-rejected", retryable: false, acceptanceUnknown: false},
        });

        nextError = new SyntaxError("bad json");
        assert.deepEqual(await renameElement(FIXTURE_ELEMENT_IDS.supportedTopic, "rev", "x"), {
            ok: false,
            failure: {kind: "failed", errorCode: "response", retryable: true, acceptanceUnknown: true},
        });
    });

    it("trusts a failed create Element ID only when the host explicitly confirms creation", async () => {
        installFetchResponse(buildRawEnvelope({
            errorCode: "review-append-failed",
            retryable: false,
            elementId: "unconfirmed-topic-id",
            createAccepted: false,
        }, {code: -1, msg: "failed"}));
        assert.deepEqual(await createHTMLTopic("Title", "<p>Body</p>"), {
            ok: false,
            failure: {
                errorCode: "review-append-failed",
                retryable: false,
                acceptanceUnknown: false,
                acceptedElementId: undefined,
            },
        });

        installFetchResponse(buildRawEnvelope({
            errorCode: "review-append-failed",
            retryable: false,
            elementId: "accepted-topic-id",
            createAccepted: true,
        }, {code: -1, msg: "accepted"}));
        assert.deepEqual(await createHTMLTopic("Title", "<p>Body</p>"), {
            ok: false,
            failure: {
                errorCode: "review-append-failed",
                retryable: false,
                acceptanceUnknown: false,
                acceptedElementId: "accepted-topic-id",
            },
        });
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
