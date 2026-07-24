import type {App} from "../index";
import {openLink} from "../editor/openLink";
import {Model} from "../layout/Model";
import type {Tab} from "../layout/Tab";
import {mathRender} from "../protyle/render/mathRender";
import {getElement} from "./api";
import {getRenderDecision} from "./renderEligibility";
import {elementTypeIcon, getElementDisplayTitle} from "./treeState";
import type {ElementDetailResult, ElementDetailView, ElementTabState, RendererUnavailableReason} from "./types";

export const deriveElementTabState = (result: ElementDetailResult): ElementTabState => {
    if (result.ok === false) {
        return result.kind === "missing" ? {phase: "missing"} : {phase: "failure", errorKind: result.kind};
    }
    const decision = getRenderDecision(result.element);
    return decision.kind === "renderedTopic"
        ? {phase: "renderedTopic", detail: result.element, html: decision.html}
        : {phase: "rendererUnavailable", detail: result.element, reason: decision.reason};
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
    private requestGeneration = 0;
    private requesting = false;

    constructor(options: {app: App; tab: Tab; elementId: string}) {
        super({app: options.app});
        this.tab = options.tab;
        this.panelElement = options.tab.panelElement;
        this.elementId = options.elementId;
        if (window.siyuan.config.fileTree.openFilesUseCurrentTab) {
            this.tab.headElement?.classList.add("item--unupdate");
        }
        this.panelElement.classList.add("symemo-element-tab", "fn__flex", "fn__flex-column");
        this.panelElement.addEventListener("click", (event: MouseEvent) => {
            if (this.readerElement) {
                handleReaderLinkClick(this.app, this.readerElement, event);
            }
        });
        void this.load();
    }

    public async load(): Promise<void> {
        if (this.requesting) {
            return;
        }
        this.requesting = true;
        const generation = ++this.requestGeneration;
        this.state = {phase: "loading"};
        this.renderStatus(language("loading"));
        const result = await getElement(this.elementId);
        this.requesting = false;
        if (generation !== this.requestGeneration || !this.panelElement.isConnected) {
            return;
        }
        this.state = deriveElementTabState(result);
        if (this.state.phase === "missing") {
            this.renderStatus(language("symemoElementMissing"), true);
        } else if (this.state.phase === "failure") {
            this.renderStatus(language("symemoElementLoadFailed"), true);
        } else if (this.state.phase === "renderedTopic") {
            this.updateSafeIdentity(this.state.detail);
            this.renderTopic(this.state.html);
        } else if (this.state.phase === "rendererUnavailable") {
            this.updateSafeIdentity(this.state.detail);
            this.renderUnavailable(this.state.detail, this.state.reason);
        }
    }

    public retry(): void {
        void this.load();
    }

    private updateSafeIdentity(detail: ElementDetailView): void {
        const title = getElementDisplayTitle(detail.title, language("untitled"));
        this.tab.updateTitle(title);
        const icon = elementTypeIcon(detail.type);
        this.tab.icon = icon;
        this.tab.headElement?.querySelector(".item__graphic use")?.setAttribute("xlink:href", "#" + icon);
    }

    private renderTopic(html: string): void {
        this.panelElement.replaceChildren();
        const viewport = document.createElement("div");
        viewport.className = "symemo-element-tab__viewport fn__flex-1";
        const content = document.createElement("div");
        content.className = "symemo-element-tab__content b3-typography";
        viewport.append(content);
        this.panelElement.append(viewport);
        this.readerElement = content;
        viewport.scrollTop = 0;
        renderReadOnlyTopic(content, html);
    }

    private renderUnavailable(detail: ElementDetailView, reason: RendererUnavailableReason): void {
        this.readerElement = undefined;
        this.panelElement.replaceChildren();
        const status = document.createElement("div");
        status.className = "symemo-element-tab__status fn__flex-column";
        const title = document.createElement("div");
        title.className = "symemo-element-tab__status-title";
        title.textContent = getElementDisplayTitle(detail.title, language("untitled"));
        const message = document.createElement("div");
        message.className = "b3-label__text";
        message.textContent = language(unavailableLanguageKey[reason]) || language("symemoRendererUnavailable");
        status.append(title, message);
        this.panelElement.append(status);
    }

    private renderStatus(message: string, retry = false): void {
        this.readerElement = undefined;
        this.panelElement.replaceChildren();
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
        this.panelElement.append(status);
    }
}
