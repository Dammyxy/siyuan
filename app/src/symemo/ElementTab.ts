import type {App} from "../index";
import {openLink} from "../editor/openLink";
import {Model} from "../layout/Model";
import type {Tab} from "../layout/Tab";
import {mathRender} from "../protyle/render/mathRender";
import {genUUID} from "../util/genID";
import {
    acceptLearningStage,
    declineLearningStage,
    getCurrentLearningSession,
    getElement,
    gradeItem,
    nextTopic,
    showAnswer,
    startLearning,
    stopLearning,
} from "./api";
import {ContentPresentation, ContentSurfaceHost, getContentSurfaceDecision} from "./ContentSurfaceHost";
import {ItemAuthoringSurface} from "./ItemAuthoringSurface";
import {ItemReviewSurface} from "./ItemReviewSurface";
import {LearningControls, LearningControlIntent} from "./LearningControls";
import {ElementLearningCoordinator} from "./learning";
import {openElement} from "./openElement";
import {TOPIC_HTML_CLEANING_POLICY} from "./renderEligibility";
import {TopicHtmlSurface} from "./TopicHtmlSurface";
import {registerWindowAuthoringParticipant, runWindowAuthoringOperation} from "./authoringRegistry";
import {elementTypeIcon, getElementDisplayTitle} from "./treeState";
import type {
    ElementDetailResult,
    ElementDetailView,
    ElementTabState,
    ModelTransitionReason,
    ModelTransitionResult,
    RendererUnavailableReason,
} from "./types";

export const deriveElementTabState = (result: ElementDetailResult): ElementTabState => {
    if (result.ok === false) {
        return result.kind === "missing" ? {phase: "missing"} : {phase: "failure", errorKind: result.kind};
    }
    const decision = getContentSurfaceDecision(result.element);
    if (decision.kind === "writableTopic") {
        return {phase: "renderedTopic", detail: result.element, html: result.element.topicMaterial?.html || ""};
    }
    if (decision.kind === "itemAuthoring") {
        return {phase: "itemAuthoring", detail: result.element};
    }
    if (decision.kind === "readOnlyTopic") {
        return {phase: "renderedTopic", detail: result.element, html: decision.html};
    }
    return {
        phase: "rendererUnavailable",
        detail: result.element,
        reason: decision.kind === "unavailable" ? decision.reason : "unsupportedRead",
    };
};

type MathRenderer = (element: HTMLElement) => void;
type LinkOpener = (app: App, href: string, event?: MouseEvent, ctrlIsPressed?: boolean) => unknown;

const prepareMathRenderFrames = (content: HTMLElement): void => {
    if (typeof content.querySelectorAll !== "function") {
        return;
    }
    content.querySelectorAll<HTMLElement>('div[data-type="NodeMathBlock"][data-subtype="math"]').forEach((mathElement) => {
        if (!mathElement.firstElementChild) {
            mathElement.append(mathElement.ownerDocument.createElement("div"));
        }
    });
};

export const renderReadOnlyTopic = (content: HTMLElement, html: string, renderMath: MathRenderer = mathRender): void => {
    content.setAttribute("contenteditable", "false");
    content.innerHTML = html;
    prepareMathRenderFrames(content);
    renderMath(content);
};

export const classifyReaderHref = (href: string | null | undefined): "fragment" | "link" | "none" => {
    if (!href) {
        return "none";
    }
    return href.startsWith("#") ? "fragment" : "link";
};

const escapeAttributeSelectorValue = (value: string): string => Array.from(value).map((character) => {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return "\\" + code.toString(16) + " ";
    if (character === "\\") return "\\\\";
    if (character === '"') return "\\\"";
    return character;
}).join("");

export const handleReaderLinkClick = (
    app: App,
    content: HTMLElement,
    event: MouseEvent,
    open: LinkOpener = openLink,
): void => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || !content.contains(anchor)) {
        return;
    }
    const href = anchor.getAttribute("href");
    if (!href) {
        return;
    }
    const classification = classifyReaderHref(href);
    event.preventDefault();
    event.stopPropagation();

    if (classification === "fragment") {
        let fragment: string;
        try {
            fragment = decodeURIComponent(href.slice(1));
        } catch (_) {
            return;
        }
        if (!fragment) {
            return;
        }
        const escaped = escapeAttributeSelectorValue(fragment);
        const selector = '[id="' + escaped + '"], [data-node-id="' + escaped + '"]';
        const fragmentTarget = content.querySelector(selector) as HTMLElement | null;
        fragmentTarget?.scrollIntoView();
        return;
    }

    open(app, href, event, event.ctrlKey || event.metaKey);
};

const language = (key: string): string => window.siyuan?.languages?.[key] || "";

const isSupportedLearningTopic = (detail: ElementDetailView): boolean =>
    detail.type === "topic" && detail.sourceMode === "html" && detail.supportStatus === "supported" &&
    detail.topicMaterial?.kind === "html" &&
    detail.topicMaterial.cleaningPolicyVersion === TOPIC_HTML_CLEANING_POLICY;

const isSupportedLearningItem = (detail: ElementDetailView): boolean =>
    detail.type === "item" && detail.supportStatus === "supported" && detail.item?.kind === "qa" &&
    detail.item.prompt.trim().length > 0 && detail.item.revision.trim().length > 0;

const unavailableLanguageKey: Record<RendererUnavailableReason, string> = {
    unsupportedRead: "symemoUnsupportedRead",
    unsupportedElementType: "symemoUnsupportedElementType",
    blockBackedTopic: "symemoBlockBackedTopic",
    unsupportedTopicMaterial: "symemoUnsupportedTopicMaterial",
    emptyTopicHTML: "symemoEmptyTopicHTML",
    unsupportedCleaningPolicy: "symemoUnsupportedCleaningPolicy",
};

export class ElementTab extends Model {
    public readonly elementId: string;
    public state: ElementTabState = {phase: "loading"};
    public readerElement?: HTMLElement;
    private readonly tab: Tab;
    private readonly panelElement: HTMLElement;
    private readonly contentElement: HTMLElement;
    private readonly controlsElement: HTMLElement;
    private readonly surfaceHost: ContentSurfaceHost;
    private readonly learningControls: LearningControls;
    private learningCoordinator?: ElementLearningCoordinator;
    private unregisterAuthoring?: () => void;
    private requestGeneration = 0;
    private requesting = false;
    private windowBarrierActive = false;
    private replacementReadyWhenUnblocked = false;
    private pendingMount?: {detail: ElementDetailView; generation: number};
    private disposed = false;
    private detailKnown = false;
    private supportedTopic = false;
    private supportedItem = false;
    private learningUnavailable = false;
    private detail?: ElementDetailView;

    constructor(options: {app: App; tab: Tab; elementId: string}) {
        super({app: options.app});
        this.tab = options.tab;
        this.panelElement = options.tab.panelElement;
        this.elementId = options.elementId;
        this.panelElement.classList.add("symemo-element-tab", "fn__flex", "fn__flex-column");
        this.panelElement.replaceChildren();
        this.contentElement = document.createElement("div");
        this.contentElement.className = "symemo-element-tab__surface fn__flex-1";
        this.controlsElement = document.createElement("div");
        this.panelElement.append(this.contentElement, this.controlsElement);
        this.learningControls = new LearningControls({
            container: this.controlsElement,
            onIntent: (intent) => this.handleLearningIntent(intent),
        });
        this.surfaceHost = new ContentSurfaceHost({
            container: this.contentElement,
            createWritableSurface: () => new TopicHtmlSurface({
                container: this.contentElement,
                onSaveAsNew: (elementId) => {
                    void openElement({
                        app: this.app,
                        elementId,
                        intent: "new",
                        source: "other",
                    });
                },
                onTitleChange: (title) => this.updateTabTitle(title),
                onTransitionReadyChange: (ready) => this.setReplacementReady(ready),
            }),
            createItemAuthoringSurface: () => new ItemAuthoringSurface({
                container: this.contentElement,
                onTransitionReadyChange: (ready) => this.setReplacementReady(ready),
            }),
            createItemReviewSurface: () => new ItemReviewSurface({container: this.contentElement}),
            renderReadOnly: (_container, html) => this.renderTopic(html),
            renderUnavailable: (_container, detail, reason) => this.renderUnavailable(detail, reason),
        });
        try {
            this.unregisterAuthoring = registerWindowAuthoringParticipant({
                id: `symemo-element:${this.tab.id}:${this.elementId}`,
                prepareTransition: (reason) => this.prepareTransition(reason),
                setWindowBarrier: (active) => this.setWindowBarrier(active),
                cleanup: () => this.cleanup(),
            });
        } catch (_) {
            this.windowBarrierActive = true;
            this.setReplacementReady(false);
            this.renderStatus(language("symemoRendererUnavailable") || language("symemoElementLoadFailed"));
            this.learningControls.render({
                phase: "failure",
                busy: false,
                messageKey: "symemoLearningUnavailable",
                displayedElementId: this.elementId,
            });
            return;
        }
        this.learningCoordinator = new ElementLearningCoordinator({
            displayedElementId: this.elementId,
            getDisplayedEligibility: () => ({
                known: this.detailKnown && !this.disposed && this.panelElement.isConnected,
                supportedTopic: this.supportedTopic && !this.disposed && this.panelElement.isConnected,
                supportedItem: this.supportedItem && !this.disposed && this.panelElement.isConnected,
                readOnly: window.siyuan?.config?.readonly === true,
                barrierActive: this.windowBarrierActive,
                unavailable: this.learningUnavailable,
            }),
            prepareTransition: () => this.prepareTransition("target-change"),
            getCurrent: getCurrentLearningSession,
            start: startLearning,
            stop: stopLearning,
            showAnswer,
            gradeItem,
            nextTopic,
            acceptStage: acceptLearningStage,
            declineStage: declineLearningStage,
            createEventId: genUUID,
            followTarget: async (elementId) => {
                if (this.disposed || !this.panelElement.isConnected || this.windowBarrierActive) return false;
                const followed = Boolean(await openElement({
                    app: this.app,
                    elementId,
                    intent: "current",
                    source: "other",
                }));
                return followed && !this.disposed && this.panelElement.isConnected;
            },
            publish: (projection) => {
                if (!this.disposed && this.panelElement.isConnected) {
                    this.learningControls.render(projection);
                }
            },
            publishPresentation: (presentation) => this.projectContentPresentation(presentation),
            runOperation: runWindowAuthoringOperation,
        });
        this.panelElement.addEventListener("click", (event: MouseEvent) => {
            if (this.readerElement) {
                handleReaderLinkClick(this.app, this.readerElement, event);
            }
        });
        void this.load();
    }

    public async load(): Promise<void> {
        if (this.requesting || this.disposed) {
            return;
        }
        this.requesting = true;
        const generation = ++this.requestGeneration;
        this.pendingMount = undefined;
        this.setReplacementReady(false);
        this.state = {phase: "loading"};
        this.detailKnown = false;
        this.supportedTopic = false;
        this.supportedItem = false;
        this.learningUnavailable = false;
        this.detail = undefined;
        this.learningCoordinator?.reproject();
        this.renderStatus(language("loading"));
        const result = await getElement(this.elementId);
        this.requesting = false;
        if (this.disposed || generation !== this.requestGeneration || !this.panelElement.isConnected) {
            return;
        }
        this.state = deriveElementTabState(result);
        this.detailKnown = true;
        this.detail = result.ok ? result.element : undefined;
        if (this.state.phase === "missing") {
            this.renderStatus(language("symemoElementMissing"), true);
            this.setReplacementReady(true);
            this.learningCoordinator?.reproject();
        } else if (this.state.phase === "failure") {
            this.renderStatus(language("symemoElementLoadFailed"), true);
            this.setReplacementReady(true);
            this.learningCoordinator?.reproject();
        } else if (this.state.phase === "renderedTopic") {
            this.updateSafeIdentity(this.state.detail);
            await this.mountWhenAvailable(this.state.detail, generation);
        } else if (this.state.phase === "itemAuthoring") {
            this.updateSafeIdentity(this.state.detail);
            await this.mountWhenAvailable(this.state.detail, generation);
        } else if (this.state.phase === "rendererUnavailable") {
            this.updateSafeIdentity(this.state.detail);
            await this.mountWhenAvailable(this.state.detail, generation);
        }
    }

    public retry(): void {
        void this.load();
    }

    public prepareTransition(reason: ModelTransitionReason): Promise<ModelTransitionResult> {
        return this.surfaceHost.prepareTransition(reason);
    }

    public setWindowBarrier(active: boolean): void {
        if (this.disposed) {
            return;
        }
        this.windowBarrierActive = active;
        this.surfaceHost.setWindowBarrier(active);
        this.learningCoordinator?.reproject();
        this.projectReplacementReady();
        if (!active && this.pendingMount) {
            const pending = this.pendingMount;
            this.pendingMount = undefined;
            void this.mountWhenAvailable(pending.detail, pending.generation);
        }
    }

    public cleanup(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.requestGeneration++;
        this.requesting = false;
        this.learningCoordinator?.destroy();
        this.learningCoordinator = undefined;
        this.unregisterAuthoring?.();
        this.unregisterAuthoring = undefined;
        this.pendingMount = undefined;
        this.detail = undefined;
        this.readerElement = undefined;
        this.surfaceHost.destroy();
        this.learningControls.destroy();
        this.panelElement.replaceChildren();
    }

    public destroy(): void {
        this.cleanup();
    }

    public focus(): void {
        this.surfaceHost.focus();
    }

    private updateSafeIdentity(detail: ElementDetailView): void {
        this.updateTabTitle(detail.title);
        const icon = elementTypeIcon(detail.type);
        this.tab.icon = icon;
        this.tab.headElement?.querySelector(".item__graphic use")?.setAttribute("xlink:href", "#" + icon);
    }

    private projectContentPresentation(presentation: ContentPresentation): void {
        const detail = this.detail;
        if (!detail || this.disposed || this.learningUnavailable || !this.panelElement.isConnected) return;
        const generation = this.requestGeneration;
        void this.surfaceHost.mount(detail, presentation).catch(() => {
            if (this.disposed || generation !== this.requestGeneration || !this.panelElement.isConnected) return;
            this.state = {phase: "failure", errorKind: "response"};
            this.renderStatus(language("symemoElementLoadFailed"), true);
            this.setReplacementReady(true);
            this.supportedTopic = false;
            this.supportedItem = false;
            this.learningUnavailable = true;
            this.learningCoordinator?.reproject();
        });
    }

    private updateTabTitle(title: string): void {
        this.tab.updateTitle(getElementDisplayTitle(title, language("untitled")));
    }

    private setReplacementReady(ready: boolean): void {
        this.replacementReadyWhenUnblocked = ready;
        this.projectReplacementReady();
    }

    private projectReplacementReady(): void {
        if (this.replacementReadyWhenUnblocked && !this.windowBarrierActive) {
            this.tab.headElement?.classList.add("item--unupdate");
        } else {
            this.tab.headElement?.classList.remove("item--unupdate");
        }
    }

    private async mountWhenAvailable(detail: ElementDetailView, generation: number): Promise<void> {
        if (this.disposed || generation !== this.requestGeneration || !this.panelElement.isConnected) {
            return;
        }
        if (this.windowBarrierActive) {
            this.pendingMount = {detail, generation};
            return;
        }
        const decision = getContentSurfaceDecision(detail);
        try {
            await this.surfaceHost.mount(detail);
        } catch (_) {
            if (this.disposed || generation !== this.requestGeneration || !this.panelElement.isConnected) {
                return;
            }
            this.state = {phase: "failure", errorKind: "response"};
            this.renderStatus(language("symemoElementLoadFailed"), true);
            this.setReplacementReady(true);
            this.supportedTopic = false;
            this.learningUnavailable = true;
            this.learningCoordinator?.reproject();
            return;
        }
        if (this.disposed || generation !== this.requestGeneration || !this.panelElement.isConnected) {
            return;
        }
        this.supportedTopic = isSupportedLearningTopic(detail);
        this.supportedItem = isSupportedLearningItem(detail);
        this.learningUnavailable = false;
        this.learningCoordinator?.reproject();
        if (this.windowBarrierActive) {
            return;
        }
        if (decision.kind !== "writableTopic" && decision.kind !== "itemAuthoring") {
            this.setReplacementReady(true);
        }
    }

    private renderTopic(html: string): void {
        this.contentElement.replaceChildren();
        const viewport = document.createElement("div");
        viewport.className = "symemo-element-tab__viewport fn__flex-1";
        const content = document.createElement("div");
        content.className = "symemo-element-tab__content b3-typography";
        viewport.append(content);
        this.contentElement.append(viewport);
        this.readerElement = content;
        viewport.scrollTop = 0;
        renderReadOnlyTopic(content, html);
    }

    private renderUnavailable(detail: ElementDetailView, reason: RendererUnavailableReason): void {
        this.readerElement = undefined;
        this.contentElement.replaceChildren();
        const status = document.createElement("div");
        status.className = "symemo-element-tab__status fn__flex-column";
        const title = document.createElement("div");
        title.className = "symemo-element-tab__status-title";
        title.textContent = getElementDisplayTitle(detail.title, language("untitled"));
        const message = document.createElement("div");
        message.className = "b3-label__text";
        message.textContent = language(unavailableLanguageKey[reason]) || language("symemoRendererUnavailable");
        status.append(title, message);
        this.contentElement.append(status);
    }

    private renderStatus(message: string, retry = false): void {
        this.surfaceHost?.destroy();
        this.readerElement = undefined;
        this.contentElement.replaceChildren();
        const status = document.createElement("div");
        status.className = "symemo-element-tab__status fn__flex-column";
        const text = document.createElement("div");
        text.className = "b3-label__text";
        text.textContent = message;
        status.append(text);
        if (retry) {
            const button = document.createElement("button");
            button.className = "b3-button b3-button--text";
            button.textContent = language("retry");
            button.addEventListener("click", () => this.retry());
            status.append(button);
        }
        this.contentElement.append(status);
    }

    private handleLearningIntent(intent: LearningControlIntent): void {
        if (intent.kind === "learn") {
            void this.learningCoordinator?.learn();
        } else if (intent.kind === "resume") {
            void this.learningCoordinator?.resume();
        } else if (intent.kind === "stop") {
            void this.learningCoordinator?.stop();
        } else if (intent.kind === "next") {
            void this.learningCoordinator?.next();
        } else if (intent.kind === "showAnswer") {
            void this.learningCoordinator?.showAnswer();
        } else if (intent.kind === "grade") {
            void this.learningCoordinator?.grade(intent.rawGrade);
        } else if (intent.kind === "acceptPending") {
            void this.learningCoordinator?.acceptPending();
        } else if (intent.kind === "declinePending") {
            void this.learningCoordinator?.declinePending();
        } else if (intent.kind === "declineFinalDrill") {
            void this.learningCoordinator?.declineFinalDrill();
        } else if (intent.kind === "retryNext") {
            void this.learningCoordinator?.retryNext();
        } else if (intent.kind === "continue") {
            void this.learningCoordinator?.continueNext();
        }
    }
}
