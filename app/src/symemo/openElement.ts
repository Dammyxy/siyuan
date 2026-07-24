import type {App} from "../index";
import {Layout} from "../layout";
import {getAllModels, getAllTabs} from "../layout/getAll";
import {Tab} from "../layout/Tab";
import {getInstanceById, getWndByLayout, pdfIsLoading} from "../layout/util";
import type {Wnd} from "../layout/Wnd";
import {ElementTab} from "./ElementTab";
import {getSymemoElementId} from "./layoutState";
import {elementTypeIcon, getElementDisplayTitle} from "./treeState";
import type {OpenElementOptions, SymemoElementLayoutData} from "./types";

export interface ElementTabHandle {
    elementId: string;
    tab?: Tab;
}

export interface ElementOpenHost {
    untitled: string;
    findOrdinaryMatches(elementId: string): ElementTabHandle[];
    focusTab(tab: ElementTabHandle): void;
    createTab(identity: SymemoElementLayoutData, intent: OpenElementOptions["intent"]): ElementTabHandle | undefined;
}

export const openElementWithHost = (
    options: OpenElementOptions,
    host: ElementOpenHost,
): ElementTabHandle | undefined => {
    if (typeof options.elementId !== "string" || options.elementId.trim().length === 0) {
        return undefined;
    }

    if (options.intent === "ordinary") {
        const existing = host.findOrdinaryMatches(options.elementId)[0];
        if (existing) {
            host.focusTab(existing);
            return existing;
        }
    }

    return host.createTab({
        instance: "SymemoElement",
        elementId: options.elementId,
        title: getElementDisplayTitle(options.title || "", host.untitled),
        icon: elementTypeIcon(options.type || ""),
    }, options.intent);
};

const getActiveWnd = (): Wnd | undefined => {
    const activeElement = document.querySelector(".layout__wnd--active") as HTMLElement | null;
    if (activeElement) {
        const wnd = activeElement.getAttribute("data-id") ? getInstanceById(activeElement.getAttribute("data-id")) as Wnd : undefined;
        if (wnd) {
            return wnd;
        }
    }
    return window.siyuan.layout.centerLayout ? getWndByLayout(window.siyuan.layout.centerLayout) : undefined;
};

const parseLazyElementId = (tab: Tab): string | undefined => {
    return getSymemoElementId(undefined, tab.headElement?.getAttribute("data-initdata") || undefined);
};

export const createNativeHost = (app: App): ElementOpenHost => ({
    untitled: window.siyuan.languages.untitled,
    findOrdinaryMatches(elementId) {
        const activeWnd = getActiveWnd();
        return getAllTabs()
            .map((tab): ElementTabHandle | undefined => {
                if (tab.model instanceof ElementTab && tab.model.elementId === elementId) {
                    return {elementId, tab};
                }
                return parseLazyElementId(tab) === elementId ? {elementId, tab} : undefined;
            })
            .filter((item): item is ElementTabHandle & {tab: Tab} => Boolean(item?.tab))
            .sort((left, right) => {
                const leftActive = left.tab.parent === activeWnd ? 1 : 0;
                const rightActive = right.tab.parent === activeWnd ? 1 : 0;
                if (leftActive !== rightActive) {
                    return rightActive - leftActive;
                }
                return Number(right.tab.headElement?.getAttribute("data-activetime") || 0) -
                    Number(left.tab.headElement?.getAttribute("data-activetime") || 0);
            });
    },
    focusTab(handle) {
        if (!handle.tab?.headElement || pdfIsLoading(handle.tab.parent.element)) {
            return;
        }
        handle.tab.parent.switchTab(handle.tab.headElement);
        handle.tab.parent.showHeading();
    },
    createTab(identity, intent) {
        let wnd = getActiveWnd();
        if (!wnd) {
            return undefined;
        }
        const splitRequested = intent === "right" || intent === "bottom";
        const canSplit = Boolean(wnd.children[0]?.headElement);
        if (splitRequested && canSplit) {
            const direction = intent === "right" ? "lr" : "tb";
            const parent = wnd.parent;
            let targetWnd: Wnd | undefined;
            if (parent instanceof Layout && parent.children.length > 1 && parent.direction === direction) {
                const index = parent.children.indexOf(wnd);
                let adjacent = parent.children[index + 1] || wnd;
                while (adjacent instanceof Layout) adjacent = adjacent.children[0] as Layout | Wnd;
                targetWnd = adjacent as Wnd;
            }
            if (targetWnd) {
                if (pdfIsLoading(targetWnd.element)) {
                    return undefined;
                }
                const live = targetWnd.children.find((item) => item.model instanceof ElementTab && item.model.elementId === identity.elementId);
                if (live) {
                    targetWnd.switchTab(live.headElement);
                    targetWnd.showHeading();
                    return {elementId: identity.elementId, tab: live};
                }
                const lazy = getAllTabs().find((item) => parseLazyElementId(item) === identity.elementId);
                if (lazy) {
                    lazy.parent.switchTab(lazy.headElement);
                    lazy.parent.showHeading();
                    return {elementId: identity.elementId, tab: lazy};
                }
            }
            wnd = targetWnd || wnd.split(direction);
        } else if (pdfIsLoading(wnd.element)) {
            return undefined;
        }
        let reusable: Tab | undefined;
        if (intent === "current" || (intent === "ordinary" && window.siyuan.config.fileTree.openFilesUseCurrentTab)) {
            wnd.children.find((item) => {
                if (item.headElement?.classList.contains("item--unupdate") && !item.headElement.classList.contains("item--pin")) {
                    reusable = item;
                    return item.headElement.classList.contains("item--focus");
                }
                return false;
            });
        }
        const tab = new Tab({
            title: identity.title,
            icon: identity.icon,
            callback: (createdTab) => {
                createdTab.addModel(new ElementTab({
                    app,
                    tab: createdTab,
                    elementId: identity.elementId,
                }));
            },
        });
        wnd.addTab(tab);
        if (reusable && reusable !== tab) wnd.removeTab(reusable.id, false, false);
        wnd.showHeading();
        return {elementId: identity.elementId, tab};
    },
});

export const openElement = (options: OpenElementOptions): ElementTabHandle | undefined => {
    const opened = openElementWithHost(options, createNativeHost(options.app));
    if (opened && window.siyuan.config.fileTree.alwaysSelectOpenedFile) {
        getAllModels().elements.forEach((model) => model.reveal(options.elementId));
    }
    return opened;
};
