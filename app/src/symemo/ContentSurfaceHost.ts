import type {ElementDetailView, ModelTransitionReason, ModelTransitionResult, RendererUnavailableReason} from "./types";

export interface ElementContentSurface {
    mount(detail: ElementDetailView): Promise<void>;
    prepareTransition(reason: ModelTransitionReason): Promise<ModelTransitionResult>;
    setWindowBarrier?(active: boolean): void;
    focus(): void;
    destroy(): void;
}

export type ContentSurfaceDecision =
    | {kind: "writableTopic"}
    | {kind: "readOnlyTopic"; html: string}
    | {kind: "unavailable"; reason: RendererUnavailableReason};

export interface ContentSurfaceHostOptions {
    container: HTMLElement;
    createWritableSurface(detail: ElementDetailView): ElementContentSurface;
    renderReadOnly(container: HTMLElement, html: string, detail: ElementDetailView): void;
    renderUnavailable(container: HTMLElement, detail: ElementDetailView, reason: RendererUnavailableReason): void;
}

const TOPIC_HTML_CLEANING_POLICY = "siyuanmemo-topic-html-v1";

const isHTMLTopic = (detail: ElementDetailView): boolean =>
    detail.type === "topic" && detail.sourceMode === "html" && detail.topicMaterial?.kind === "html";

const hasSupportedPolicy = (detail: ElementDetailView): boolean =>
    detail.topicMaterial?.cleaningPolicyVersion === TOPIC_HTML_CLEANING_POLICY;

const hasNonEmptyHTML = (detail: ElementDetailView): detail is ElementDetailView & {topicMaterial: {html: string}} =>
    typeof detail.topicMaterial?.html === "string" && detail.topicMaterial.html.trim().length > 0;

const hasWritableRevisions = (detail: ElementDetailView): boolean =>
    typeof detail.titleRevision === "string" && detail.titleRevision.trim().length > 0 &&
    typeof detail.topicMaterial?.revision === "string" && detail.topicMaterial.revision.trim().length > 0;

const isReadOnlyMode = (): boolean =>
    typeof window !== "undefined" && window.siyuan?.config?.readonly === true;

export const isWritableHTMLTopic = (detail: ElementDetailView): boolean =>
    !isReadOnlyMode() && detail.supportStatus === "supported" && isHTMLTopic(detail) && hasSupportedPolicy(detail) &&
    hasWritableRevisions(detail);

export const getContentSurfaceDecision = (detail: ElementDetailView): ContentSurfaceDecision => {
    if (isReadOnlyMode() && isHTMLTopic(detail) && hasSupportedPolicy(detail) && hasNonEmptyHTML(detail)) {
        return {kind: "readOnlyTopic", html: detail.topicMaterial.html};
    }
    if (isWritableHTMLTopic(detail)) {
        return {kind: "writableTopic"};
    }
    if (detail.type !== "topic") {
        return {kind: "unavailable", reason: "unsupportedElementType"};
    }
    if (detail.sourceMode === "block") {
        return {kind: "unavailable", reason: "blockBackedTopic"};
    }
    if (!isHTMLTopic(detail)) {
        return {kind: "unavailable", reason: "unsupportedTopicMaterial"};
    }
    if (!hasSupportedPolicy(detail)) {
        return {kind: "unavailable", reason: "unsupportedCleaningPolicy"};
    }
    if (hasNonEmptyHTML(detail)) {
        return {kind: "readOnlyTopic", html: detail.topicMaterial.html};
    }
    if (detail.supportStatus !== "supported") {
        return {kind: "unavailable", reason: "unsupportedRead"};
    }
    return {kind: "unavailable", reason: "emptyTopicHTML"};
};

export class ContentSurfaceHost implements ElementContentSurface {
    private currentSurface?: ElementContentSurface;

    constructor(private readonly options: ContentSurfaceHostOptions) {}

    public async mount(detail: ElementDetailView): Promise<void> {
        this.destroyCurrent();
        this.options.container.replaceChildren();
        const decision = getContentSurfaceDecision(detail);
        if (decision.kind === "writableTopic") {
            const surface = this.options.createWritableSurface(detail);
            this.currentSurface = surface;
            try {
                await surface.mount(detail);
            } catch (error) {
                if (this.currentSurface === surface) {
                    this.currentSurface = undefined;
                }
                surface.destroy();
                throw error;
            }
            return;
        }
        if (decision.kind === "readOnlyTopic") {
            this.options.renderReadOnly(this.options.container, decision.html, detail);
            return;
        }
        this.options.renderUnavailable(this.options.container, detail, decision.reason);
    }

    public async prepareTransition(reason: ModelTransitionReason): Promise<ModelTransitionResult> {
        return this.currentSurface?.prepareTransition(reason) ?? {allowed: true};
    }

    public focus(): void {
        this.currentSurface?.focus();
    }

    public setWindowBarrier(active: boolean): void {
        this.currentSurface?.setWindowBarrier?.(active);
    }

    public destroy(): void {
        this.destroyCurrent();
        this.options.container.replaceChildren();
    }

    private destroyCurrent(): void {
        this.currentSurface?.destroy();
        this.currentSurface = undefined;
    }
}
