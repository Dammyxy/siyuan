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
import {isWindowAuthoringBusy, prepareModelTransition} from "./authoringRegistry";

export interface ElementTabHandle {
    elementId: string;
    tab?: Tab;
}

export interface ElementOpenHost {
    untitled: string;
    findOrdinaryMatches(elementId: string): ElementTabHandle[];
    focusTab(tab: ElementTabHandle): void;
    createTab(
        identity: SymemoElementLayoutData,
        intent: OpenElementOptions["intent"],
    ): Promise<ElementTabHandle | undefined> | ElementTabHandle | undefined;
}

export const openElementWithHost = async (
    options: OpenElementOptions,
    host: ElementOpenHost,
): Promise<ElementTabHandle | undefined> => {
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

    return await host.createTab({
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

export type ElementOpenPreparation =
    | {allowed: true; replacementTabId: string | null}
    | {allowed: false};

const findReusableTab = (wnd: Wnd, intent: OpenElementOptions["intent"]): Tab | undefined => {
    if (intent !== "current" && (intent !== "ordinary" || !window.siyuan.config.fileTree.openFilesUseCurrentTab)) {
        return undefined;
    }
    let reusable: Tab | undefined;
    wnd.children.find((item) => {
        if (item.headElement?.classList.contains("item--unupdate") && !item.headElement.classList.contains("item--pin")) {
            reusable = item;
            return item.headElement.classList.contains("item--focus");
        }
        return false;
    });
    return reusable;
};

export const prepareNativeElementOpen = async (
    intent: OpenElementOptions["intent"],
): Promise<ElementOpenPreparation> => {
    if (isWindowAuthoringBusy()) {
        return {allowed: false};
    }
    const wnd = getActiveWnd();
    if (!wnd || pdfIsLoading(wnd.element)) {
        return {allowed: false};
    }
    return wnd.runTabMutation(async () => {
        if (isWindowAuthoringBusy() || getActiveWnd() !== wnd || pdfIsLoading(wnd.element)) {
            return {allowed: false};
        }
        const reusable = findReusableTab(wnd, intent);
        if (!reusable) {
            return {allowed: true, replacementTabId: null};
        }
        const result = await prepareModelTransition(reusable.model, "surface-replacement");
        if (!result.allowed || isWindowAuthoringBusy() || reusable.parent !== wnd || !wnd.children.includes(reusable) ||
            !reusable.headElement?.classList.contains("item--unupdate") ||
            reusable.headElement.classList.contains("item--pin")) {
            return {allowed: false};
        }
        return {allowed: true, replacementTabId: reusable.id};
    });
};

const findNativeOrdinaryMatches = (elementId: string): Array<ElementTabHandle & {tab: Tab}> => {
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
};

const focusNativeTab = (handle: ElementTabHandle): void => {
    if (!handle.tab?.headElement || pdfIsLoading(handle.tab.parent.element)) {
        return;
    }
    handle.tab.parent.switchTab(handle.tab.headElement);
    handle.tab.parent.showHeading();
};

type NativeTargetResolution = {
    queuedWnd: Wnd;
    splitDirection?: Config.TUILayoutDirection;
};

const resolveNativeTarget = (intent: OpenElementOptions["intent"]): NativeTargetResolution | undefined => {
    const activeWnd = getActiveWnd();
    if (!activeWnd) {
        return undefined;
    }
    const splitRequested = intent === "right" || intent === "bottom";
    const canSplit = Boolean(activeWnd.children[0]?.headElement);
    if (!splitRequested || !canSplit) {
        return {queuedWnd: activeWnd};
    }
    const direction: Config.TUILayoutDirection = intent === "right" ? "lr" : "tb";
    const parent = activeWnd.parent;
    if (parent instanceof Layout && parent.children.length > 1 && parent.direction === direction) {
        const index = parent.children.indexOf(activeWnd);
        let adjacent = parent.children[index + 1] || activeWnd;
        while (adjacent instanceof Layout) adjacent = adjacent.children[0] as Layout | Wnd;
        if (adjacent !== activeWnd) {
            return {queuedWnd: adjacent as Wnd};
        }
    }
    return {queuedWnd: activeWnd, splitDirection: direction};
};

const createNativeElementTab = (app: App, identity: SymemoElementLayoutData): Tab => new Tab({
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

export const createNativeHost = (app: App, preparation?: ElementOpenPreparation): ElementOpenHost => ({
    untitled: window.siyuan.languages.untitled,
    findOrdinaryMatches(elementId) {
        return findNativeOrdinaryMatches(elementId);
    },
    focusTab(handle) {
        focusNativeTab(handle);
    },
    async createTab(identity, intent) {
        if (isWindowAuthoringBusy()) {
            return undefined;
        }
        for (;;) {
            const target = resolveNativeTarget(intent);
            if (!target) {
                return undefined;
            }
            const result = await target.queuedWnd.runTabMutation(async (): Promise<
                {retry: true} | {retry: false; handle?: ElementTabHandle}
            > => {
                if (isWindowAuthoringBusy()) {
                    return {retry: false};
                }
                const currentTarget = resolveNativeTarget(intent);
                if (!currentTarget || currentTarget.queuedWnd !== target.queuedWnd ||
                    currentTarget.splitDirection !== target.splitDirection) {
                    return {retry: true};
                }
                if (intent === "ordinary") {
                    const existing = findNativeOrdinaryMatches(identity.elementId)[0];
                    if (existing) {
                        focusNativeTab(existing);
                        return {retry: false, handle: existing};
                    }
                }
                let wnd = target.queuedWnd;
                if (!target.splitDirection && pdfIsLoading(wnd.element)) {
                    return {retry: false};
                }
                if (target.splitDirection) {
                    wnd = wnd.split(target.splitDirection);
                }
                const preparedReusable = preparation?.allowed && preparation.replacementTabId
                    ? wnd.children.find((item) => item.id === preparation.replacementTabId &&
                        item.headElement?.classList.contains("item--unupdate") &&
                        !item.headElement.classList.contains("item--pin"))
                    : undefined;
                const reusable = preparedReusable || findReusableTab(wnd, intent);
                let tab: Tab | undefined;
                if (reusable) {
                    const replaced = await wnd.replaceTab(reusable, {
                        operationKey: `open-element:${identity.elementId}:${intent}`,
                        commit: () => {
                            tab = createNativeElementTab(app, identity);
                            wnd.addTab(tab, false, false, undefined, true);
                            return wnd.children.includes(tab);
                        },
                    });
                    if (!replaced || !tab) {
                        return {retry: false};
                    }
                } else {
                    tab = createNativeElementTab(app, identity);
                    wnd.addTab(tab, false, true, undefined, true);
                    if (!wnd.children.includes(tab)) {
                        return {retry: false};
                    }
                }
                await wnd.trimOverflowTabs(true);
                wnd.showHeading();
                return {retry: false, handle: {elementId: identity.elementId, tab}};
            });
            if (result.retry === true) {
                continue;
            }
            return "handle" in result ? result.handle : undefined;
        }
    },
});

export const openElement = async (
    options: OpenElementOptions,
    preparation?: ElementOpenPreparation,
): Promise<ElementTabHandle | undefined> => {
    if (isWindowAuthoringBusy()) {
        return undefined;
    }
    const opened = await openElementWithHost(options, createNativeHost(options.app, preparation));
    if (opened && window.siyuan.config.fileTree.alwaysSelectOpenedFile) {
        getAllModels().elements.forEach((model) => model.reveal(options.elementId));
    }
    return opened;
};
