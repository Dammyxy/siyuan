import {fetchSyncPost} from "../util/fetch";
import {
    AcceptedItemQAChange,
    AcceptedElementChange,
    CreateHTMLTopicResult,
    CreateItemResult,
    ElementAuthoringField,
    ElementChangeFailure,
    ElementChangeResult,
    ElementDetailResult,
    ElementDetailView,
    LearningSessionPhase,
    LearningSessionProjection,
    LearningSessionStage,
    LearningSessionStatus,
    SessionCallFailure,
    SessionCallResult,
    TopicNextCallResult,
    ElementTreeResult,
    ItemAuthoringResult,
    ItemGradeCallResult,
    ItemQAChangeResult,
    TopicMaterialView,
} from "./types";
import {decodeElementTreeData} from "./treeState";

const TREE_ENDPOINT = "/api/symemo/getElementTree";
const DETAIL_ENDPOINT = "/api/symemo/getElement";
const CREATE_ENDPOINT = "/api/symemo/createHTMLTopic";
const CREATE_ITEM_ENDPOINT = "/api/symemo/createItem";
const ITEM_AUTHORING_ENDPOINT = "/api/symemo/getItemAuthoring";
const RENAME_ENDPOINT = "/api/symemo/renameElement";
const SAVE_ITEM_QA_ENDPOINT = "/api/symemo/saveItemQA";
const SAVE_TOPIC_HTML_ENDPOINT = "/api/symemo/saveTopicHTML";
const CURRENT_LEARNING_ENDPOINT = "/api/symemo/getCurrentLearningSession";
const START_LEARNING_ENDPOINT = "/api/symemo/startLearning";
const STOP_LEARNING_ENDPOINT = "/api/symemo/stopLearning";
const NEXT_TOPIC_ENDPOINT = "/api/symemo/nextTopic";
const SHOW_ANSWER_ENDPOINT = "/api/symemo/showAnswer";
const GRADE_ITEM_ENDPOINT = "/api/symemo/gradeItem";
const ACCEPT_STAGE_ENDPOINT = "/api/symemo/acceptLearningStage";
const DECLINE_STAGE_ENDPOINT = "/api/symemo/declineLearningStage";
const TOPIC_HTML_CLEANING_POLICY = "siyuanmemo-topic-html-v1";

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: UnknownRecord, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const hasSuccessfulEnvelope = (value: unknown): value is UnknownRecord & {code: 0; msg: string; data: unknown} =>
    isRecord(value) && value.code === 0 && typeof value.msg === "string" && hasOwn(value, "data");

const hasEnvelopeShape = (value: unknown): value is UnknownRecord & {code: number; msg: string; data: unknown} =>
    isRecord(value) && typeof value.code === "number" && typeof value.msg === "string" && hasOwn(value, "data");

const normalizeTitle = (value: unknown): string =>
    typeof value === "string" && value.trim().length > 0 ? value : "";

const decodeTopicMaterial = (value: UnknownRecord): TopicMaterialView | undefined => {
    if (!isRecord(value.payload) || !isRecord(value.payload.material)) {
        return undefined;
    }
    const rawMaterial = value.payload.material;
    const kind = rawMaterial.kind;
    if (typeof kind !== "string") {
        return undefined;
    }
    const material: TopicMaterialView = {kind};
    if (typeof rawMaterial.html === "string") {
        material.html = rawMaterial.html;
    }
    if (typeof rawMaterial.cleaningPolicyVersion === "string") {
        material.cleaningPolicyVersion = rawMaterial.cleaningPolicyVersion;
    }
    if (typeof rawMaterial.revision === "string") {
        material.revision = rawMaterial.revision;
    }
    return material;
};

const isSupportedWritableHTMLTopic = (detail: ElementDetailView): boolean =>
    detail.type === "topic" && detail.sourceMode === "html" && detail.supportStatus === "supported" &&
    detail.topicMaterial?.kind === "html" &&
    detail.topicMaterial.cleaningPolicyVersion === TOPIC_HTML_CLEANING_POLICY;

const decodeDetailData = (value: unknown): ElementDetailView | undefined => {
    if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0 ||
        typeof value.rootElementId !== "string" || value.rootElementId.trim().length === 0 ||
        typeof value.storageKind !== "string" || value.storageKind.trim().length === 0 ||
        typeof value.type !== "string" || typeof value.sourceMode !== "string" ||
        typeof value.supportStatus !== "string") {
        return undefined;
    }

    const detail: ElementDetailView = {
        elementId: value.id,
        rootElementId: value.rootElementId,
        storageKind: value.storageKind,
        type: value.type,
        title: normalizeTitle(value.title),
        sourceMode: value.sourceMode,
        supportStatus: value.supportStatus,
    };
    if (typeof value.titleRevision === "string") {
        detail.titleRevision = value.titleRevision;
    }
    if (value.type === "topic") {
        const topicMaterial = decodeTopicMaterial(value);
        if (topicMaterial) {
            detail.topicMaterial = topicMaterial;
        }
    } else if (value.type === "item") {
        if (value.payloadSpec !== 1 || !isRecord(value.payload) || value.payload.kind !== "qa" ||
            typeof value.payload.prompt !== "string" || value.payload.prompt.trim().length === 0 ||
            typeof value.payload.revision !== "string" || value.payload.revision.trim().length === 0 ||
            hasOwn(value.payload, "answer")) {
            return undefined;
        }
        detail.item = {
            kind: "qa",
            prompt: value.payload.prompt,
            revision: value.payload.revision,
        };
    }
    if (isSupportedWritableHTMLTopic(detail) &&
        (!detail.titleRevision || !detail.topicMaterial?.revision)) {
        return undefined;
    }
    return detail;
};

const failureKind = (error: unknown): "request" | "response" =>
    error instanceof SyntaxError ? "response" : "request";

export const getElementTree = async (): Promise<ElementTreeResult> => {
    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(TREE_ENDPOINT, {
            rootElementId: "",
            includeScheduleSummary: false,
        });
    } catch (error) {
        return {ok: false, kind: failureKind(error)};
    }

    if (!hasSuccessfulEnvelope(envelope)) {
        return {ok: false, kind: "response"};
    }
    const treeData = isRecord(envelope.data) && Object.keys(envelope.data).length === 0
        ? {nodes: []}
        : envelope.data;
    const nodes = decodeElementTreeData(treeData);
    return nodes ? {ok: true, nodes} : {ok: false, kind: "response"};
};

export const getElement = async (elementId: string): Promise<ElementDetailResult> => {
    if (typeof elementId !== "string" || elementId.trim().length === 0) {
        return {ok: false, kind: "response"};
    }

    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(DETAIL_ENDPOINT, {elementId});
    } catch (error) {
        return {ok: false, kind: failureKind(error)};
    }

    if (!hasEnvelopeShape(envelope)) {
        return {ok: false, kind: "response"};
    }
    if (envelope.code !== 0) {
        return isRecord(envelope.data) && envelope.data.errorCode === "element-not-found"
            ? {ok: false, kind: "missing"}
            : {ok: false, kind: "response"};
    }
    const element = decodeDetailData(envelope.data);
    return element ? {ok: true, element} : {ok: false, kind: "response"};
};

const hasString = (value: UnknownRecord, key: string): boolean =>
    typeof value[key] === "string" && (value[key] as string).trim().length > 0;

const getString = (value: UnknownRecord, key: string): string =>
    value[key] as string;

const learningSessionStatuses = new Set<LearningSessionStatus>(["active", "completed"]);
const learningSessionStages = new Set<LearningSessionStage>(["outstanding", "pending", "finalDrill", "completed"]);
const learningSessionPhases = new Set<LearningSessionPhase>(["question", "answer", "confirmation", "completed"]);

const decodeLearningSession = (value: unknown): LearningSessionProjection | undefined => {
    if (!isRecord(value) || typeof value.status !== "string" ||
        !learningSessionStatuses.has(value.status as LearningSessionStatus) ||
        typeof value.phase !== "string" || !learningSessionPhases.has(value.phase as LearningSessionPhase)) {
        return undefined;
    }
    if (hasOwn(value, "sessionId") && !hasString(value, "sessionId")) {
        return undefined;
    }
    if (hasOwn(value, "stage") && (typeof value.stage !== "string" ||
        !learningSessionStages.has(value.stage as LearningSessionStage))) {
        return undefined;
    }

    const remainingElementIds = value.remainingElementIds === undefined ? [] : value.remainingElementIds;
    if (!Array.isArray(remainingElementIds) || remainingElementIds.some((item) =>
        typeof item !== "string" || item.trim().length === 0)) {
        return undefined;
    }
    if (hasOwn(value, "pendingAcceptedEventId") && !hasString(value, "pendingAcceptedEventId")) {
        return undefined;
    }

    let current: LearningSessionProjection["current"];
    if (hasOwn(value, "current")) {
        if (!isRecord(value.current) || !hasString(value.current, "kind") || !hasString(value.current, "elementId")) {
            return undefined;
        }
        if (value.current.kind === "element.topic") {
            current = {kind: "element.topic", elementId: getString(value.current, "elementId")};
        } else if (value.current.kind === "element.item" && typeof value.current.prompt === "string" &&
            value.current.prompt.trim().length > 0) {
            const hasAnswer = hasOwn(value.current, "answer");
            if ((value.phase === "question" && hasAnswer) ||
                (value.phase === "answer" && (!hasAnswer || typeof value.current.answer !== "string" ||
                    value.current.answer.trim().length === 0)) ||
                (value.phase !== "question" && value.phase !== "answer")) {
                return undefined;
            }
            current = {
                kind: "element.item",
                elementId: getString(value.current, "elementId"),
                prompt: value.current.prompt,
            };
            if (value.phase === "answer") current.answer = value.current.answer as string;
        } else {
            return undefined;
        }
    }

    const session: LearningSessionProjection = {
        status: value.status as LearningSessionStatus,
        phase: value.phase as LearningSessionPhase,
        remainingElementIds: [...remainingElementIds],
    };
    if (hasString(value, "sessionId")) session.sessionId = getString(value, "sessionId");
    if (typeof value.stage === "string") session.stage = value.stage as LearningSessionStage;
    if (current) session.current = current;
    if (hasString(value, "pendingAcceptedEventId")) {
        session.pendingAcceptedEventId = getString(value, "pendingAcceptedEventId");
    }
    if (hasOwn(value, "confirmation")) {
        if (!isRecord(value.confirmation) ||
            (value.confirmation.stage !== "pending" && value.confirmation.stage !== "finalDrill") ||
            value.phase !== "confirmation" || value.stage !== value.confirmation.stage || current) {
            return undefined;
        }
        session.confirmation = {stage: value.confirmation.stage};
    } else if (value.phase === "confirmation") {
        return undefined;
    }
    return session;
};

const sessionTransportFailure = (kind: "request" | "response"): SessionCallResult => ({
    ok: false,
    failure: {errorCode: kind, retryable: true, kind},
});

const decodeSessionFailure = (envelope: UnknownRecord & {code: number; msg: string; data: unknown}): SessionCallFailure => {
    if (!isRecord(envelope.data)) {
        return {errorCode: "host-rejected", retryable: false, kind: "domain"};
    }
    const failure: SessionCallFailure = {
        errorCode: typeof envelope.data.errorCode === "string" ? envelope.data.errorCode : "host-rejected",
        retryable: typeof envelope.data.retryable === "boolean" ? envelope.data.retryable : false,
        kind: "domain",
    };
    const session = decodeLearningSession(envelope.data.session);
    if (session) failure.session = session;
    return failure;
};

const callLearningSession = async (endpoint: string): Promise<SessionCallResult> => {
    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(endpoint, {});
    } catch (error) {
        return sessionTransportFailure(failureKind(error));
    }
    if (!hasEnvelopeShape(envelope)) {
        return sessionTransportFailure("response");
    }
    if (envelope.code !== 0) {
        return {ok: false, failure: decodeSessionFailure(envelope)};
    }
    const session = decodeLearningSession(envelope.data);
    return session ? {ok: true, session} : sessionTransportFailure("response");
};

export const getCurrentLearningSession = (): Promise<SessionCallResult> =>
    callLearningSession(CURRENT_LEARNING_ENDPOINT);

export const startLearning = (): Promise<SessionCallResult> =>
    callLearningSession(START_LEARNING_ENDPOINT);

export const stopLearning = (): Promise<SessionCallResult> =>
    callLearningSession(STOP_LEARNING_ENDPOINT);

const callLearningSessionAction = async (endpoint: string, request: UnknownRecord): Promise<SessionCallResult> => {
    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(endpoint, request);
    } catch (error) {
        return sessionTransportFailure(failureKind(error));
    }
    if (!hasEnvelopeShape(envelope)) return sessionTransportFailure("response");
    if (envelope.code !== 0) return {ok: false, failure: decodeSessionFailure(envelope)};
    const session = decodeLearningSession(envelope.data);
    return session ? {ok: true, session} : sessionTransportFailure("response");
};

export const showAnswer = (elementId: string): Promise<SessionCallResult> => {
    if (!hasString({elementId}, "elementId")) return Promise.resolve(sessionTransportFailure("response"));
    return callLearningSessionAction(SHOW_ANSWER_ENDPOINT, {elementId});
};

const validStage = (stage: unknown): stage is "pending" | "finalDrill" =>
    stage === "pending" || stage === "finalDrill";

export const acceptLearningStage = (stage: "pending" | "finalDrill"): Promise<SessionCallResult> =>
    validStage(stage)
        ? callLearningSessionAction(ACCEPT_STAGE_ENDPOINT, {stage})
        : Promise.resolve(sessionTransportFailure("response"));

export const declineLearningStage = (stage: "pending" | "finalDrill"): Promise<SessionCallResult> =>
    validStage(stage)
        ? callLearningSessionAction(DECLINE_STAGE_ENDPOINT, {stage})
        : Promise.resolve(sessionTransportFailure("response"));

const gradeTransportFailure = (kind: "request" | "response"): ItemGradeCallResult => ({
    ok: false,
    failure: {errorCode: kind, retryable: true, acceptance: "unknown", kind},
});

const decodeFormalReviewFailure = (
    envelope: UnknownRecord & {code: number; msg: string; data: unknown},
    submittedEventId: string,
): ItemGradeCallResult => {
    if (!isRecord(envelope.data)) {
        return {ok: false, failure: {errorCode: "host-rejected", retryable: false, acceptance: "unknown", kind: "domain"}};
    }
    const data = envelope.data;
    const acceptedEventId = hasString(data, "acceptedEventId") ? getString(data, "acceptedEventId") : undefined;
    const acceptedIdentityMatches = data.reviewAccepted === true && acceptedEventId === submittedEventId;
    const failure: Extract<ItemGradeCallResult, {ok: false}>["failure"] = {
        errorCode: hasString(data, "errorCode") ? getString(data, "errorCode") : "host-rejected",
        retryable: typeof data.retryable === "boolean" ? data.retryable : false,
        acceptance: acceptedIdentityMatches ? "accepted" : data.reviewAccepted === false ? "notAccepted" : "unknown",
        kind: "domain",
    };
    if (acceptedIdentityMatches) failure.acceptedEventId = acceptedEventId;
    const session = decodeLearningSession(data.session);
    if (session) failure.session = session;
    return {ok: false, failure};
};

export const gradeItem = async (
    elementId: string,
    eventId: string,
    rawGrade: 0 | 1 | 2 | 3 | 4 | 5,
): Promise<ItemGradeCallResult> => {
    if (!hasString({elementId}, "elementId") || !hasString({eventId}, "eventId") ||
        !Number.isInteger(rawGrade) || rawGrade < 0 || rawGrade > 5) {
        return gradeTransportFailure("response");
    }
    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(GRADE_ITEM_ENDPOINT, {elementId, rawGrade, eventId});
    } catch (error) {
        return gradeTransportFailure(failureKind(error));
    }
    if (!hasEnvelopeShape(envelope)) return gradeTransportFailure("response");
    if (envelope.code !== 0) return decodeFormalReviewFailure(envelope, eventId);
    const data = envelope.data;
    if (!isRecord(data) || data.reviewAccepted !== true || data.eventId !== eventId || data.rawGrade !== rawGrade ||
        data.passed !== (rawGrade >= 3) || data.ratingMapping !== "supermemo-grade-v1") {
        return gradeTransportFailure("response");
    }
    const session = decodeLearningSession(data.session);
    return session
        ? {ok: true, eventId, rawGrade, reviewAccepted: true, session}
        : gradeTransportFailure("response");
};

const nextTransportFailure = (kind: "request" | "response"): TopicNextCallResult => ({
    ok: false,
    failure: {
        errorCode: kind,
        retryable: true,
        acceptance: "unknown",
        kind,
    },
});

const decodeTopicNextFailure = (
    envelope: UnknownRecord & {code: number; msg: string; data: unknown},
): TopicNextCallResult => {
    if (!isRecord(envelope.data)) {
        return {
            ok: false,
            failure: {
                errorCode: "host-rejected",
                retryable: false,
                acceptance: "unknown",
                kind: "domain",
            },
        };
    }
    const data = envelope.data;
    const failure: Extract<TopicNextCallResult, {ok: false}>["failure"] = {
        errorCode: hasString(data, "errorCode") ? getString(data, "errorCode") : "host-rejected",
        retryable: typeof data.retryable === "boolean" ? data.retryable : false,
        acceptance: data.reviewAccepted === true
            ? "accepted"
            : data.reviewAccepted === false ? "notAccepted" : "unknown",
        kind: "domain",
    };
    if (hasString(data, "acceptedEventId")) failure.acceptedEventId = getString(data, "acceptedEventId");
    const session = decodeLearningSession(data.session);
    if (session) failure.session = session;
    return {ok: false, failure};
};

export const nextTopic = async (elementId: string, eventId: string): Promise<TopicNextCallResult> => {
    if (typeof elementId !== "string" || elementId.trim().length === 0 ||
        typeof eventId !== "string" || eventId.trim().length === 0) {
        return nextTransportFailure("response");
    }

    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(NEXT_TOPIC_ENDPOINT, {elementId, eventId});
    } catch (error) {
        return nextTransportFailure(failureKind(error));
    }
    if (!hasEnvelopeShape(envelope)) {
        return nextTransportFailure("response");
    }
    if (envelope.code !== 0) {
        return decodeTopicNextFailure(envelope);
    }
    if (!isRecord(envelope.data) ||
        envelope.data.reviewAccepted !== true || envelope.data.eventId !== eventId) {
        return nextTransportFailure("response");
    }
    const session = decodeLearningSession(envelope.data.session);
    return session ? {ok: true, eventId, reviewAccepted: true, session} : nextTransportFailure("response");
};

const decodeAcceptedChange = (value: unknown): AcceptedElementChange | undefined => {
    if (!isRecord(value) ||
        (value.kind !== "RenameElement" && value.kind !== "SaveTopicHTML") ||
        !hasString(value, "elementId") ||
        (value.changedField !== "title" && value.changedField !== "material") ||
        typeof value.canonicalValue !== "string" ||
        !hasString(value, "revision") ||
        typeof value.changed !== "boolean" ||
        value.changeAccepted !== true) {
        return undefined;
    }

    const change: AcceptedElementChange = {
        kind: value.kind as AcceptedElementChange["kind"],
        elementId: getString(value, "elementId"),
        changedField: value.changedField as AcceptedElementChange["changedField"],
        canonicalValue: getString(value, "canonicalValue"),
        revision: getString(value, "revision"),
        changed: value.changed,
        changeAccepted: true,
    };
    if (typeof value.cleaningPolicyVersion === "string") {
        change.cleaningPolicyVersion = value.cleaningPolicyVersion;
    }
    if (Array.isArray(value.nodeIdentityAssignments)) {
        const assignments = value.nodeIdentityAssignments.map((assignment) => {
            if (!isRecord(assignment) || !hasString(assignment, "clientNodeKey") || !hasString(assignment, "nodeId")) {
                return undefined;
            }
            return {
                clientNodeKey: getString(assignment, "clientNodeKey"),
                nodeId: getString(assignment, "nodeId"),
            };
        });
        if (assignments.some((assignment) => !assignment)) {
            return undefined;
        }
        change.nodeIdentityAssignments = assignments as AcceptedElementChange["nodeIdentityAssignments"];
    }
    return change;
};

const decodeChangeFailure = (envelope: UnknownRecord & {code: number; msg: string; data: unknown}): ElementChangeFailure => {
    if (!isRecord(envelope.data)) {
        return {kind: "failed", errorCode: "host-rejected", retryable: false, acceptanceUnknown: false};
    }
    const data = envelope.data;
    if (data.errorCode === "element-revision-conflict" &&
        hasString(data, "elementId") &&
        (data.changedField === "title" || data.changedField === "material") &&
        hasString(data, "currentRevision")) {
        return {
            kind: "conflict",
            elementId: getString(data, "elementId"),
            changedField: data.changedField as ElementAuthoringField,
            currentRevision: getString(data, "currentRevision"),
        };
    }
    if (data.changeAccepted === true) {
        const accepted = decodeAcceptedChange(data.change);
        if (accepted) {
            return {kind: "acceptedRecovering", change: accepted};
        }
    }
    if (typeof data.errorCode === "string" && typeof data.retryable === "boolean") {
        return {
            kind: "failed",
            errorCode: data.errorCode,
            retryable: data.retryable,
            acceptanceUnknown: data.errorCode === "element-write-partial",
        };
    }
    return {kind: "failed", errorCode: "host-rejected", retryable: false, acceptanceUnknown: false};
};

const changeTransportFailure = (errorCode: "request" | "response"): ElementChangeResult => ({
    ok: false,
    failure: {kind: "failed", errorCode, retryable: true, acceptanceUnknown: true},
});

const createTransportFailure = (errorCode: "request" | "response"): CreateHTMLTopicResult => ({
    ok: false,
    failure: {errorCode, retryable: false, acceptanceUnknown: true},
});

const decodeCreateSuccess = (value: unknown): CreateHTMLTopicResult | undefined => {
    if (!isRecord(value) || !hasString(value, "elementId") || !hasString(value, "eventId") ||
        value.createAccepted !== true || typeof value.reviewAccepted !== "boolean" || value.retryable !== false ||
        !isRecord(value.topic) || value.topic.elementId !== value.elementId) {
        return undefined;
    }
    return {
        ok: true,
        elementId: getString(value, "elementId"),
        eventId: getString(value, "eventId"),
        createAccepted: true,
        reviewAccepted: value.reviewAccepted,
        retryable: false,
    };
};

export const createHTMLTopic = async (title: string, html: string): Promise<CreateHTMLTopicResult> => {
    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(CREATE_ENDPOINT, {title, html});
    } catch (error) {
        return createTransportFailure(failureKind(error));
    }
    if (!hasEnvelopeShape(envelope)) {
        return createTransportFailure("response");
    }
    if (envelope.code !== 0) {
        if (isRecord(envelope.data) && typeof envelope.data.errorCode === "string" &&
            typeof envelope.data.retryable === "boolean") {
            return {
                ok: false,
                failure: {
                    errorCode: envelope.data.errorCode,
                    retryable: envelope.data.retryable,
                    acceptanceUnknown: envelope.data.errorCode === "element-write-partial",
                    acceptedElementId: envelope.data.createAccepted === true && typeof envelope.data.elementId === "string"
                        ? envelope.data.elementId
                        : undefined,
                },
            };
        }
        return {ok: false, failure: {errorCode: "host-rejected", retryable: false, acceptanceUnknown: false}};
    }
    return decodeCreateSuccess(envelope.data) || createTransportFailure("response");
};

const createItemTransportFailure = (kind: "request" | "response"): CreateItemResult => ({
    ok: false,
    failure: {errorCode: kind, retryable: true, acceptance: "unknown", kind},
});

export const createItem = async (elementId: string, prompt: string, answer: string): Promise<CreateItemResult> => {
    if (!hasString({elementId}, "elementId") || typeof prompt !== "string" || prompt.trim().length === 0 ||
        typeof answer !== "string" || answer.trim().length === 0) {
        return {
            ok: false,
            failure: {
                errorCode: "invalid-item-content",
                retryable: false,
                acceptance: "notAccepted",
                kind: "response",
            },
        };
    }

    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(CREATE_ITEM_ENDPOINT, {elementId, prompt, answer});
    } catch (error) {
        return createItemTransportFailure(failureKind(error));
    }
    if (!hasEnvelopeShape(envelope)) {
        return createItemTransportFailure("response");
    }
    if (envelope.code !== 0) {
        if (!isRecord(envelope.data)) {
            return {
                ok: false,
                failure: {
                    errorCode: "host-rejected",
                    retryable: false,
                    acceptance: "unknown",
                    kind: "domain",
                },
            };
        }
        const accepted = envelope.data.createAccepted === true && envelope.data.elementId === elementId;
        return {
            ok: false,
            failure: {
                errorCode: hasString(envelope.data, "errorCode") ? getString(envelope.data, "errorCode") : "host-rejected",
                retryable: typeof envelope.data.retryable === "boolean" ? envelope.data.retryable : false,
                acceptance: accepted ? "accepted" : envelope.data.createAccepted === false ? "notAccepted" : "unknown",
                acceptedElementId: accepted ? elementId : undefined,
                kind: "domain",
            },
        };
    }

    const data = envelope.data;
    if (!isRecord(data) || data.elementId !== elementId || data.createAccepted !== true ||
        data.reviewAccepted !== false || data.retryable !== false ||
        (hasOwn(data, "eventId") && data.eventId !== "") || !isRecord(data.item) ||
        data.item.elementId !== elementId || data.item.processingState !== "processed" ||
        !hasString(data.item, "contentRevision") || data.item.lifecycleState !== "pending" ||
        (hasOwn(data.item, "sourcePath") && typeof data.item.sourcePath !== "string") ||
        (hasOwn(data.item, "sortRank") && (!Number.isInteger(data.item.sortRank) ||
            typeof data.item.sortRank !== "number"))) {
        return createItemTransportFailure("response");
    }
    return {
        ok: true,
        item: {
            elementId,
            processingState: "processed",
            contentRevision: getString(data.item, "contentRevision"),
            sourcePath: typeof data.item.sourcePath === "string" ? data.item.sourcePath : undefined,
            sortRank: typeof data.item.sortRank === "number" ? data.item.sortRank : undefined,
            lifecycleState: "pending",
        },
    };
};

const itemAuthoringFailure = (
    errorCode: string,
    retryable: boolean,
    kind: "request" | "response" | "domain",
): ItemAuthoringResult => ({ok: false, failure: {errorCode, retryable, kind}});

export const getItemAuthoring = async (elementId: string): Promise<ItemAuthoringResult> => {
    if (!hasString({elementId}, "elementId")) {
        return itemAuthoringFailure("response", false, "response");
    }
    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(ITEM_AUTHORING_ENDPOINT, {elementId});
    } catch (error) {
        const kind = failureKind(error);
        return itemAuthoringFailure(kind, true, kind);
    }
    if (!hasEnvelopeShape(envelope)) {
        return itemAuthoringFailure("response", true, "response");
    }
    if (envelope.code !== 0) {
        return isRecord(envelope.data)
            ? itemAuthoringFailure(
                hasString(envelope.data, "errorCode") ? getString(envelope.data, "errorCode") : "host-rejected",
                typeof envelope.data.retryable === "boolean" ? envelope.data.retryable : false,
                "domain",
            )
            : itemAuthoringFailure("host-rejected", false, "domain");
    }
    const data = envelope.data;
    if (!isRecord(data) || data.elementId !== elementId || typeof data.prompt !== "string" ||
        data.prompt.trim().length === 0 || typeof data.answer !== "string" || data.answer.trim().length === 0 ||
        !hasString(data, "contentRevision")) {
        return itemAuthoringFailure("response", true, "response");
    }
    return {
        ok: true,
        authoring: {
            elementId,
            prompt: data.prompt,
            answer: data.answer,
            contentRevision: getString(data, "contentRevision"),
        },
    };
};

const decodeAcceptedItemQAChange = (value: unknown): AcceptedItemQAChange | undefined => {
    if (!isRecord(value) || value.kind !== "SaveItemQA" || !hasString(value, "elementId") ||
        value.changedField !== "itemQA" || !hasString(value, "revision") || !isRecord(value.itemQA) ||
        typeof value.itemQA.prompt !== "string" || value.itemQA.prompt.trim().length === 0 ||
        typeof value.itemQA.answer !== "string" || value.itemQA.answer.trim().length === 0 ||
        value.itemQA.contentRevision !== value.revision || typeof value.changed !== "boolean" ||
        value.changeAccepted !== true || hasOwn(value, "canonicalValue")) {
        return undefined;
    }
    return {
        kind: "SaveItemQA",
        elementId: getString(value, "elementId"),
        changedField: "itemQA",
        revision: getString(value, "revision"),
        itemQA: {
            prompt: value.itemQA.prompt,
            answer: value.itemQA.answer,
            contentRevision: getString(value, "revision"),
        },
        changed: value.changed,
        changeAccepted: true,
    };
};

const itemQAChangeTransportFailure = (errorCode: "request" | "response"): ItemQAChangeResult => ({
    ok: false,
    failure: {kind: "failed", errorCode, retryable: true, acceptanceUnknown: true},
});

export const saveItemQA = async (
    elementId: string,
    expectedContentRevision: string,
    prompt: string,
    answer: string,
): Promise<ItemQAChangeResult> => {
    if (!hasString({elementId}, "elementId") || !hasString({expectedContentRevision}, "expectedContentRevision") ||
        typeof prompt !== "string" || prompt.trim().length === 0 || typeof answer !== "string" ||
        answer.trim().length === 0) {
        return {
            ok: false,
            failure: {kind: "failed", errorCode: "invalid-item-content", retryable: false, acceptanceUnknown: false},
        };
    }
    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(SAVE_ITEM_QA_ENDPOINT, {elementId, expectedContentRevision, prompt, answer});
    } catch (error) {
        return itemQAChangeTransportFailure(failureKind(error));
    }
    if (!hasEnvelopeShape(envelope)) {
        return itemQAChangeTransportFailure("response");
    }
    if (envelope.code === 0) {
        const change = decodeAcceptedItemQAChange(envelope.data);
        return change ? {ok: true, change} : itemQAChangeTransportFailure("response");
    }
    if (!isRecord(envelope.data)) {
        return {ok: false, failure: {kind: "failed", errorCode: "host-rejected", retryable: false, acceptanceUnknown: false}};
    }
    const data = envelope.data;
    if (data.errorCode === "element-revision-conflict" && data.changeAccepted === false &&
        data.elementId === elementId && data.changedField === "itemQA" && hasString(data, "currentRevision")) {
        return {
            ok: false,
            failure: {
                kind: "conflict",
                elementId,
                changedField: "itemQA",
                currentRevision: getString(data, "currentRevision"),
            },
        };
    }
    if (data.changeAccepted === true) {
        const change = decodeAcceptedItemQAChange(data.acceptedChange);
        if (change && change.elementId === elementId) {
            return {ok: false, failure: {kind: "acceptedRecovering", change}};
        }
    }
    return {
        ok: false,
        failure: {
            kind: "failed",
            errorCode: hasString(data, "errorCode") ? getString(data, "errorCode") : "host-rejected",
            retryable: typeof data.retryable === "boolean" ? data.retryable : false,
            acceptanceUnknown: data.changeAccepted !== false,
        },
    };
};

const changeElement = async (
    endpoint: string,
    request: UnknownRecord,
): Promise<ElementChangeResult> => {
    let envelope: unknown;
    try {
        envelope = await fetchSyncPost(endpoint, request);
    } catch (error) {
        return changeTransportFailure(failureKind(error));
    }
    if (!hasEnvelopeShape(envelope)) {
        return changeTransportFailure("response");
    }
    if (envelope.code !== 0) {
        return {ok: false, failure: decodeChangeFailure(envelope)};
    }
    const change = decodeAcceptedChange(envelope.data);
    return change ? {ok: true, change} : changeTransportFailure("response");
};

export const renameElement = async (
    elementId: string,
    expectedTitleRevision: string,
    title: string,
): Promise<ElementChangeResult> => changeElement(RENAME_ENDPOINT, {
    elementId,
    expectedTitleRevision,
    title,
});

export const saveTopicHTML = async (
    elementId: string,
    expectedMaterialRevision: string,
    html: string,
): Promise<ElementChangeResult> => changeElement(SAVE_TOPIC_HTML_ENDPOINT, {
    elementId,
    expectedMaterialRevision,
    html,
});
