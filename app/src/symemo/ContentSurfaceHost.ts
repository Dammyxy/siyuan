import type {
    ActiveItemLearningTarget,
    ElementDetailView,
    LearningSessionProjection,
    ModelTransitionReason,
    ModelTransitionResult,
    RendererUnavailableReason,
} from "./types";

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
    | {kind: "itemAuthoring"}
    | {kind: "itemReview"; session: LearningSessionProjection}
    | {kind: "unavailable"; reason: RendererUnavailableReason};

export type ContentPresentation =
    | {kind: "ordinary"}
    | {
        kind: "activeItemReview";
        sessionId: string;
        phase: "question" | "answer";
        target: ActiveItemLearningTarget;
    };

export interface ContentSurfaceHostOptions {
    container: HTMLElement;
    createWritableSurface(detail: ElementDetailView): ElementContentSurface;
    createItemAuthoringSurface?(detail: ElementDetailView): ElementContentSurface;
    createItemReviewSurface?(): {
        mount(session: LearningSessionProjection): void;
        update(session: LearningSessionProjection): void;
        prepareTransition(reason: ModelTransitionReason): ModelTransitionResult;
        focus(): void;
        destroy(): void;
    };
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

export const getContentSurfaceDecision = (
    detail: ElementDetailView,
    presentation: ContentPresentation = {kind: "ordinary"},
): ContentSurfaceDecision => {
    if (presentation.kind === "activeItemReview") {
        if (detail.type !== "item" || detail.supportStatus !== "supported" || detail.item?.kind !== "qa" ||
            presentation.target.elementId !== detail.elementId || !presentation.sessionId.trim() ||
            presentation.target.prompt.trim().length === 0 ||
            (presentation.phase === "answer" && (!presentation.target.answer || isReadOnlyMode()))) {
            return {kind: "unavailable", reason: "unsupportedRead"};
        }
        return {
            kind: "itemReview",
            session: {
                sessionId: presentation.sessionId,
                status: "active",
                stage: "outstanding",
                phase: presentation.phase,
                current: presentation.target,
                remainingElementIds: [],
            },
        };
    }
    if (detail.type === "item") {
        return detail.supportStatus === "supported" && detail.item?.kind === "qa" &&
            detail.item.prompt.trim().length > 0 && detail.item.revision.trim().length > 0
            ? {kind: "itemAuthoring"}
            : {kind: "unavailable", reason: "unsupportedRead"};
    }
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
    private itemReviewSurface?: ReturnType<NonNullable<ContentSurfaceHostOptions["createItemReviewSurface"]>>;
    private currentSurfaceKey?: string;
    private itemReviewKey?: string;
    private mountGeneration = 0;

    constructor(private readonly options: ContentSurfaceHostOptions) {}

    public async mount(detail: ElementDetailView, presentation: ContentPresentation = {kind: "ordinary"}): Promise<void> {
        const decision = getContentSurfaceDecision(detail, presentation);
        if (decision.kind === "itemReview") {
            const reviewKey = `${detail.elementId}:${decision.session.sessionId}`;
            if (this.itemReviewSurface && this.itemReviewKey === reviewKey) {
                this.itemReviewSurface.update(decision.session);
                return;
            }
            this.mountGeneration++;
            this.destroyItemReview();
            this.destroyCurrent();
            this.options.container.replaceChildren();
            if (!this.options.createItemReviewSurface) {
                this.options.renderUnavailable(this.options.container, detail, "unsupportedRead");
                return;
            }
            this.itemReviewSurface = this.options.createItemReviewSurface();
            this.itemReviewKey = reviewKey;
            this.itemReviewSurface.mount(decision.session);
            return;
        }
        const surfaceKey = decision.kind === "writableTopic" || decision.kind === "itemAuthoring"
            ? `${decision.kind}:${detail.elementId}`
            : undefined;
        if (surfaceKey && this.currentSurface && this.currentSurfaceKey === surfaceKey && !this.itemReviewSurface) {
            return;
        }
        const generation = ++this.mountGeneration;
        this.destroyItemReview();
        this.destroyCurrent();
        this.options.container.replaceChildren();
        if (decision.kind === "writableTopic") {
            const surface = this.options.createWritableSurface(detail);
            this.currentSurface = surface;
            this.currentSurfaceKey = surfaceKey;
            try {
                await surface.mount(detail);
            } catch (error) {
                if (generation !== this.mountGeneration) return;
                if (this.currentSurface === surface) {
                    this.currentSurface = undefined;
                    this.currentSurfaceKey = undefined;
                }
                surface.destroy();
                throw error;
            }
            return;
        }
        if (decision.kind === "itemAuthoring" && this.options.createItemAuthoringSurface) {
            const surface = this.options.createItemAuthoringSurface(detail);
            this.currentSurface = surface;
            this.currentSurfaceKey = surfaceKey;
            try {
                await surface.mount(detail);
            } catch (error) {
                if (generation !== this.mountGeneration) return;
                if (this.currentSurface === surface) {
                    this.currentSurface = undefined;
                    this.currentSurfaceKey = undefined;
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
        if (decision.kind === "unavailable") {
            this.options.renderUnavailable(this.options.container, detail, decision.reason);
        }
    }

    public async prepareTransition(reason: ModelTransitionReason): Promise<ModelTransitionResult> {
        if (this.itemReviewSurface) return this.itemReviewSurface.prepareTransition(reason);
        return this.currentSurface?.prepareTransition(reason) ?? {allowed: true};
    }

    public focus(): void {
        if (this.itemReviewSurface) this.itemReviewSurface.focus();
        else this.currentSurface?.focus();
    }

    public setWindowBarrier(active: boolean): void {
        this.currentSurface?.setWindowBarrier?.(active);
    }

    public destroy(): void {
        this.mountGeneration++;
        this.destroyItemReview();
        this.destroyCurrent();
        this.options.container.replaceChildren();
    }

    private destroyCurrent(): void {
        this.currentSurface?.destroy();
        this.currentSurface = undefined;
        this.currentSurfaceKey = undefined;
    }

    private destroyItemReview(): void {
        this.itemReviewSurface?.destroy();
        this.itemReviewSurface = undefined;
        this.itemReviewKey = undefined;
    }
}
