export const FIXTURE_ELEMENT_IDS = {
    rootConcept: "20260724000000-rootcon",
    supportedTopic: "20260724000001-topicv1",
    item: "20260724000002-item001",
    blockTopic: "20260724000003-block01",
    futureParent: "20260724000004-future1",
    unsupportedRead: "20260724000005-unsup01",
    blankTopic: "20260724000006-blank01",
    unknownPolicyTopic: "20260724000007-policy1",
    missing: "20260724000008-missing",
    futureChild: "20260724000009-future2",
} as const;

export type RawFixtureObject = Record<string, unknown>;

export interface RawFixtureEnvelope<T> {
    code: number;
    msg: string;
    data: T;
}

export const buildRawEnvelope = <T>(data: T, overrides: Partial<RawFixtureEnvelope<T>> = {}): RawFixtureEnvelope<T> => ({
    code: 0,
    msg: "",
    data,
    ...overrides,
});

const withOverrides = (value: RawFixtureObject, overrides: RawFixtureObject = {}): RawFixtureObject => ({
    ...value,
    ...overrides,
});

export const buildRawTreeNode = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    elementId: FIXTURE_ELEMENT_IDS.supportedTopic,
    type: "topic",
    title: "Supported Topic",
    sourceMode: "html",
    supportStatus: "supported",
    children: [],
}, overrides);

export const buildSupportedTopic = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    spec: 1,
    id: FIXTURE_ELEMENT_IDS.supportedTopic,
    type: "topic",
    title: "Supported Topic",
    processingState: "new",
    payloadSpec: 1,
    payload: {
        material: {
            kind: "html",
            html: '<h1 id="topic-title">Supported Topic</h1><p>Body with <a href="#topic-title">a fragment</a>.</p>',
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
        },
        relations: [{type: "hostile-test-only", targetId: "private"}],
    },
    rootElementId: FIXTURE_ELEMENT_IDS.supportedTopic,
    storageKind: "rootDocument",
    sourceMode: "html",
    supportStatus: "supported",
    sourcePath: "/must/not/escape.sme",
    scheduleProjection: {nextReviewAt: "2099-01-01T00:00:00Z"},
}, overrides);

export const buildItem = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    spec: 1,
    id: FIXTURE_ELEMENT_IDS.item,
    type: "item",
    title: "Recall Item",
    sourceMode: "opaque",
    supportStatus: "supported",
    payload: {
        prompt: "HOSTILE PROMPT MUST NOT REACH THE UI",
        answer: "HOSTILE ANSWER MUST NOT REACH THE UI",
        material: {
            kind: "html",
            html: "<p>HOSTILE ITEM HTML MUST NOT RENDER</p>",
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
        },
    },
    scheduleProjection: {
        state: "due",
        dueAt: "2026-07-24T00:00:00Z",
    },
    relations: [{type: "prerequisite", targetId: FIXTURE_ELEMENT_IDS.supportedTopic}],
    sourcePath: "/private/item.sme",
}, overrides);

export const buildConcept = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    spec: 1,
    id: FIXTURE_ELEMENT_IDS.rootConcept,
    type: "concept",
    title: "Root Concept",
    sourceMode: "unknown",
    supportStatus: "supported",
    payload: {description: "OPAQUE CONCEPT DATA MUST NOT REACH THE UI"},
}, overrides);

export const buildBlockBackedTopic = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    ...buildSupportedTopic(),
    id: FIXTURE_ELEMENT_IDS.blockTopic,
    title: "Block-backed Topic",
    sourceMode: "block",
    payload: {
        material: {
            kind: "block",
            blockId: "20260724000000-blockid",
            body: "HOSTILE BLOCK BODY MUST NOT REACH THE UI",
        },
    },
}, overrides);

export const buildFutureElement = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    spec: 99,
    id: FIXTURE_ELEMENT_IDS.futureParent,
    type: "future-collection",
    title: "Future Parent",
    sourceMode: "future-source",
    supportStatus: "future-support",
    payload: {opaque: "FUTURE OPAQUE DATA MUST NOT REACH THE UI"},
}, overrides);

export const buildUnsupportedReadOnlyTopic = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    ...buildSupportedTopic(),
    id: FIXTURE_ELEMENT_IDS.unsupportedRead,
    title: "Unsupported Read",
    supportStatus: "unsupportedReadOnly",
}, overrides);

export const buildBlankHTMLTopic = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    ...buildSupportedTopic(),
    id: FIXTURE_ELEMENT_IDS.blankTopic,
    title: "Blank Topic",
    payload: {
        material: {
            kind: "html",
            html: "  \n\t ",
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
        },
    },
}, overrides);

export const buildUnknownPolicyTopic = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    ...buildSupportedTopic(),
    id: FIXTURE_ELEMENT_IDS.unknownPolicyTopic,
    title: "Future Cleaning Policy",
    payload: {
        material: {
            kind: "html",
            html: "<p>UNKNOWN POLICY HTML MUST NOT RENDER</p>",
            cleaningPolicyVersion: "siyuanmemo-topic-html-v99",
        },
    },
}, overrides);

export const buildOrderedMixedTree = (overrides: RawFixtureObject = {}): RawFixtureObject => withOverrides({
    nodes: [
        buildRawTreeNode({
            elementId: FIXTURE_ELEMENT_IDS.rootConcept,
            type: "concept",
            title: "Root Concept",
            sourceMode: "unknown",
            children: [
                buildRawTreeNode(),
                buildRawTreeNode({
                    elementId: FIXTURE_ELEMENT_IDS.item,
                    type: "item",
                    title: "Recall Item",
                    sourceMode: "opaque",
                }),
                buildRawTreeNode({
                    elementId: FIXTURE_ELEMENT_IDS.blockTopic,
                    title: "Block-backed Topic",
                    sourceMode: "block",
                }),
            ],
        }),
        buildRawTreeNode({
            elementId: FIXTURE_ELEMENT_IDS.futureParent,
            type: "future-collection",
            title: "Future Parent",
            sourceMode: "future-source",
            supportStatus: "future-support",
            children: [buildRawTreeNode({
                elementId: FIXTURE_ELEMENT_IDS.futureChild,
                type: "future-leaf",
                title: "Future Child",
                sourceMode: "future-source",
                supportStatus: "unsupportedReadOnly",
            })],
        }),
        buildRawTreeNode({
            elementId: FIXTURE_ELEMENT_IDS.unsupportedRead,
            title: "Unsupported Read",
            supportStatus: "unsupportedReadOnly",
        }),
    ],
}, overrides);

export const buildTreeEnvelope = (data: RawFixtureObject = buildOrderedMixedTree()): RawFixtureEnvelope<RawFixtureObject> =>
    buildRawEnvelope(data);

export const buildDetailEnvelope = (element: RawFixtureObject = buildSupportedTopic()): RawFixtureEnvelope<RawFixtureObject> =>
    buildRawEnvelope(element);

export const buildMissingEnvelope = (): RawFixtureEnvelope<RawFixtureObject> => buildRawEnvelope({
    errorCode: "element-not-found",
    retryable: false,
}, {
    code: -1,
    msg: "The Element was not found.",
});

export const buildFailureEnvelope = (overrides: RawFixtureObject = {}): RawFixtureEnvelope<RawFixtureObject> => buildRawEnvelope({
    errorCode: "element-read-failed",
    retryable: true,
    ...overrides,
}, {
    code: -1,
    msg: "Element read failed.",
});

export const buildRequestFailure = (): Error => new TypeError("Simulated request failure");
