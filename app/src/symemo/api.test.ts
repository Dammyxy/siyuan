import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import type {LearningSessionProjection} from "./types";
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
let createItem: (...args: any[]) => Promise<any>;
let getItemAuthoring: (...args: any[]) => Promise<any>;
let renameElement: typeof import("./api").renameElement;
let saveItemQA: (...args: any[]) => Promise<any>;
let saveTopicHTML: typeof import("./api").saveTopicHTML;
let getCurrentLearningSession: typeof import("./api").getCurrentLearningSession;
let startLearning: typeof import("./api").startLearning;
let stopLearning: typeof import("./api").stopLearning;
let nextTopic: typeof import("./api").nextTopic;
let showAnswer: (...args: any[]) => Promise<any>;
let gradeItem: (...args: any[]) => Promise<any>;
let acceptLearningStage: (...args: any[]) => Promise<any>;
let declineLearningStage: (...args: any[]) => Promise<any>;
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
    const apiModule = await import("./api");
    ({
        createHTMLTopic,
        getCurrentLearningSession,
        getElement,
        getElementTree,
        renameElement,
        saveTopicHTML,
        nextTopic,
        startLearning,
        stopLearning,
    } = apiModule);
    createItem = (apiModule as any).createItem;
    getItemAuthoring = (apiModule as any).getItemAuthoring;
    saveItemQA = (apiModule as any).saveItemQA;
    showAnswer = (apiModule as any).showAnswer;
    gradeItem = (apiModule as any).gradeItem;
    acceptLearningStage = (apiModule as any).acceptLearningStage;
    declineLearningStage = (apiModule as any).declineLearningStage;
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

    it("projects only the answer-redacted Item summary needed by content surfaces", async () => {
        installFetchResponse(buildDetailEnvelope(buildItem({
            sourceMode: "opaque",
            payloadSpec: 1,
            payload: {
                kind: "qa",
                prompt: "Question-safe prompt",
                revision: "rev-v1-item-fixture",
            },
        })));

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
            item: {
                kind: "qa",
                prompt: "Question-safe prompt",
                revision: "rev-v1-item-fixture",
            },
        });
        const projected = JSON.stringify(result.element);
        for (const forbidden of [
            "answer", "schedule", "relation", "sourcePath", "block", "payload", "material",
        ]) {
            assert.equal(projected.includes(forbidden), false, forbidden);
        }
    });

    it("does not accept an erroneous data.element wrapper as a valid direct detail", async () => {
        installFetchResponse(buildRawEnvelope({element: buildSupportedTopic()}));

        assert.deepEqual(await getElement(FIXTURE_ELEMENT_IDS.supportedTopic), {ok: false, kind: "response"});
    });
});

describe("Item authoring transport clients", () => {
    const elementId = FIXTURE_ELEMENT_IDS.item;

    it("creates one Item through the exact named route and validates the strict content-only success", async () => {
        installFetchResponse(buildRawEnvelope({
            elementId,
            createAccepted: true,
            reviewAccepted: false,
            retryable: false,
            item: {
                elementId,
                processingState: "processed",
                contentRevision: "rev-v1-created",
                sourcePath: `${elementId}.sme`,
                sortRank: 42,
                lifecycleState: "pending",
            },
        }));

        assert.deepEqual(await createItem(elementId, "Question", "Answer"), {
            ok: true,
            item: {
                elementId,
                processingState: "processed",
                contentRevision: "rev-v1-created",
                sourcePath: `${elementId}.sme`,
                sortRank: 42,
                lifecycleState: "pending",
            },
        });
        assert.deepEqual(calls, [{
            url: "/api/symemo/createItem",
            data: {elementId, prompt: "Question", answer: "Answer"},
        }]);

        installFetchResponse(buildRawEnvelope({
            elementId,
            eventId: "forbidden-event",
            createAccepted: true,
            reviewAccepted: false,
            retryable: false,
            item: {
                elementId,
                processingState: "processed",
                contentRevision: "rev-v1-created",
                lifecycleState: "pending",
            },
        }));
        assert.deepEqual(await createItem(elementId, "Question", "Answer"), {
            ok: false,
            failure: {
                errorCode: "response",
                retryable: true,
                acceptance: "unknown",
                kind: "response",
            },
        });
    });

    it("loads complete Q/A only through the explicit authoring route", async () => {
        installFetchResponse(buildRawEnvelope({
            elementId,
            prompt: "Question",
            answer: "Answer",
            contentRevision: "rev-v1-current",
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
        }));

        assert.deepEqual(await getItemAuthoring(elementId), {
            ok: true,
            authoring: {
                elementId,
                prompt: "Question",
                answer: "Answer",
                contentRevision: "rev-v1-current",
                cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            },
        });
        assert.deepEqual(calls, [{url: "/api/symemo/getItemAuthoring", data: {elementId}}]);

        installFetchResponse(buildRawEnvelope({
            elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
            prompt: "Question",
            answer: "Answer",
            contentRevision: "rev-v1-current",
        }));
        assert.equal((await getItemAuthoring(elementId)).ok, false);
    });

    it("decodes aggregate Item Q/A saves without packing the pair into canonicalValue", async () => {
        installFetchResponse(buildRawEnvelope({
            kind: "SaveItemQA",
            elementId,
            changedField: "itemQA",
            canonicalValue: "",
            revision: "rev-v1-next",
            itemQA: {
                prompt: "Corrected question",
                answer: "Corrected answer",
                contentRevision: "rev-v1-next",
                cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            },
            changed: true,
            changeAccepted: true,
        }));

        const result = await saveItemQA(
            elementId,
            "rev-v1-current",
            "Corrected question",
            "Corrected answer",
        );
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.change.itemQA.prompt, "Corrected question");
            assert.equal(result.change.itemQA.cleaningPolicyVersion, "siyuanmemo-topic-html-v1");
        }
        assert.deepEqual(calls, [{
            url: "/api/symemo/saveItemQA",
            data: {
                elementId,
                expectedContentRevision: "rev-v1-current",
                prompt: "Corrected question",
                answer: "Corrected answer",
            },
        }]);
        assert.equal(JSON.stringify(result).includes("canonicalValue"), false);
    });

    it("distinguishes Item conflicts, accepted recovery, and malformed successes", async () => {
        installFetchResponse(buildRawEnvelope({
            errorCode: "element-revision-conflict",
            retryable: false,
            changeAccepted: false,
            elementId,
            changedField: "itemQA",
            currentRevision: "rev-v1-current",
        }, {code: -1, msg: "conflict"}));
        assert.deepEqual(await saveItemQA(elementId, "stale", "Question", "Answer"), {
            ok: false,
            failure: {
                kind: "conflict",
                elementId,
                changedField: "itemQA",
                currentRevision: "rev-v1-current",
            },
        });

        installFetchResponse(buildRawEnvelope({
            errorCode: "projection-refresh-failed",
            retryable: true,
            changeAccepted: true,
            acceptedChange: {
                kind: "SaveItemQA",
                elementId,
                changedField: "itemQA",
                revision: "rev-v1-next",
                itemQA: {prompt: "Question", answer: "Answer", contentRevision: "rev-v1-next"},
                changed: true,
                changeAccepted: true,
            },
        }, {code: -1, msg: "accepted"}));
        const recovering = await saveItemQA(elementId, "rev-v1-current", "Question", "Answer");
        assert.equal(recovering.ok, false);
        if (!recovering.ok) assert.equal(recovering.failure.kind, "acceptedRecovering");

        installFetchResponse(buildRawEnvelope({
            kind: "SaveItemQA",
            elementId,
            changedField: "itemQA",
            revision: "rev-v1-next",
            itemQA: {prompt: "Question", answer: "Answer", contentRevision: "different"},
            changed: false,
            changeAccepted: true,
        }));
        assert.equal((await saveItemQA(elementId, "rev-v1-current", "Question", "Answer")).ok, false);
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

describe("Learning Session transport clients", () => {
    const activeSession = {
        sessionId: "session-007",
        status: "active",
        stage: "outstanding",
        phase: "question",
        current: {
            kind: "element.topic",
            elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
            prompt: "must be discarded",
            answer: "must be discarded",
            observedProjection: {dueDay: "2026-07-26"},
        },
        remainingElementIds: [FIXTURE_ELEMENT_IDS.futureChild],
        pendingAcceptedEventId: "event-pending",
        answerVisible: false,
        algorithmState: {name: "must be discarded"},
    };

    it("posts exact empty bodies to Current, Start, and Stop", async () => {
        installFetchResponse(buildRawEnvelope(activeSession));
        await getCurrentLearningSession();
        await startLearning();
        await stopLearning();

        assert.deepEqual(calls, [
            {url: "/api/symemo/getCurrentLearningSession", data: {}},
            {url: "/api/symemo/startLearning", data: {}},
            {url: "/api/symemo/stopLearning", data: {}},
        ]);
    });

    it("strictly narrows active and completed sessions", async () => {
        installFetchResponse(buildRawEnvelope(activeSession));
        const active = await getCurrentLearningSession();
        assert.deepEqual(active, {
            ok: true,
            session: {
                sessionId: "session-007",
                status: "active",
                stage: "outstanding",
                phase: "question",
                current: {
                    kind: "element.topic",
                    elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
                },
                remainingElementIds: [FIXTURE_ELEMENT_IDS.futureChild],
                pendingAcceptedEventId: "event-pending",
            },
        });
        assert.equal(JSON.stringify(active).includes("prompt"), false);
        assert.equal(JSON.stringify(active).includes("answer"), false);
        assert.equal(JSON.stringify(active).includes("algorithm"), false);

        installFetchResponse(buildRawEnvelope({status: "completed", stage: "completed", phase: "completed"}));
        assert.deepEqual(await startLearning(), {
            ok: true,
            session: {
                status: "completed",
                stage: "completed",
                phase: "completed",
                remainingElementIds: [],
            },
        });
    });

    it("retains only a valid embedded session from structured failures", async () => {
        installFetchResponse(buildRawEnvelope({
            errorCode: "invalid-session-phase",
            retryable: false,
            session: activeSession,
        }, {code: -1, msg: "hidden"}));

        assert.deepEqual(await stopLearning(), {
            ok: false,
            failure: {
                errorCode: "invalid-session-phase",
                retryable: false,
                kind: "domain",
                session: {
                    sessionId: "session-007",
                    status: "active",
                    stage: "outstanding",
                    phase: "question",
                    current: {
                        kind: "element.topic",
                        elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
                    },
                    remainingElementIds: [FIXTURE_ELEMENT_IDS.futureChild],
                    pendingAcceptedEventId: "event-pending",
                },
            },
        });
    });

    it("fails closed for malformed sessions, envelopes, and thrown requests", async () => {
        installFetchResponse(buildRawEnvelope({status: "active", phase: "question", current: {kind: "element.topic"}}));
        assert.deepEqual(await getCurrentLearningSession(), {
            ok: false,
            failure: {errorCode: "response", retryable: true, kind: "response"},
        });

        installFetchResponse({code: 0, msg: "", data: null});
        assert.deepEqual(await startLearning(), {
            ok: false,
            failure: {errorCode: "response", retryable: true, kind: "response"},
        });

        nextError = new TypeError("offline");
        assert.deepEqual(await stopLearning(), {
            ok: false,
            failure: {errorCode: "request", retryable: true, kind: "request"},
        });
    });
});

describe("Topic Next transport client", () => {
    const returnedSession: LearningSessionProjection = {
        sessionId: "session-007",
        status: "active",
        stage: "outstanding",
        phase: "question",
        current: {kind: "element.topic", elementId: FIXTURE_ELEMENT_IDS.futureChild},
        remainingElementIds: [] as string[],
    };

    it("posts the exact Topic identity and accepts only a matching durable success", async () => {
        installFetchResponse(buildRawEnvelope({
            reviewAccepted: true,
            eventId: "event-007-next",
            session: returnedSession,
            projection: {intervalDays: 999},
            rawGrade: 4,
        }));

        const result = await nextTopic(FIXTURE_ELEMENT_IDS.supportedTopic, "event-007-next");

        assert.deepEqual(calls, [{
            url: "/api/symemo/nextTopic",
            data: {elementId: FIXTURE_ELEMENT_IDS.supportedTopic, eventId: "event-007-next"},
        }]);
        assert.deepEqual(result, {
            ok: true,
            eventId: "event-007-next",
            reviewAccepted: true,
            session: {
                sessionId: "session-007",
                status: "active",
                stage: "outstanding",
                phase: "question",
                current: {kind: "element.topic", elementId: FIXTURE_ELEMENT_IDS.futureChild},
                remainingElementIds: [],
            },
        });
        assert.equal(JSON.stringify(result).includes("intervalDays"), false);
        assert.equal(JSON.stringify(result).includes("rawGrade"), false);
    });

    it("rejects blank inputs locally without sending a request", async () => {
        assert.equal((await nextTopic("", "event-007")).ok, false);
        assert.equal((await nextTopic(FIXTURE_ELEMENT_IDS.supportedTopic, " ")).ok, false);
        assert.deepEqual(calls, []);
    });

    it("classifies mismatched, non-accepted, and malformed successes as acceptance unknown", async () => {
        for (const data of [
            {reviewAccepted: true, eventId: "different", session: returnedSession},
            {reviewAccepted: false, eventId: "event-007-next", session: returnedSession},
            {
                reviewAccepted: true,
                eventId: "event-007-next",
                session: {status: "active", phase: "question", current: {kind: "element.topic"}},
            },
        ]) {
            installFetchResponse(buildRawEnvelope(data));
            const result = await nextTopic(FIXTURE_ELEMENT_IDS.supportedTopic, "event-007-next");
            assert.deepEqual(result, {
                ok: false,
                failure: {
                    errorCode: "response",
                    retryable: true,
                    acceptance: "unknown",
                    kind: "response",
                },
            });
        }
    });

    it("decodes structured pre-acceptance and accepted recovery failures without trusting identity alone", async () => {
        const cases = [
            {
                data: {
                    errorCode: "durable-write-failed",
                    retryable: true,
                    acceptedEventId: "event-007-next",
                    reviewAccepted: false,
                    session: returnedSession,
                },
                acceptance: "notAccepted",
            },
            {
                data: {
                    errorCode: "queue-advance-failed",
                    retryable: true,
                    acceptedEventId: "event-007-next",
                    reviewAccepted: true,
                    session: {...returnedSession, pendingAcceptedEventId: "event-007-next"},
                },
                acceptance: "accepted",
            },
            {
                data: {
                    errorCode: "projection-refresh-failed",
                    retryable: true,
                    acceptedEventId: "event-007-next",
                    reviewAccepted: true,
                    session: returnedSession,
                },
                acceptance: "accepted",
            },
            {
                data: {
                    errorCode: "projection-rebuild-failed",
                    retryable: true,
                    acceptedEventId: "event-007-next",
                    reviewAccepted: true,
                    session: returnedSession,
                },
                acceptance: "accepted",
            },
        ] as const;

        for (const value of cases) {
            installFetchResponse(buildRawEnvelope(value.data, {code: -1, msg: "failed"}));
            const result = await nextTopic(FIXTURE_ELEMENT_IDS.supportedTopic, "event-007-next");
            assert.equal(result.ok, false);
            if (result.ok === false) {
                assert.equal(result.failure.errorCode, value.data.errorCode);
                assert.equal(result.failure.acceptance, value.acceptance);
                assert.equal(result.failure.acceptedEventId, "event-007-next");
                assert.deepEqual(result.failure.session?.current, returnedSession.current);
            }
        }
    });

    it("decodes stale, repair, and read-only failures conservatively", async () => {
        for (const errorCode of ["target-mismatch", "invalid-session-phase", "history-requires-repair"]) {
            installFetchResponse(buildRawEnvelope({
                errorCode,
                retryable: errorCode !== "history-requires-repair",
                acceptedEventId: "event-007-next",
                reviewAccepted: false,
                session: returnedSession,
            }, {code: -1, msg: "failed"}));
            const result = await nextTopic(FIXTURE_ELEMENT_IDS.supportedTopic, "event-007-next");
            assert.equal(result.ok, false);
            if (result.ok === false) {
                assert.equal(result.failure.acceptance, "notAccepted");
                assert.equal(result.failure.kind, "domain");
            }
        }

        installFetchResponse(buildRawEnvelope({closeTimeout: 5000}, {code: -1, msg: "read only"}));
        const readOnly = await nextTopic(FIXTURE_ELEMENT_IDS.supportedTopic, "event-007-next");
        assert.equal(readOnly.ok, false);
        if (readOnly.ok === false) {
            assert.equal(readOnly.failure.errorCode, "host-rejected");
            assert.equal(readOnly.failure.acceptance, "unknown");
        }
    });

    it("keeps thrown, parse, and malformed outcomes acceptance-unknown", async () => {
        nextError = new TypeError("offline");
        let result = await nextTopic(FIXTURE_ELEMENT_IDS.supportedTopic, "event-007-next");
        assert.equal(result.ok, false);
        if (result.ok === false) assert.equal(result.failure.acceptance, "unknown");

        nextError = new SyntaxError("json");
        result = await nextTopic(FIXTURE_ELEMENT_IDS.supportedTopic, "event-007-next");
        assert.equal(result.ok, false);
        if (result.ok === false) assert.equal(result.failure.kind, "response");

        installFetchResponse({code: -1, msg: "failed", data: "bad"});
        result = await nextTopic(FIXTURE_ELEMENT_IDS.supportedTopic, "event-007-next");
        assert.equal(result.ok, false);
        if (result.ok === false) assert.equal(result.failure.acceptance, "unknown");
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

describe("Item Alpha learning transport", () => {
    const questionSession = {
        sessionId: "session-item-alpha",
        status: "active",
        stage: "outstanding",
        phase: "question",
        current: {kind: "element.item", elementId: "item-alpha", prompt: "Question\nline two"},
        remainingElementIds: [] as string[],
    };
    const answerSession = {
        ...questionSession,
        phase: "answer",
        current: {...questionSession.current, answer: "Answer\nline two"},
    };

    it("rejects any answer key in a question snapshot and requires it in the answer phase", async () => {
        installFetchResponse(buildRawEnvelope({
            ...questionSession,
            current: {...questionSession.current, answer: "leak"},
        }));
        assert.equal((await startLearning()).ok, false);

        installFetchResponse(buildRawEnvelope({...answerSession, current: {...questionSession.current}}));
        assert.equal((await startLearning()).ok, false);
    });

    it("uses strict named Show Answer and stage operations", async () => {
        assert.equal(typeof showAnswer, "function");
        assert.equal(typeof acceptLearningStage, "function");
        assert.equal(typeof declineLearningStage, "function");

        installFetchResponse(buildRawEnvelope(answerSession));
        assert.deepEqual(await showAnswer("item-alpha"), {ok: true, session: answerSession});
        assert.deepEqual(calls.at(-1), {url: "/api/symemo/showAnswer", data: {elementId: "item-alpha"}});

        const confirmation = {
            sessionId: "session-item-alpha",
            status: "active",
            stage: "pending",
            phase: "confirmation",
            confirmation: {stage: "pending"},
            remainingElementIds: [] as string[],
        };
        installFetchResponse(buildRawEnvelope(questionSession));
        assert.equal((await acceptLearningStage("pending")).ok, true);
        assert.deepEqual(calls.at(-1), {url: "/api/symemo/acceptLearningStage", data: {stage: "pending"}});
        installFetchResponse(buildRawEnvelope(confirmation));
        assert.equal((await declineLearningStage("pending")).ok, true);
        assert.deepEqual(calls.at(-1), {url: "/api/symemo/declineLearningStage", data: {stage: "pending"}});
    });

    it("retains an exact raw grade and accepted identity while discarding scheduler internals", async () => {
        assert.equal(typeof gradeItem, "function");
        for (const rawGrade of [0, 1, 2, 3, 4, 5] as const) {
            installFetchResponse(buildRawEnvelope({
                reviewAccepted: true,
                eventId: `grade-${rawGrade}`,
                rawGrade,
                passed: rawGrade >= 3,
                ratingLabel: "internal",
                ratingMapping: "supermemo-grade-v1",
                algorithmDecision: {winner: "internal"},
                candidates: [{algorithm: "internal"}],
                session: {status: "completed", stage: "completed", phase: "completed"},
            }));
            assert.deepEqual(await gradeItem("item-alpha", `grade-${rawGrade}`, rawGrade), {
                ok: true,
                eventId: `grade-${rawGrade}`,
                rawGrade,
                reviewAccepted: true,
                session: {status: "completed", stage: "completed", phase: "completed", remainingElementIds: []},
            });
        }
    });

    it("classifies pre-acceptance, unknown, accepted queue, projection, and stale failures conservatively", async () => {
        installFetchResponse(buildRawEnvelope({
            errorCode: "durable-write-failed",
            retryable: true,
            reviewAccepted: false,
        }, {code: -1, msg: "not accepted"}));
        assert.deepEqual(await gradeItem("item-alpha", "event-pre", 2), {
            ok: false,
            failure: {
                errorCode: "durable-write-failed",
                retryable: true,
                acceptance: "notAccepted",
                kind: "domain",
            },
        });

        installFetchResponse(buildRawEnvelope({
            errorCode: "host-rejected",
            retryable: true,
        }, {code: -1, msg: "unknown"}));
        assert.equal((await gradeItem("item-alpha", "event-unknown", 2) as any).failure.acceptance, "unknown");

        installFetchResponse(buildRawEnvelope({
            errorCode: "queue-advance-failed",
            retryable: true,
            reviewAccepted: true,
            acceptedEventId: "event-queue",
            session: {...answerSession, pendingAcceptedEventId: "event-queue"},
        }, {code: -1, msg: "accepted"}));
        assert.deepEqual(await gradeItem("item-alpha", "event-queue", 0), {
            ok: false,
            failure: {
                errorCode: "queue-advance-failed",
                retryable: true,
                acceptance: "accepted",
                acceptedEventId: "event-queue",
                session: {...answerSession, pendingAcceptedEventId: "event-queue"},
                kind: "domain",
            },
        });

        installFetchResponse(buildRawEnvelope({
            errorCode: "projection-refresh-failed",
            retryable: true,
            reviewAccepted: true,
            acceptedEventId: "event-projection",
        }, {code: -1, msg: "accepted"}));
        assert.equal((await gradeItem("item-alpha", "event-projection", 5) as any).failure.acceptance, "accepted");

        installFetchResponse(buildRawEnvelope({
            errorCode: "target-mismatch",
            retryable: false,
            reviewAccepted: false,
            session: questionSession,
        }, {code: -1, msg: "stale"}));
        const stale = await gradeItem("item-alpha", "event-stale", 4);
        assert.equal((stale as any).failure.acceptance, "notAccepted");
        assert.deepEqual((stale as any).failure.session, questionSession);
    });

    it("never promotes an accepted failure for another event identity", async () => {
        installFetchResponse(buildRawEnvelope({
            errorCode: "queue-advance-failed",
            retryable: true,
            reviewAccepted: true,
            acceptedEventId: "different-event",
            session: {...answerSession, pendingAcceptedEventId: "different-event"},
        }, {code: -1, msg: "mismatched acceptance"}));

        const result = await gradeItem("item-alpha", "submitted-event", 3);

        assert.equal((result as any).failure.acceptance, "unknown");
        assert.equal((result as any).failure.acceptedEventId, undefined);
    });
});
