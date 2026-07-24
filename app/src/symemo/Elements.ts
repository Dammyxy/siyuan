import type {App} from "../index";
import {Model} from "../layout/Model";
import type {Tab} from "../layout/Tab";
import {Menu, MenuItem} from "../menus/Menu";
import {isOnlyMeta, setStorageVal} from "../protyle/util/compatibility";
import {Constants} from "../constants";
import {getDockByType} from "../layout/tabUtil";
import {getElementTree} from "./api";
import {openElement} from "./openElement";
import {reduceOpenGesture} from "./openIntent";
import {getRevealPlan, normalizeExpandedElementIds, parseStoredExpandedElementIds, shouldPersistExpandedElementIds} from "./treeState";
import {elementTypeIcon, getElementDisplayTitle} from "./treeState";
import {beginDockRequest, completeDockFailure, completeDockSuccess, createInitialDockState} from "./dockState";
import type {ElementsDockState, ElementTreeNodeView} from "./types";

export class ElementsActivationController {
    public isVisible = false;
    private activation?: Promise<void>;
    private activated = false;

    constructor(private readonly firstLoad: () => Promise<void>) {}

    public activate(): Promise<void> {
        this.isVisible = true;
        if (this.activated) return this.activation || Promise.resolve();
        this.activated = true;
        this.activation = this.firstLoad();
        return this.activation;
    }

    public hide(): void { this.isVisible = false; }
    public show(): Promise<void> { return this.activate(); }
}

const language = (key: string): string => window.siyuan?.languages?.[key] || "";

export class Elements extends Model {
    public readonly element: HTMLElement;
    public nodes: ElementTreeNodeView[] = [];
    public selectedElementId?: string;
    public readonly activation: ElementsActivationController;
    public state: ElementsDockState = createInitialDockState([]);
    private readonly tab: Tab;
    private readonly treeElement: HTMLElement;
    private readonly refreshIconElement: SVGElement;
    private readonly expanded: Set<string>;
    private requestGeneration = 0;
    private requesting = false;

    constructor(options: {app: App; tab: Tab}) {
        super({app: options.app});
        this.tab = options.tab;
        this.expanded = new Set(parseStoredExpandedElementIds(window.siyuan.storage[Constants.LOCAL_SYMEMO_ELEMENTS_EXPANDED]));
        this.element = options.tab.panelElement;
        this.element.classList.add("symemo-elements", "fn__flex-column", "file-tree", "dockPanel");
        this.element.innerHTML = '<div class="block__icons"><div class="block__logo fn__flex-1"><svg><use xlink:href="#iconListTree"></use></svg><span></span></div><span data-type="refresh" class="block__icon ariaLabel" data-position="north"><svg><use xlink:href="#iconRefresh"></use></svg></span><span data-type="collapse" class="block__icon ariaLabel" data-position="north"><svg><use xlink:href="#iconContract"></use></svg></span><span data-type="min" class="block__icon ariaLabel" data-position="north"><svg><use xlink:href="#iconMin"></use></svg></span></div><div class="symemo-elements__body fn__flex-1"></div>';
        const logo = this.element.querySelector(".block__logo span") as HTMLElement;
        logo.textContent = language("symemoElements");
        this.treeElement = this.element.querySelector(".symemo-elements__body") as HTMLElement;
        this.refreshIconElement = this.element.querySelector('[data-type="refresh"] svg') as SVGElement;
        this.element.querySelector('[data-type="refresh"]')?.setAttribute("aria-label", language("refresh"));
        this.element.querySelector('[data-type="collapse"]')?.setAttribute("aria-label", language("symemoCollapseAll"));
        this.element.querySelector('[data-type="min"]')?.setAttribute("aria-label", language("min"));
        this.element.querySelector('[data-type="refresh"]')?.addEventListener("click", () => void this.loadTree());
        this.element.querySelector('[data-type="collapse"]')?.addEventListener("click", () => {
            this.expanded.clear();
            this.state = {...this.state, expandedElementIds: []};
            this.persistExpanded([]);
            this.renderCurrentState();
        });
        this.element.querySelector('[data-type="min"]')?.addEventListener("click", () => {
            getDockByType("elements")?.toggleModel("elements", false, true);
        });
        this.treeElement.addEventListener("click", (event) => this.handleTreeClick(event));
        this.treeElement.addEventListener("auxclick", (event: MouseEvent) => this.handleTreeClick(event));
        this.treeElement.addEventListener("contextmenu", (event: MouseEvent) => this.openContextMenu(event));
        this.activation = new ElementsActivationController(() => this.loadTree());
        void this.activation.activate();
    }

    public async loadTree(): Promise<void> {
        if (this.requesting) return;
        this.requesting = true;
        const generation = ++this.requestGeneration;
        this.refreshIconElement.classList.add("fn__rotate");
        this.state = beginDockRequest(this.state);
        this.renderCurrentState();
        const result = await getElementTree();
        this.requesting = false;
        if (generation !== this.requestGeneration || !this.element.isConnected) return;
        this.refreshIconElement.classList.remove("fn__rotate");
        if (result.ok === false) {
            this.state = completeDockFailure(this.state, result.kind);
            this.renderCurrentState();
            return;
        }
        this.nodes = result.nodes;
        const previousExpanded = [...this.expanded];
        const normalizedExpanded = normalizeExpandedElementIds(result.nodes, previousExpanded);
        this.expanded.clear();
        normalizedExpanded.forEach((id) => this.expanded.add(id));
        if (shouldPersistExpandedElementIds(previousExpanded, normalizedExpanded)) this.persistExpanded(normalizedExpanded);
        this.state = {...completeDockSuccess(this.state, result.nodes), expandedElementIds: normalizedExpanded};
        this.selectedElementId = this.state.selectedElementId;
        this.renderCurrentState();
    }

    public reveal(elementId: string): void {
        if (this.nodes.length === 0) return;
        const plan = getRevealPlan(this.nodes, elementId);
        if (!plan) return;
        plan.expandedElementIds.forEach((id) => this.expanded.add(id));
        this.persistExpanded([...this.expanded]);
        this.selectedElementId = plan.selectedElementId;
        this.state = {
            ...this.state,
            selectedElementId: plan.selectedElementId,
            expandedElementIds: [...this.expanded],
        };
        this.renderCurrentState();
        this.treeElement.querySelector('[data-node-id="' + elementId.replace(/"/g, '\\"') + '"]')?.scrollIntoView({block: "nearest"});
    }

    private renderMessage(message: string): void {
        this.treeElement.replaceChildren();
        const status = document.createElement("div");
        status.className = "symemo-elements__status b3-label__text";
        status.textContent = message;
        this.treeElement.append(status);
    }

    private renderCurrentState(): void {
        if (this.state.phase === "initialFailure") {
            this.renderMessage(language("symemoTreeLoadFailed"));
            return;
        }
        if (this.state.phase === "initialLoading" || this.state.phase === "uninitialized") {
            this.renderMessage(language("loading"));
            return;
        }
        this.renderTree();
        if (this.state.phase === "refreshFailure") {
            const status = document.createElement("div");
            status.className = "symemo-elements__refresh-failure b3-label__text";
            status.textContent = language("symemoTreeLoadFailed");
            this.treeElement.prepend(status);
        }
    }

    private renderTree(): void {
        this.treeElement.replaceChildren();
        if (this.nodes.length === 0) {
            this.renderMessage(language("symemoTreeEmpty"));
            return;
        }
        const list = document.createElement("ul");
        list.className = "b3-list";
        this.nodes.forEach((node) => list.append(this.renderNode(node)));
        this.treeElement.append(list);
    }

    private renderNode(node: ElementTreeNodeView): HTMLElement {
        const wrapper = document.createElement("li");
        const row = document.createElement("div");
        row.className = "b3-list-item" + (this.selectedElementId === node.elementId ? " b3-list-item--focus" : "");
        row.setAttribute("data-node-id", node.elementId);
        row.setAttribute("data-type", node.type);
        const toggle = document.createElement("span");
        toggle.className = "b3-list-item__toggle" + (node.children.length === 0 ? " fn__hidden" : "");
        toggle.setAttribute("data-action", "toggle");
        toggle.innerHTML = '<svg class="b3-list-item__arrow' + (this.expanded.has(node.elementId) ? " b3-list-item__arrow--open" : "") + '"><use xlink:href="#iconRight"></use></svg>';
        const icon = document.createElement("span");
        icon.className = "b3-list-item__icon";
        icon.setAttribute("data-action", "typeIcon");
        icon.innerHTML = '<svg><use xlink:href="#' + elementTypeIcon(node.type) + '"></use></svg>';
        const title = document.createElement("span");
        title.className = "b3-list-item__text";
        title.setAttribute("data-action", "title");
        title.textContent = getElementDisplayTitle(node.title, language("untitled"));
        title.title = title.textContent;
        row.append(toggle, icon, title);
        wrapper.append(row);
        if (node.children.length > 0 && this.expanded.has(node.elementId)) {
            const children = document.createElement("ul");
            children.className = "b3-list";
            node.children.forEach((child) => children.append(this.renderNode(child)));
            wrapper.append(children);
        }
        return wrapper;
    }

    private handleTreeClick(event: MouseEvent | Event): void {
        const target = event.target as HTMLElement;
        const row = target.closest(".b3-list-item") as HTMLElement | null;
        if (!row) return;
        const elementId = row.getAttribute("data-node-id");
        const node = this.findNode(this.nodes, elementId || "");
        if (!node) return;
        const actionTarget = target.closest("[data-action]") as HTMLElement | null;
        const action = reduceOpenGesture({
            button: "button" in event ? event.button as 0 | 1 : 0,
            altKey: "altKey" in event && event.altKey,
            shiftKey: "shiftKey" in event && event.shiftKey,
            primaryModifier: "ctrlKey" in event ? isOnlyMeta(event as MouseEvent) : false,
            target: actionTarget?.getAttribute("data-action") === "toggle" ? "disclosure" :
                actionTarget?.getAttribute("data-action") === "typeIcon" ? "typeIcon" : "title",
            hasChildren: node.children.length > 0,
            parentDocClickExpand: window.siyuan.config.fileTree.parentDocClickExpand,
            docIconClickExpand: window.siyuan.config.fileTree.docIconClickExpand,
            openFilesUseCurrentTab: window.siyuan.config.fileTree.openFilesUseCurrentTab,
        });
        if (action.kind === "toggleExpansion" && node.children.length > 0) {
            if (this.expanded.has(node.elementId)) this.expanded.delete(node.elementId);
            else this.expanded.add(node.elementId);
            this.state = {...this.state, expandedElementIds: [...this.expanded]};
            this.persistExpanded([...this.expanded]);
            this.renderCurrentState();
            return;
        }
        this.selectedElementId = node.elementId;
        this.state = {...this.state, selectedElementId: node.elementId};
        this.renderCurrentState();
        if (action.kind === "open") {
            openElement({app: this.app, elementId: node.elementId, title: node.title, type: node.type, intent: action.intent, source: "tree"});
        }
    }

    private openContextMenu(event: MouseEvent): void {
        const row = (event.target as HTMLElement).closest(".b3-list-item") as HTMLElement | null;
        const node = row ? this.findNode(this.nodes, row.getAttribute("data-node-id") || "") : undefined;
        if (!node) return;
        event.preventDefault();
        const menu = new Menu();
        const commands = [
            {label: language("symemoOpenElement"), intent: "ordinary" as const, icon: elementTypeIcon(node.type)},
            {label: language("fileTree7"), intent: "current" as const, icon: "iconOpen"},
            {label: language("openInNewTab"), intent: "new" as const, icon: "iconOpen"},
            {label: language("insertRight"), intent: "right" as const, icon: "iconLayoutRight"},
            {label: language("insertBottom"), intent: "bottom" as const, icon: "iconLayoutBottom"},
        ];
        commands.forEach((command) => menu.append(new MenuItem({
            label: command.label,
            icon: command.icon,
            click: () => {
                openElement({app: this.app, elementId: node.elementId, title: node.title, type: node.type, intent: command.intent, source: "menu"});
            },
        }).element));
        menu.popup({x: event.clientX, y: event.clientY});
    }

    private findNode(nodes: ElementTreeNodeView[], id: string): ElementTreeNodeView | undefined {
        for (const node of nodes) {
            if (node.elementId === id) return node;
            const found = this.findNode(node.children, id);
            if (found) return found;
        }
        return undefined;
    }

    private persistExpanded(value: string[]): void {
        window.siyuan.storage[Constants.LOCAL_SYMEMO_ELEMENTS_EXPANDED] = value;
        setStorageVal(Constants.LOCAL_SYMEMO_ELEMENTS_EXPANDED, value);
    }
}
