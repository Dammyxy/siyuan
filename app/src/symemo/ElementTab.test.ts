import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import type {App} from "../index";
import type {ElementDetailResult, OpenElementOptions} from "./types";
import {deferred, TestDocument, TestElement} from "./testDom";

const stubPaths = [
    require.resolve("../layout/Model"),
    require.resolve("../protyle/render/mathRender"),
    require.resolve("../editor/openLink"),
    require.resolve("./api"),
    require.resolve("./TopicHtmlSurface"),
    require.resolve("./openElement"),
    require.resolve("./authoringRegistry"),
];
const originalModules = stubPaths.map((modulePath) => require.cache[modulePath]);
let classifyReaderHref: typeof import("./ElementTab").classifyReaderHref;
let handleReaderLinkClick: typeof import("./ElementTab").handleReaderLinkClick;
let renderReadOnlyTopic: typeof import("./ElementTab").renderReadOnlyTopic;
let deriveElementTabState: typeof import("./ElementTab").deriveElementTabState;
let ElementTab: typeof import("./ElementTab").ElementTab;
let getElementImpl: (elementId: string) => Promise<ElementDetailResult>;
let testDocument: TestDocument;
let lastSurface: FakeTopicHtmlSurface | undefined;
let openElementCalls: OpenElementOptions[];
let lastParticipant: {setWindowBarrier(active: boolean): void} | undefined;
let surfaceMountError: Error | undefined;

const captureSurface = (surface: FakeTopicHtmlSurface) => {
    lastSurface = surface;
};

class FakeTopicHtmlSurface {
    public mounted = false;
    public readonly onTransitionReadyChange?: (ready: boolean) => void;
    public readonly onSaveAsNew?: (elementId: string) => void;

    constructor(options: {
        onTransitionReadyChange?: (ready: boolean) => void;
        onSaveAsNew?: (elementId: string) => void;
    }) {
        this.onTransitionReadyChange = options.onTransitionReadyChange;
        this.onSaveAsNew = options.onSaveAsNew;
        captureSurface(this);
    }

    public async mount() {
        if (surfaceMountError) throw surfaceMountError;
        this.mounted = true;
        this.onTransitionReadyChange?.(true);
    }

    public prepareTransition() {
        return Promise.resolve({allowed: true});
    }

    public focus() {}
    public destroy() {}
}

before(async () => {
    require.cache[stubPaths[0]] = {exports: {Model: class {
        public app: App;
        constructor(options: {app: App}) {
            this.app = options.app;
        }
    }}} as NodeModule;
    require.cache[stubPaths[1]] = {exports: {mathRender() {}}} as NodeModule;
    require.cache[stubPaths[2]] = {exports: {openLink() {}}} as NodeModule;
    require.cache[stubPaths[3]] = {exports: {getElement: (elementId: string) => getElementImpl(elementId)}} as NodeModule;
    require.cache[stubPaths[4]] = {exports: {TopicHtmlSurface: FakeTopicHtmlSurface}} as NodeModule;
    require.cache[stubPaths[5]] = {exports: {
        openElement: (options: OpenElementOptions) => openElementCalls.push(options),
    }} as NodeModule;
    require.cache[stubPaths[6]] = {exports: {
        registerWindowAuthoringParticipant: (participant: {setWindowBarrier(active: boolean): void}) => {
            lastParticipant = participant;
            return (): void => undefined;
        },
    }} as NodeModule;
    (globalThis as unknown as {window: Window}).window = {
        siyuan: {
            config: {fileTree: {openFilesUseCurrentTab: false}},
            languages: {
                loading: "Loading",
                retry: "Retry",
                symemoElementLoadFailed: "Load failed",
                symemoElementMissing: "Missing",
                untitled: "Untitled",
            },
        },
    } as unknown as Window;
    testDocument = new TestDocument();
    (globalThis as unknown as {document: Document}).document = testDocument as unknown as Document;
    ({ElementTab, classifyReaderHref, handleReaderLinkClick, renderReadOnlyTopic, deriveElementTabState} = await import("./ElementTab"));
});

beforeEach(() => {
    testDocument = new TestDocument();
    (globalThis as typeof globalThis & {document: Document}).document = testDocument as unknown as Document;
    getElementImpl = async () => ({ok: false, kind: "response"});
    lastSurface = undefined;
    lastParticipant = undefined;
    openElementCalls = [];
    surfaceMountError = undefined;
});

after(() => {
    stubPaths.forEach((modulePath, index) => {
        if (originalModules[index]) {
            require.cache[modulePath] = originalModules[index];
        } else {
            delete require.cache[modulePath];
        }
    });
});

describe("read-only Topic composition", () => {
    it("assigns guarded HTML once, remains non-editable, and invokes math rendering", () => {
        const attributes = new Map<string, string>();
        let htmlAssignments = 0;
        let html = "";
        const content = {
            get innerHTML() {
                return html;
            },
            set innerHTML(value: string) {
                htmlAssignments++;
                html = value;
            },
            removeAttribute(name: string) {
                attributes.delete(name);
            },
            setAttribute(name: string, value: string) {
                attributes.set(name, value);
            },
        } as unknown as HTMLElement;
        let renderedElement: HTMLElement | undefined;

        renderReadOnlyTopic(content, "<p>Math</p>", (element) => {
            renderedElement = element;
            element.setAttribute("data-symemo-katex-trust", "false");
        });

        assert.equal(htmlAssignments, 1);
        assert.equal(content.innerHTML, "<p>Math</p>");
        assert.equal(attributes.get("contenteditable"), "false");
        assert.equal(attributes.get("data-symemo-katex-trust"), "false");
        assert.equal(renderedElement, content);
    });

    it("prepares bare cleaned block formulas for the native renderer frame", () => {
        let frame: unknown;
        const mathElement = {
            firstElementChild: null,
            ownerDocument: {createElement: () => ({})},
            append(value: unknown) {
                frame = value;
                this.firstElementChild = value;
            },
        } as unknown as HTMLElement;
        const content = {
            innerHTML: "",
            querySelectorAll: () => [mathElement],
            setAttribute() {},
        } as unknown as HTMLElement;

        renderReadOnlyTopic(content, "<div data-type=\"NodeMathBlock\" data-subtype=\"math\"></div>", () => {});

        assert.ok(frame);
        assert.equal(mathElement.firstElementChild, frame);
    });
});

describe("Topic reader links", () => {
    it("classifies only same-reader hash links as fragments", () => {
        assert.equal(classifyReaderHref("#heading"), "fragment");
        assert.equal(classifyReaderHref("https://example.com/#heading"), "link");
        assert.equal(classifyReaderHref("siyuan://blocks/id"), "link");
        assert.equal(classifyReaderHref(""), "none");
    });

    it("scrolls a fragment target inside the reader without delegating", () => {
        let scrolled = 0;
        let delegated = 0;
        const anchor = {getAttribute: () => "#heading"};
        const content = {
            contains: () => true,
            querySelector: () => ({scrollIntoView: () => scrolled++}),
        } as unknown as HTMLElement;
        const event = {
            target: {closest: () => anchor},
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            metaKey: false,
        } as unknown as MouseEvent;

        handleReaderLinkClick({} as App, content, event, () => delegated++);
        assert.equal(scrolled, 1);
        assert.equal(delegated, 0);
    });

    it("delegates a retained non-fragment link exactly once with Ctrl or Meta", () => {
        const anchor = {getAttribute: () => "https://example.com/"};
        const content = {contains: () => true} as unknown as HTMLElement;
        const event = {
            target: {closest: () => anchor},
            preventDefault() {},
            stopPropagation() {},
            ctrlKey: false,
            metaKey: true,
        } as unknown as MouseEvent;
        const calls: unknown[][] = [];

        handleReaderLinkClick({} as App, content, event, (...args) => calls.push(args));
        assert.equal(calls.length, 1);
        assert.equal(calls[0][1], "https://example.com/");
        assert.equal(calls[0][2], event);
        assert.equal(calls[0][3], true);
    });
});

describe("Element detail state", () => {
    const detail = {
        elementId: "topic-id", type: "topic", title: "Topic", sourceMode: "html", supportStatus: "supported",
        topicMaterial: {kind: "html", html: "<p>Body</p>", cleaningPolicyVersion: "siyuanmemo-topic-html-v1"},
    };

    it("maps eligible, unavailable, missing, and failed reads to closed UI states", () => {
        assert.equal(deriveElementTabState({ok: true, element: detail}).phase, "renderedTopic");
        assert.deepEqual(deriveElementTabState({ok: true, element: {...detail, type: "item", topicMaterial: undefined}}), {
            phase: "rendererUnavailable", detail: {...detail, type: "item", topicMaterial: undefined}, reason: "unsupportedElementType",
        });
        assert.deepEqual(deriveElementTabState({ok: false, kind: "missing"}), {phase: "missing"});
        assert.deepEqual(deriveElementTabState({ok: false, kind: "request"}), {phase: "failure", errorKind: "request"});
        assert.deepEqual(deriveElementTabState({ok: false, kind: "response"}), {phase: "failure", errorKind: "response"});
    });
});

const supportedTopic = {
    elementId: "topic-id",
    type: "topic",
    title: "Topic",
    sourceMode: "html",
    supportStatus: "supported",
    topicMaterial: {
        kind: "html",
        html: "<p>Body</p>",
        cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
    },
};

const writableTopic = {
    ...supportedTopic,
    titleRevision: "rev-title",
    topicMaterial: {
        ...supportedTopic.topicMaterial,
        html: "",
        revision: "rev-material",
    },
};

const createTabFixture = () => {
    const panelElement = testDocument.createElement("div");
    const headElement = testDocument.createElement("div");
    const titles: string[] = [];
    const tab = {
        panelElement: panelElement as unknown as HTMLElement,
        headElement: headElement as unknown as HTMLElement,
        icon: "",
        updateTitle(title: string) {
            titles.push(title);
        },
    } as unknown as import("../layout/Tab").Tab;
    return {headElement, panelElement, tab, titles};
};

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Element tab lifecycle", () => {
    it("does not expose a reusable tab while the Element detail request is pending", async () => {
        window.siyuan.config.fileTree.openFilesUseCurrentTab = true;
        const request = deferred<ElementDetailResult>();
        getElementImpl = () => request.promise;
        const fixture = createTabFixture();

        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});

        assert.equal(fixture.headElement.classList.contains("item--unupdate"), false);
        request.resolve({ok: true, element: supportedTopic});
        await nextTurn();
        assert.equal(fixture.headElement.classList.contains("item--unupdate"), true);
    });

    it("ignores a late detail response after its panel leaves the DOM", async () => {
        const request = deferred<ElementDetailResult>();
        getElementImpl = () => request.promise;
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        const loadingChildren = [...fixture.panelElement.children];

        fixture.panelElement.isConnected = false;
        request.resolve({ok: true, element: supportedTopic});
        await nextTurn();

        assert.equal(model.state.phase, "loading");
        assert.deepEqual(fixture.panelElement.children, loadingChildren);
        assert.deepEqual(fixture.titles, []);
        assert.equal(model.readerElement, undefined);
    });

    it("keeps Retry non-reentrant and commits the next successful request", async () => {
        const first = deferred<ElementDetailResult>();
        const second = deferred<ElementDetailResult>();
        let requests = 0;
        getElementImpl = () => {
            requests++;
            return requests === 1 ? first.promise : second.promise;
        };
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});

        model.retry();
        assert.equal(requests, 1);
        first.resolve({ok: false, kind: "request"});
        await nextTurn();

        const retryButton = fixture.panelElement.querySelector("button");
        assert.ok(retryButton);
        retryButton.dispatch("click");
        model.retry();
        assert.equal(requests, 2);

        second.resolve({ok: true, element: supportedTopic});
        await nextTurn();

        assert.equal(model.state.phase, "renderedTopic");
        assert.ok(model.readerElement);
        const viewport = fixture.panelElement.querySelector(".symemo-element-tab__viewport") as TestElement;
        assert.equal(viewport.scrollTop, 0);
        assert.deepEqual(fixture.titles, ["Topic"]);
    });

    it("projects writable surface transition readiness into item replacement eligibility", async () => {
        window.siyuan.config.fileTree.openFilesUseCurrentTab = true;
        getElementImpl = async () => ({ok: true, element: writableTopic});
        const fixture = createTabFixture();
        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        await nextTurn();

        assert.equal(lastSurface?.mounted, true);
        assert.equal(fixture.headElement.classList.contains("item--unupdate"), true);

        lastSurface?.onTransitionReadyChange?.(false);
        assert.equal(fixture.headElement.classList.contains("item--unupdate"), false);

        lastSurface?.onTransitionReadyChange?.(true);
        assert.equal(fixture.headElement.classList.contains("item--unupdate"), true);
    });

    it("turns a writable editor mount failure into a retryable stable tab state", async () => {
        surfaceMountError = new Error("editor chunk unavailable");
        getElementImpl = async () => ({ok: true, element: writableTopic});
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        await nextTurn();

        assert.equal(model.state.phase, "failure");
        assert.equal(fixture.panelElement.querySelector(".b3-label__text")?.textContent, "Load failed");
        assert.ok(fixture.panelElement.querySelector("button"));
        assert.equal(fixture.headElement.classList.contains("item--unupdate"), true);
    });

    it("keeps a late writable detail inert until the window barrier is cancelled", async () => {
        const request = deferred<ElementDetailResult>();
        getElementImpl = () => request.promise;
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});

        model.setWindowBarrier(true);
        request.resolve({ok: true, element: writableTopic});
        await nextTurn();
        assert.equal(lastSurface, undefined);

        model.setWindowBarrier(false);
        await nextTurn();
        assert.equal(lastSurface?.mounted, true);
    });

    it("does not make a dirty writable surface reusable when a window barrier is released", async () => {
        window.siyuan.config.fileTree.openFilesUseCurrentTab = true;
        getElementImpl = async () => ({ok: true, element: writableTopic});
        const fixture = createTabFixture();
        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        await nextTurn();

        lastSurface?.onTransitionReadyChange?.(false);
        lastParticipant?.setWindowBarrier(true);
        lastParticipant?.setWindowBarrier(false);

        assert.equal(fixture.headElement.classList.contains("item--unupdate"), false);
    });

    it("opens the accepted save-as-new Topic by identity", async () => {
        getElementImpl = async () => ({ok: true, element: writableTopic});
        const fixture = createTabFixture();
        const app = {} as App;
        new ElementTab({app, tab: fixture.tab, elementId: "topic-id"});
        await nextTurn();

        lastSurface?.onSaveAsNew?.("topic-new");

        assert.deepEqual(openElementCalls, [{
            app,
            elementId: "topic-new",
            intent: "new",
            source: "other",
        }]);
    });
});
