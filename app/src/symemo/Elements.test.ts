import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import type {App} from "../index";
import type {CreateHTMLTopicResult, ElementTreeNodeView, ElementTreeResult, OpenElementOptions} from "./types";
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
    require.resolve("./authoringRegistry"),
];
const originalModules = stubPaths.map((modulePath) => require.cache[modulePath]);
let ElementsActivationController: typeof import("./Elements").ElementsActivationController;
let Elements: typeof import("./Elements").Elements;
let getElementTreeImpl: () => Promise<ElementTreeResult>;
let createHTMLTopicImpl: (title: string, html: string) => Promise<CreateHTMLTopicResult>;
let testDocument: TestDocument;
let authoringBusy = false;
let cancelAuthoringOperation = false;
let elementOpenPrepared = true;

before(async () => {
    require.cache[stubPaths[0]] = {exports: {Model: class {
        public app: App;
        constructor(options: {app: App}) { this.app = options.app; }
    }}} as NodeModule;
    require.cache[stubPaths[1]] = {exports: {
        createHTMLTopic: (title: string, html: string) => createHTMLTopicImpl(title, html),
        getElementTree: () => getElementTreeImpl(),
    }} as NodeModule;
    require.cache[stubPaths[2]] = {exports: {
        openElement(options: OpenElementOptions) { openCalls.push(options); },
        prepareNativeElementOpen: async () => elementOpenPrepared
            ? {allowed: true, replacementTabId: null as string | null}
            : {allowed: false},
    }} as NodeModule;
    require.cache[stubPaths[3]] = {exports: {Menu: TestMenu, MenuItem: TestMenuItem}} as NodeModule;
    require.cache[stubPaths[4]] = {exports: {
        isOnlyMeta: () => false,
        setStorageVal(key: string, value: unknown) { storageCalls.push({key, value}); },
    }} as NodeModule;
    require.cache[stubPaths[5]] = {exports: {Constants: {LOCAL_SYMEMO_ELEMENTS_EXPANDED: "local-symemo-elements-expanded"}}} as NodeModule;
    require.cache[stubPaths[6]] = {exports: {getDockByType: (type: string) => type === "elements" ? {
        toggleModel: (...args: unknown[]) => dockToggleCalls.push(args),
    } : undefined}} as NodeModule;
    require.cache[stubPaths[7]] = {exports: {
        isWindowAuthoringBusy: () => authoringBusy,
        runWindowAuthoringOperation: async (_name: string, callback: (operation: {isCancelled: boolean}) => Promise<void>) => {
            if (authoringBusy) return {started: false};
            await callback({get isCancelled() { return cancelAuthoringOperation; }});
            return {started: true};
        },
    }} as NodeModule;

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
                new: "New",
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
    window.siyuan.config.readonly = false;
    window.siyuan.storage["local-symemo-elements-expanded"] = [];
    getElementTreeImpl = async () => ({ok: true, nodes: []});
    createHTMLTopicImpl = async () => ({
        ok: true,
        elementId: "created-topic",
        eventId: "event-id",
        createAccepted: true,
        reviewAccepted: true,
        retryable: false,
    });
    menuInstances.length = 0;
    openCalls = [];
    storageCalls = [];
    dockToggleCalls = [];
    authoringBusy = false;
    cancelAuthoringOperation = false;
    elementOpenPrepared = true;
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

        assert.equal(header.children.length, 5);
        assert.deepEqual(controls.map((control) => control.getAttribute("data-type")), ["add", "refresh", "collapse", "min"]);
        assert.deepEqual(controls.map((control) => control.getAttribute("aria-label")), ["New", "Refresh", "Collapse all", "Minimize"]);
        assert.equal(header.querySelector(".block__logo span")?.textContent, "Elements");

        controls[3].dispatch("click");
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

    it("creates one empty Topic from the dock add button, refreshes the tree, and opens the accepted ID", async () => {
        let treeCalls = 0;
        let createCalls = 0;
        getElementTreeImpl = async () => {
            treeCalls++;
            return {
                ok: true,
                nodes: treeCalls === 1 ? [] : [{...treeNode, elementId: "created-topic", title: ""}],
            };
        };
        createHTMLTopicImpl = async (title, html) => {
            createCalls++;
            assert.equal(title, "");
            assert.equal(html, "");
            return {
                ok: true,
                elementId: "created-topic",
                eventId: "event-id",
                createAccepted: true,
                reviewAccepted: true,
                retryable: false,
            };
        };
        const {model, panelElement} = createModel();
        await nextTurn();
        const add = panelElement.querySelector('[data-type="add"]') as TestElement;

        add.dispatch("click");
        add.dispatch("click");
        await nextTurn();
        await nextTurn();

        assert.equal(createCalls, 1);
        assert.equal(treeCalls, 2);
        assert.deepEqual(openCalls.map((call) => ({
            elementId: call.elementId,
            intent: call.intent,
            source: call.source,
            title: call.title,
            type: call.type,
        })), [{elementId: "created-topic", intent: "ordinary", source: "other", title: "", type: "topic"}]);
        assert.equal(model.selectedElementId, "created-topic");
    });

    it("hides and disables Topic creation before any request in read-only mode", async () => {
        let createCalls = 0;
        window.siyuan.config.readonly = true;
        createHTMLTopicImpl = async () => {
            createCalls++;
            throw new Error("must not create");
        };
        const {model, panelElement} = createModel();
        await nextTurn();
        const add = panelElement.querySelector('[data-type="add"]') as TestElement;

        add.dispatch("click");
        await model.createEmptyTopic();
        await nextTurn();

        assert.equal(add.classList.contains("fn__none"), true);
        assert.equal(add.getAttribute("aria-disabled"), "true");
        assert.equal(createCalls, 0);
        assert.equal(openCalls.length, 0);
    });

    it("does not create a Topic while the renderer authoring barrier is active", async () => {
        let createCalls = 0;
        authoringBusy = true;
        createHTMLTopicImpl = async () => {
            createCalls++;
            throw new Error("must not create");
        };
        const {panelElement} = createModel();
        await nextTurn();

        (panelElement.querySelector('[data-type="add"]') as TestElement).dispatch("click");
        await nextTurn();

        assert.equal(createCalls, 0);
        assert.equal(openCalls.length, 0);
    });

    it("does not create a Topic when the reusable target cannot flush", async () => {
        let createCalls = 0;
        elementOpenPrepared = false;
        createHTMLTopicImpl = async () => {
            createCalls++;
            throw new Error("must not create");
        };
        const {panelElement} = createModel();
        await nextTurn();

        (panelElement.querySelector('[data-type="add"]') as TestElement).dispatch("click");
        await nextTurn();

        assert.equal(createCalls, 0);
        assert.equal(openCalls.length, 0);
    });

    it("does not open a Topic whose creation completes after its operation is cancelled", async () => {
        const pending = deferred<CreateHTMLTopicResult>();
        createHTMLTopicImpl = () => pending.promise;
        const {panelElement} = createModel();
        await nextTurn();

        (panelElement.querySelector('[data-type="add"]') as TestElement).dispatch("click");
        await nextTurn();
        cancelAuthoringOperation = true;
        pending.resolve({
            ok: true,
            elementId: "created-late",
            eventId: "event-late",
            createAccepted: true,
            reviewAccepted: true,
            retryable: false,
        });
        await nextTurn();
        await nextTurn();

        assert.equal(openCalls.length, 0);
    });

    it("opens an accepted Element ID even when presentation recovery reports a create failure", async () => {
        createHTMLTopicImpl = async () => ({
            ok: false,
            failure: {
                errorCode: "projection-refresh-failed",
                retryable: false,
                acceptanceUnknown: false,
                acceptedElementId: "accepted-topic",
            },
        });
        getElementTreeImpl = async () => ({ok: true, nodes: [{...treeNode, elementId: "accepted-topic"}]});
        const {panelElement} = createModel();
        await nextTurn();

        (panelElement.querySelector('[data-type="add"]') as TestElement).dispatch("click");
        await nextTurn();
        await nextTurn();

        assert.equal(openCalls[0].elementId, "accepted-topic");
        assert.equal(openCalls[0].title, "");
    });

    it("passes 100 isolated create/open activations without duplicate frontend drafts", async () => {
        let createCalls = 0;
        for (let index = 0; index < 100; index++) {
            const createdId = `created-${index}`;
            getElementTreeImpl = async () => ({ok: true, nodes: [{...treeNode, elementId: createdId, title: ""}]});
            createHTMLTopicImpl = async () => {
                createCalls++;
                return {
                    ok: true,
                    elementId: createdId,
                    eventId: `event-${index}`,
                    createAccepted: true,
                    reviewAccepted: true,
                    retryable: false,
                };
            };
            const {panelElement} = createModel();
            await nextTurn();
            (panelElement.querySelector('[data-type="add"]') as TestElement).dispatch("click");
            await nextTurn();
            await nextTurn();
        }

        assert.equal(createCalls, 100);
        assert.equal(openCalls.length, 100);
        assert.equal(new Set(openCalls.map((call) => call.elementId)).size, 100);
    });
});
