import {fetchSyncPost} from "../util/fetch";
import {
    ElementDetailResult,
    ElementDetailView,
    ElementTreeResult,
    TopicMaterialView,
} from "./types";
import {decodeElementTreeData} from "./treeState";

const TREE_ENDPOINT = "/api/symemo/getElementTree";
const DETAIL_ENDPOINT = "/api/symemo/getElement";

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
    return material;
};

const decodeDetailData = (value: unknown): ElementDetailView | undefined => {
    if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0 ||
        typeof value.type !== "string" || typeof value.sourceMode !== "string" ||
        typeof value.supportStatus !== "string") {
        return undefined;
    }

    const detail: ElementDetailView = {
        elementId: value.id,
        type: value.type,
        title: normalizeTitle(value.title),
        sourceMode: value.sourceMode,
        supportStatus: value.supportStatus,
    };
    if (value.type === "topic") {
        const topicMaterial = decodeTopicMaterial(value);
        if (topicMaterial) {
            detail.topicMaterial = topicMaterial;
        }
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
