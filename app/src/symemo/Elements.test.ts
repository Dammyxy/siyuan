import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import type {App} from "../index";
import type {ElementTreeNodeView, ElementTreeResult, OpenElementOptions} from "./types";
import {createElementsPanel, deferred, TestDocument, TestElement} from "./testDom";

class TestMenu {
    public readonly appended: TestMenuItem[] = [];
    public popupPosition?: {x: number; y: number};

    constructor() {
        menuInstances.push(this);
    }

    public append(element: TestMenuItem) {
        this.appended.push(element);
    }

    public popup(position: {x: number; y: number}) {
        this.popupPosition = position;
    }
}

class TestMenuItem {
    public readonly element = this;

    constructor(public readonly options: {label: string; icon: string; click: () => void}) {}
}

const menuInstances: TestMenu[] = [];
let openCalls: OpenElementOptions[] = [];
let storageCalls: Array<{key: string; value: unknown}> = [];
let dockToggleCalls: unknown[][] = [];

const stubPaths = [
    require.resolve("../layout/Model"),
    require.resolve("./api"),
    require.resolve("./openElement"),
    require.resolve("../menus/Menu"),
    require.resolve("../protyle/util/compatibility"),
    require.resolve("../constants"),
    require.resolve("../layout/tabUtil"),
];
const originalModules = stubPaths.map((modulePath) => require.cache[modulePath]);
let ElementsActivationController: typeof import("./Elements").ElementsActivationController;
let Elements: typeof import("./Elements").Elements;
let getElementTreeImpl: () => Promise<ElementTreeResult>;
let testDocument: TestDocument;

before(async () => {
    require.cache[stubPaths[0]] = {exports: {Model: class {
        public app: App;
        constructor(options: {app: App}) { this.app = options.app; }
    }}} as NodeModule;
    require.cache[stubPaths[1]] = {exports: {getElementTree: () => getElementTreeImpl()}} as NodeModule;
    require.cache[stubPaths[2]] = {exports: {openElement(options: OpenElementOptions) { openCalls.push(options); }}} as NodeModule;
    require.cache[stubPaths[3]] = {exports: {Menu: TestMenu, MenuItem: TestMenuItem}} as NodeModule;
    require.cache[stubPaths[4]] = {exports: {
        isOnlyMeta: () => false,
        setStorageVal(key: string, value: unknown) { storageCalls.push({key, value}); },
    }} as NodeModule;
    require.cache[stubPaths[5]] = {exports: {Constants: {LOCAL_SYMEMO_ELEMENTS_EXPANDED: "local-symemo-elements-expanded"}}} as NodeModule;
    require.cache[stubPaths[6]] = {exports: {getDockByType: (type: string) => type === "elements" ? {
        toggleModel: (...args: unknown[]) => dockToggleCalls.push(args),
    } : undefined}} as NodeModule;

    (globalThis as unknown as {window: Window}).window = {
        siyuan: {
            config: {fileTree: {
                docIconClickExpand: false,
                openFilesUseCurrentTab: false,
                parentDocClickExpand: false,
            }},
            languages: {
                loading: "Loading",
                min: "Minimize",
                refresh: "Refresh",
                fileTree7: "Open in Current Tab",
                insertBottom: "Open Below",
                insertRight: "Open to the Right",
                openInNewTab: "Open in New Tab",
                symemoCollapseAll: "Collapse all",
                symemoElements: "Elements",
                symemoOpenElement: "Open Element",
                symemoTreeEmpty: "No Elements",
                symemoTreeLoadFailed: "Load failed",
                untitled: "Untitled",
            },
            storage: {"local-symemo-elements-expanded": []},
        },
    } as unknown as Window;
    testDocument = new TestDocument();
    (globalThis as unknown as {document: Document}).document = testDocument as unknown as Document;
    ({Elements, ElementsActivationController} = await import("./Elements"));
});

beforeEach(() => {
    testDocument = new TestDocument();
    (globalThis as typeof globalThis & {document: Document}).document = testDocument as unknown as Document;
    window.siyuan.storage["local-symemo-elements-expanded"] = [];
    getElementTreeImpl = async () => ({ok: true, nodes: []});
    menuInstances.length = 0;
    openCalls = [];
    storageCalls = [];
    dockToggleCalls = [];
});

after(() => {
    stubPaths.forEach((modulePath, index) => {
        if (originalModules[index]) require.cache[modulePath] = originalModules[index];
        else delete require.cache[modulePath];
    });
});

describe("Elements lazy lifecycle", () => {
    it("does not query while dormant and queries exactly once on first activation", async () => {
        let queries = 0;
        const controller = new ElementsActivationController(async () => {
            queries++;
        });

        assert.equal(queries, 0);
        await Promise.all([controller.activate(), controller.activate()]);
        assert.equal(queries, 1);
    });

    it("reuses the live model across hide and show without another first-load query", async () => {
        let queries = 0;
        const controller = new ElementsActivationController(async () => {
            queries++;
        });

        await controller.activate();
        controller.hide();
        await controller.show();
        assert.equal(queries, 1);
        assert.equal(controller.isVisible, true);
    });
});

const createModel = () => {
    const panelElement = createElementsPanel(testDocument);
    const tab = {panelElement: panelElement as unknown as HTMLElement} as import("../layout/Tab").Tab;
    return {model: new Elements({app: {} as App, tab}), panelElement};
};

const treeNode: ElementTreeNodeView = {
    elementId: "topic-id",
    type: "topic",
    title: "Topic",
    sourceMode: "html",
    supportStatus: "supported",
    children: [],
};

const parentNode: ElementTreeNodeView = {
    elementId: "parent-id",
    type: "concept",
    title: "Parent",
    sourceMode: "unknown",
    supportStatus: "supported",
    children: [treeNode],
};

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Elements dock request lifecycle", () => {
    it("ignores a late tree response after its panel leaves the DOM", async () => {
        const request = deferred<ElementTreeResult>();
        getElementTreeImpl = () => request.promise;
        const {model, panelElement} = createModel();
        const body = panelElement.querySelector(".symemo-elements__body") as TestElement;
        const refreshIcon = panelElement.querySelector('[data-type="refresh"] svg') as TestElement;
        const loadingChildren = [...body.children];
        const loadingState = model.state;
        const iconMutationCount = refreshIcon.classList.mutationCount;

        panelElement.isConnected = false;
        request.resolve({ok: true, nodes: [treeNode]});
        await nextTurn();

        assert.equal(model.state, loadingState);
        assert.deepEqual(model.nodes, []);
        assert.deepEqual(body.children, loadingChildren);
        assert.equal(refreshIcon.classList.mutationCount, iconMutationCount);
        assert.equal(refreshIcon.classList.contains("fn__rotate"), true);
    });

    it("keeps refresh non-reentrant, rotates the native icon, and retains the old tree", async () => {
        const first = deferred<ElementTreeResult>();
        const second = deferred<ElementTreeResult>();
        let requests = 0;
        getElementTreeImpl = () => {
            requests++;
            return requests === 1 ? first.promise : second.promise;
        };
        const {model, panelElement} = createModel();
        const refresh = panelElement.querySelector('[data-type="refresh"]') as TestElement;
        const refreshIcon = refresh.querySelector("svg") as TestElement;
        first.resolve({ok: true, nodes: [treeNode]});
        await nextTurn();

        const body = panelElement.querySelector(".symemo-elements__body") as TestElement;
        assert.ok(body.querySelector('[data-node-id="topic-id"]'));
        refresh.dispatch("click");
        refresh.dispatch("click");

        assert.equal(requests, 2);
        assert.equal(model.state.phase, "refreshing");
        assert.equal(refreshIcon.classList.contains("fn__rotate"), true);
        assert.ok(body.querySelector('[data-node-id="topic-id"]'));
        assert.equal(body.querySelector(".symemo-elements__refreshing"), null);

        second.resolve({ok: true, nodes: [treeNode]});
        await nextTurn();

        assert.equal(model.state.phase, "ready");
        assert.equal(refreshIcon.classList.contains("fn__rotate"), false);
    });

    it("keeps initial failure visible when Collapse All is used", async () => {
        getElementTreeImpl = async () => ({ok: false, kind: "request"});
        const {model, panelElement} = createModel();
        await nextTurn();

        const collapse = panelElement.querySelector('[data-type="collapse"]') as TestElement;
        collapse.dispatch("click");

        const body = panelElement.querySelector(".symemo-elements__body") as TestElement;
        assert.equal(model.state.phase, "initialFailure");
        assert.equal(body.querySelector(".symemo-elements__status")?.textContent, "Load failed");
        assert.equal(body.textContent.includes("No Elements"), false);
    });

    it("preserves refresh failure through tree interactions and remains retryable", async () => {
        const retry = deferred<ElementTreeResult>();
        let requests = 0;
        getElementTreeImpl = async () => {
            requests++;
            if (requests === 1) return {ok: true, nodes: [parentNode]};
            if (requests === 2) return {ok: false, kind: "request"};
            return retry.promise;
        };
        const {model, panelElement} = createModel();
        await nextTurn();
        const refresh = panelElement.querySelector('[data-type="refresh"]') as TestElement;
        refresh.dispatch("click");
        await nextTurn();
        const body = panelElement.querySelector(".symemo-elements__body") as TestElement;
        const assertFailureVisible = () => {
            assert.equal(model.state.phase, "refreshFailure");
            assert.equal(body.querySelector(".symemo-elements__refresh-failure")?.textContent, "Load failed");
            assert.ok(body.querySelector('[data-node-id="parent-id"]'));
        };
        assertFailureVisible();

        const toggle = body.querySelector('[data-node-id="parent-id"] [data-action="toggle"]') as TestElement;
        body.dispatch("click", {target: toggle});
        assertFailureVisible();

        const title = body.querySelector('[data-node-id="parent-id"] [data-action="title"]') as TestElement;
        body.dispatch("click", {target: title, button: 0});
        assertFailureVisible();

        const collapse = panelElement.querySelector('[data-type="collapse"]') as TestElement;
        collapse.dispatch("click");
        assertFailureVisible();

        model.reveal("topic-id");
        assertFailureVisible();

        refresh.dispatch("click");
        assert.equal(requests, 3);
        retry.resolve({ok: true, nodes: [parentNode]});
        await nextTurn();
        assert.equal(model.state.phase, "ready");
    });
});

describe("Elements native Adapter behavior", () => {
    it("builds the exact localized native header and delegates minimize", () => {
        const pending = deferred<ElementTreeResult>();
        getElementTreeImpl = () => pending.promise;
        const {panelElement} = createModel();
        const header = panelElement.querySelector(".block__icons") as TestElement;
        const controls = header.children.slice(1);

        assert.equal(header.children.length, 4);
        assert.deepEqual(controls.map((control) => control.getAttribute("data-type")), ["refresh", "collapse", "min"]);
        assert.deepEqual(controls.map((control) => control.getAttribute("aria-label")), ["Refresh", "Collapse all", "Minimize"]);
        assert.equal(header.querySelector(".block__logo span")?.textContent, "Elements");

        controls[2].dispatch("click");
        assert.deepEqual(dockToggleCalls, [["elements", false, true]]);
    });

    it("persists an empty expansion list when Collapse All is used", async () => {
        window.siyuan.storage["local-symemo-elements-expanded"] = ["parent-id"];
        getElementTreeImpl = async () => ({ok: true, nodes: [parentNode]});
        const {model, panelElement} = createModel();
        await nextTurn();

        (panelElement.querySelector('[data-type="collapse"]') as TestElement).dispatch("click");

        assert.deepEqual(model.state.expandedElementIds, []);
        assert.deepEqual(window.siyuan.storage["local-symemo-elements-expanded"], []);
        assert.deepEqual(storageCalls.at(-1), {key: "local-symemo-elements-expanded", value: []});
    });

    it("opens an ordinary Element from a real rendered row", async () => {
        getElementTreeImpl = async () => ({ok: true, nodes: [treeNode]});
        const {panelElement} = createModel();
        await nextTurn();
        const body = panelElement.querySelector(".symemo-elements__body") as TestElement;
        const title = body.querySelector('[data-node-id="topic-id"] [data-action="title"]') as TestElement;

        body.dispatch("click", {target: title, button: 0});

        assert.equal(openCalls.length, 1);
        assert.deepEqual({
            elementId: openCalls[0].elementId,
            intent: openCalls[0].intent,
            source: openCalls[0].source,
            title: openCalls[0].title,
            type: openCalls[0].type,
        }, {elementId: "topic-id", intent: "ordinary", source: "tree", title: "Topic", type: "topic"});
    });

    it("offers exactly five read-only context-menu open intents", async () => {
        getElementTreeImpl = async () => ({ok: true, nodes: [treeNode]});
        const {panelElement} = createModel();
        await nextTurn();
        const body = panelElement.querySelector(".symemo-elements__body") as TestElement;
        const title = body.querySelector('[data-node-id="topic-id"] [data-action="title"]') as TestElement;

        body.dispatch("contextmenu", {
            target: title,
            clientX: 12,
            clientY: 34,
            preventDefault() {},
        });

        assert.equal(menuInstances.length, 1);
        const items = menuInstances[0].appended;
        assert.deepEqual(items.map((item) => item.options.label), [
            "Open Element", "Open in Current Tab", "Open in New Tab", "Open to the Right", "Open Below",
        ]);
        assert.equal(items.some((item) => "separator" in item.options), false);
        items.forEach((item) => item.options.click());
        assert.deepEqual(openCalls.map((call) => call.intent), ["ordinary", "current", "new", "right", "bottom"]);
        assert.deepEqual(menuInstances[0].popupPosition, {x: 12, y: 34});
    });
});
