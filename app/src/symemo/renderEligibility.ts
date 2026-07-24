import type {ElementDetailView, RenderDecision} from "./types";

export const TOPIC_HTML_CLEANING_POLICY = "siyuanmemo-topic-html-v1";

export const getRenderDecision = (detail: ElementDetailView): RenderDecision => {
    if (detail.supportStatus !== "supported") {
        return {kind: "rendererUnavailable", reason: "unsupportedRead"};
    }
    if (detail.type !== "topic") {
        return {kind: "rendererUnavailable", reason: "unsupportedElementType"};
    }
    if (detail.sourceMode === "block") {
        return {kind: "rendererUnavailable", reason: "blockBackedTopic"};
    }
    if (detail.sourceMode !== "html" || detail.topicMaterial?.kind !== "html") {
        return {kind: "rendererUnavailable", reason: "unsupportedTopicMaterial"};
    }
    if (typeof detail.topicMaterial.html !== "string" || detail.topicMaterial.html.trim().length === 0) {
        return {kind: "rendererUnavailable", reason: "emptyTopicHTML"};
    }
    if (detail.topicMaterial.cleaningPolicyVersion !== TOPIC_HTML_CLEANING_POLICY) {
        return {kind: "rendererUnavailable", reason: "unsupportedCleaningPolicy"};
    }
    return {kind: "renderedTopic", html: detail.topicMaterial.html};
};
