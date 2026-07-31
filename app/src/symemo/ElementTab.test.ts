import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {App} from "../index";
import type {ElementDetailResult, ElementDetailView, ItemAuthoringResult, ItemGradeCallResult, ItemQAChangeResult, OpenElementOptions, SessionCallResult} from "./types";
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
let getCurrentLearningSessionImpl: () => Promise<SessionCallResult>;
let startLearningImpl: () => Promise<SessionCallResult>;
let stopLearningImpl: () => Promise<SessionCallResult>;
let nextTopicImpl: typeof import("./api").nextTopic;
let showAnswerImpl: (elementId: string) => Promise<SessionCallResult>;
let gradeItemImpl: (elementId: string, eventId: string, rawGrade: 0 | 1 | 2 | 3 | 4 | 5) => Promise<ItemGradeCallResult>;
let getItemAuthoringImpl: (elementId: string) => Promise<ItemAuthoringResult>;
let saveItemQAImpl: (elementId: string, revision: string, prompt: string, answer: string) => Promise<ItemQAChangeResult>;
let runWindowOperationImpl: (name: string, callback: (operation: {isCancelled: boolean}) => Promise<unknown>) => Promise<unknown>;
let testDocument: TestDocument;
let lastSurface: FakeTopicHtmlSurface | undefined;
let openElementCalls: OpenElementOptions[];
let lastParticipant: {setWindowBarrier(active: boolean): void; cleanup?(): void} | undefined;
let surfaceMountError: Error | undefined;
let surfaceMountGate: ReturnType<typeof deferred<void>> | undefined;
let surfaceDestroyCalls = 0;
let unregisterCalls = 0;

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
        if (surfaceMountGate) await surfaceMountGate.promise;
        this.mounted = true;
        this.onTransitionReadyChange?.(true);
    }

    public prepareTransition() {
        return Promise.resolve({allowed: true});
    }

    public focus() {}
    public destroy() {
        surfaceDestroyCalls++;
    }
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
    require.cache[stubPaths[3]] = {exports: {
        getElement: (elementId: string) => getElementImpl(elementId),
        getCurrentLearningSession: () => getCurrentLearningSessionImpl(),
        startLearning: () => startLearningImpl(),
        stopLearning: () => stopLearningImpl(),
        nextTopic: (elementId: string, eventId: string) => nextTopicImpl(elementId, eventId),
        showAnswer: (elementId: string) => showAnswerImpl(elementId),
        gradeItem: (elementId: string, eventId: string, rawGrade: 0 | 1 | 2 | 3 | 4 | 5) =>
            gradeItemImpl(elementId, eventId, rawGrade),
        acceptLearningStage: () => getCurrentLearningSessionImpl(),
        declineLearningStage: () => getCurrentLearningSessionImpl(),
        getItemAuthoring: (elementId: string) => getItemAuthoringImpl(elementId),
        saveItemQA: (elementId: string, revision: string, prompt: string, answer: string) => saveItemQAImpl(elementId, revision, prompt, answer),
    }} as NodeModule;
    require.cache[stubPaths[4]] = {exports: {TopicHtmlSurface: FakeTopicHtmlSurface}} as NodeModule;
    require.cache[stubPaths[5]] = {exports: {
        openElement: (options: OpenElementOptions) => openElementCalls.push(options),
    }} as NodeModule;
    require.cache[stubPaths[6]] = {exports: {
        registerWindowAuthoringParticipant: (participant: {setWindowBarrier(active: boolean): void; cleanup?(): void}) => {
            lastParticipant = participant;
            return (): void => {
                unregisterCalls++;
            };
        },
        runWindowAuthoringOperation: (name: string, callback: (operation: {isCancelled: boolean}) => Promise<unknown>) =>
            runWindowOperationImpl(name, callback),
    }} as NodeModule;
    (globalThis as unknown as {window: Window}).window = {
        siyuan: {
            config: {fileTree: {openFilesUseCurrentTab: false}},
            languages: {
                loading: "Loading",
                retry: "Retry",
                symemoElementLoadFailed: "Load failed",
                symemoElementMissing: "Missing",
                symemoLearn: "Learn",
                symemoNext: "Next",
                symemoShowAnswer: "Show Answer",
                symemoAnswer: "Answer",
                symemoResumeLearning: "Resume learning",
                symemoEndLearning: "End learning",
                symemoLearningLoading: "Loading learning session...",
                symemoLearningBusy: "Updating learning session...",
                symemoLearningPreview: "Another Topic is active.",
                symemoNoDueTopics: "No due Topics.",
                symemoUnsupportedLearningStage: "Unsupported stage.",
                symemoLearningReadOnly: "Read-only.",
                symemoLearningUnavailable: "Learning unavailable.",
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
    getCurrentLearningSessionImpl = async () => ({
        ok: true,
        session: {status: "completed", stage: "completed", phase: "completed", remainingElementIds: []},
    });
    startLearningImpl = getCurrentLearningSessionImpl;
    stopLearningImpl = getCurrentLearningSessionImpl;
    nextTopicImpl = async (_elementId, eventId) => ({
        ok: true,
        eventId,
        reviewAccepted: true,
        session: {status: "completed", stage: "completed", phase: "completed", remainingElementIds: []},
    });
    showAnswerImpl = async () => getCurrentLearningSessionImpl();
    gradeItemImpl = async (_elementId, eventId, rawGrade) => ({
        ok: true,
        eventId,
        rawGrade,
        reviewAccepted: true,
        session: {status: "completed", stage: "completed", phase: "completed", remainingElementIds: []},
    });
    runWindowOperationImpl = async (_name, callback) => ({
        started: true,
        value: await callback({isCancelled: false}),
    });
    getItemAuthoringImpl = async (elementId) => ({ok: true, authoring: {
        elementId,
        prompt: "Derived Item title",
        answer: "Item answer",
        contentRevision: "rev-v1-item",
    }});
    saveItemQAImpl = async (elementId, _revision, prompt, answer) => ({ok: true, change: {
        kind: "SaveItemQA",
        elementId,
        changedField: "itemQA",
        revision: "rev-v1-item-saved",
        itemQA: {prompt, answer, contentRevision: "rev-v1-item-saved"},
        changed: true,
        changeAccepted: true,
    }});
    lastSurface = undefined;
    lastParticipant = undefined;
    openElementCalls = [];
    surfaceMountError = undefined;
    surfaceMountGate = undefined;
    surfaceDestroyCalls = 0;
    unregisterCalls = 0;
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
        const itemDetail: ElementDetailView = {
            ...detail,
            type: "item",
            sourceMode: "unknown",
            topicMaterial: undefined,
            item: {kind: "qa", prompt: "Question", revision: "rev-v1-item"},
        };
        assert.deepEqual(deriveElementTabState({ok: true, element: itemDetail}), {
            phase: "itemAuthoring", detail: itemDetail,
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

const writableItem = {
    elementId: "item-id",
    rootElementId: "item-id",
    storageKind: "rootDocument",
    type: "item",
    title: "Derived Item title",
    sourceMode: "unknown",
    supportStatus: "supported",
    item: {kind: "qa" as const, prompt: "Derived Item title", revision: "rev-v1-item"},
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

    it("gives keyboard ownership to one stable Element-wide control view", () => {
        const source = readFileSync(require.resolve("./ElementTab"), "utf8");
        assert.equal(source.includes("LearningControls"), true);
        assert.equal(source.includes("ElementLearningCoordinator"), true);
        assert.equal(source.includes("TopicLearningControls"), false);
        assert.equal(source.includes("TopicLearningCoordinator"), false);
    });
    it("creates stable content and learning-control siblings before asynchronous reads resolve", () => {
        const detail = deferred<ElementDetailResult>();
        const current = deferred<SessionCallResult>();
        getElementImpl = () => detail.promise;
        getCurrentLearningSessionImpl = () => current.promise;
        const fixture = createTabFixture();

        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});

        assert.equal(fixture.panelElement.children.length, 2);
        assert.equal(fixture.panelElement.children[0].classList.contains("symemo-element-tab__surface"), true);
        assert.equal(fixture.panelElement.children[1].classList.contains("symemo-element-tab__learning"), true);
    });

    it("keeps controls stable when detail and Current resolve in either order", async () => {
        const detail = deferred<ElementDetailResult>();
        const current = deferred<SessionCallResult>();
        getElementImpl = () => detail.promise;
        getCurrentLearningSessionImpl = () => current.promise;
        const fixture = createTabFixture();
        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        const controls = fixture.panelElement.children[1];

        current.resolve({ok: true, session: {
            sessionId: "session-007",
            status: "active",
            stage: "outstanding",
            phase: "question",
            current: {kind: "element.topic", elementId: "topic-id"},
            remainingElementIds: [],
        }});
        await nextTurn();
        assert.equal(fixture.panelElement.children[1], controls);

        detail.resolve({ok: true, element: writableTopic});
        await nextTurn();
        assert.equal(fixture.panelElement.children[1], controls);
        assert.equal(lastSurface?.mounted, true);
        assert.equal(surfaceDestroyCalls, 0);
        assert.equal(controls.querySelector("button")?.textContent, "Next");
    });

    it("keeps controls through loading failure and retryable content replacement", async () => {
        getElementImpl = async () => ({ok: false, kind: "request"});
        const fixture = createTabFixture();
        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        const controls = fixture.panelElement.children[1];
        await nextTurn();

        assert.equal(fixture.panelElement.children[1], controls);
        assert.ok(fixture.panelElement.children[0].querySelector("button"));
        assert.equal(controls.classList.contains("symemo-element-tab__learning"), true);
    });

    it("preserves a recoverable Current failure after Element detail reprojects eligibility", async () => {
        const detail = deferred<ElementDetailResult>();
        getElementImpl = () => detail.promise;
        getCurrentLearningSessionImpl = async () => ({
            ok: false,
            failure: {errorCode: "request", retryable: true, kind: "request"},
        });
        const fixture = createTabFixture();
        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        const controls = fixture.panelElement.children[1];
        await nextTurn();
        assert.equal(controls.querySelector("button")?.textContent, "Resume learning");

        detail.resolve({ok: true, element: writableTopic});
        await nextTurn();

        assert.equal(controls.querySelector("button")?.textContent, "Resume learning");
        assert.equal(controls.textContent.includes("Loading learning session"), false);
    });

    it("routes ordinary and repeated cleanup through one idempotent teardown", async () => {
        getElementImpl = async () => ({ok: true, element: writableTopic});
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        await nextTurn();

        (model as unknown as {cleanup(): void}).cleanup();
        (model as unknown as {cleanup(): void}).cleanup();
        model.destroy();

        assert.equal(unregisterCalls, 1);
        assert.equal(surfaceDestroyCalls, 1);
        assert.equal(fixture.panelElement.children.length, 0);
    });

    it("routes participant cleanup through the same model teardown", async () => {
        getElementImpl = async () => ({ok: true, element: writableTopic});
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        await nextTurn();

        lastParticipant?.cleanup?.();
        model.destroy();

        assert.equal(unregisterCalls, 1);
        assert.equal(surfaceDestroyCalls, 1);
    });

    it("keeps a detail response inert after cleanup invalidates its generation", async () => {
        const request = deferred<ElementDetailResult>();
        getElementImpl = () => request.promise;
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});

        (model as unknown as {cleanup(): void}).cleanup();
        request.resolve({ok: true, element: writableTopic});
        await nextTurn();

        assert.equal(model.state.phase, "loading");
        assert.equal(lastSurface, undefined);
        assert.equal(fixture.panelElement.children.length, 0);
    });

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

    it("mounts an ordinary Item authoring Surface with derived native identity and transition barriers", async () => {
        window.siyuan.config.fileTree.openFilesUseCurrentTab = true;
        getElementImpl = async () => ({ok: true, element: writableItem});
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "item-id"});
        await nextTurn();
        await nextTurn();

        assert.equal(model.state.phase, "itemAuthoring");
        assert.deepEqual(fixture.titles, ["Derived Item title"]);
        assert.equal(fixture.tab.icon, "iconRiffCard");
        const prompt = fixture.panelElement.querySelector('textarea[data-role="prompt"]') as TestElement;
        assert.ok(prompt);
        prompt.value = "Edited derived title";
        prompt.dispatch("input");
        assert.equal(fixture.headElement.classList.contains("item--unupdate"), false);

        assert.deepEqual(await model.prepareTransition("tab-detach"), {allowed: true});
        assert.equal(fixture.headElement.classList.contains("item--unupdate"), true);
        assert.equal(saveItemQAImpl !== undefined, true);
    });

    it("replaces ordinary Item authoring with the matching active review Surface", async () => {
        getElementImpl = async () => ({ok: true, element: writableItem});
        getCurrentLearningSessionImpl = async () => ({ok: true, session: {
            sessionId: "item-review-session",
            status: "active",
            stage: "outstanding",
            phase: "question",
            current: {kind: "element.item", elementId: "item-id", prompt: "Captured question"},
            remainingElementIds: [],
        }});
        const fixture = createTabFixture();
        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "item-id"});
        await nextTurn();
        await nextTurn();

        assert.equal(fixture.panelElement.querySelector("textarea"), null);
        assert.equal(fixture.panelElement.querySelector('[data-role="item-question"]')?.textContent, "Captured question");
        assert.equal(fixture.panelElement.children[1].querySelector("button")?.textContent, "Show Answer");
    });

    it("restores ordinary Item authoring when the active review is no longer current", async () => {
        let current: SessionCallResult = {ok: true, session: {
            sessionId: "item-review-session",
            status: "active",
            stage: "outstanding",
            phase: "question",
            current: {kind: "element.item", elementId: "item-id", prompt: "Captured question"},
            remainingElementIds: [],
        }};
        getElementImpl = async () => ({ok: true, element: writableItem});
        getCurrentLearningSessionImpl = async () => current;
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "item-id"});
        await nextTurn();
        await nextTurn();
        assert.equal(fixture.panelElement.querySelector("textarea"), null);

        current = {ok: true, session: {status: "completed", stage: "completed", phase: "completed", remainingElementIds: []}};
        await (model as unknown as {learningCoordinator: {resume(): Promise<void>}}).learningCoordinator.resume();

        assert.ok(fixture.panelElement.querySelector('textarea[data-role="prompt"]'));
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
        const controls = fixture.panelElement.children[1];
        assert.equal(
            controls.querySelector(".symemo-element-tab__learning-status")?.textContent,
            "Learning unavailable.",
        );
    });

    it("restores active Topic controls when a barrier begins during Surface mount", async () => {
        surfaceMountGate = deferred<void>();
        getElementImpl = async () => ({ok: true, element: writableTopic});
        getCurrentLearningSessionImpl = async () => ({ok: true, session: {
            sessionId: "session-007",
            status: "active",
            stage: "outstanding",
            phase: "question",
            current: {kind: "element.topic", elementId: "topic-id"},
            remainingElementIds: [],
        }});
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        await nextTurn();

        model.setWindowBarrier(true);
        surfaceMountGate.resolve();
        await nextTurn();
        model.setWindowBarrier(false);
        await nextTurn();

        assert.equal(lastSurface?.mounted, true);
        assert.equal(fixture.panelElement.children[1].querySelector("button")?.textContent, "Next");
    });

    it("never exposes Next for a read-only fallback that is not a supported Topic", async () => {
        getElementImpl = async () => ({ok: true, element: {
            ...supportedTopic,
            supportStatus: "unsupportedReadOnly",
        }});
        getCurrentLearningSessionImpl = async () => ({ok: true, session: {
            sessionId: "session-007",
            status: "active",
            stage: "outstanding",
            phase: "question",
            current: {kind: "element.topic", elementId: "topic-id"},
            remainingElementIds: [],
        }});
        const fixture = createTabFixture();
        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "topic-id"});
        await nextTurn();

        const controls = fixture.panelElement.children[1];
        assert.equal(controls.textContent.includes("Next"), false);
        assert.equal(controls.querySelector("button")?.textContent, "End learning");
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

    it("keeps a cancelled Show Answer response inert across the window barrier", async () => {
        const response = deferred<SessionCallResult>();
        let operation: {isCancelled: boolean} | undefined;
        getElementImpl = async () => ({ok: true, element: writableItem});
        getCurrentLearningSessionImpl = async () => ({ok: true, session: {
            sessionId: "barrier-session",
            status: "active",
            stage: "outstanding",
            phase: "question",
            current: {kind: "element.item", elementId: "item-id", prompt: "Question"},
            remainingElementIds: [],
        }});
        showAnswerImpl = async () => response.promise;
        runWindowOperationImpl = async (name, callback) => {
            const currentOperation = {isCancelled: false};
            if (name === "symemo-item-show-answer") operation = currentOperation;
            return {started: true, value: await callback(currentOperation)};
        };
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "item-id"});
        await nextTurn();
        await nextTurn();

        (fixture.panelElement.children[1].querySelector("button") as TestElement).dispatch("click");
        await nextTurn();
        model.setWindowBarrier(true);
        assert.ok(operation);
        operation.isCancelled = true;
        response.resolve({ok: true, session: {
            sessionId: "barrier-session",
            status: "active",
            stage: "outstanding",
            phase: "answer",
            current: {kind: "element.item", elementId: "item-id", prompt: "Question", answer: "Answer"},
            remainingElementIds: [],
        }});
        await nextTurn();
        model.setWindowBarrier(false);

        assert.equal(fixture.panelElement.querySelector('[data-role="item-answer"]'), null);
        assert.equal(fixture.panelElement.children[1].querySelector("[data-grade]"), null);
    });

    it("drops a late Show Answer effect after tab close and idempotent cleanup", async () => {
        const response = deferred<SessionCallResult>();
        getElementImpl = async () => ({ok: true, element: writableItem});
        getCurrentLearningSessionImpl = async () => ({ok: true, session: {
            sessionId: "close-session",
            status: "active",
            stage: "outstanding",
            phase: "question",
            current: {kind: "element.item", elementId: "item-id", prompt: "Question"},
            remainingElementIds: [],
        }});
        showAnswerImpl = async () => response.promise;
        const fixture = createTabFixture();
        const model = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "item-id"});
        await nextTurn();
        await nextTurn();
        (fixture.panelElement.children[1].querySelector("button") as TestElement).dispatch("click");
        await nextTurn();

        assert.deepEqual(await model.prepareTransition("tab-detach"), {allowed: true});
        model.destroy();
        response.resolve({ok: true, session: {
            sessionId: "close-session",
            status: "active",
            stage: "outstanding",
            phase: "answer",
            current: {kind: "element.item", elementId: "item-id", prompt: "Question", answer: "Answer"},
            remainingElementIds: [],
        }});
        await nextTurn();

        assert.deepEqual(fixture.panelElement.children, []);
        assert.equal(unregisterCalls, 1);
    });

    it("does not publish a late accepted grade into a detached replacement panel", async () => {
        const response = deferred<ItemGradeCallResult>();
        getElementImpl = async () => ({ok: true, element: writableItem});
        getCurrentLearningSessionImpl = async () => ({ok: true, session: {
            sessionId: "replace-session",
            status: "active",
            stage: "outstanding",
            phase: "answer",
            current: {kind: "element.item", elementId: "item-id", prompt: "Question", answer: "Answer"},
            remainingElementIds: [],
        }});
        gradeItemImpl = async () => response.promise;
        const fixture = createTabFixture();
        new ElementTab({app: {} as App, tab: fixture.tab, elementId: "item-id"});
        await nextTurn();
        await nextTurn();
        const controls = fixture.panelElement.children[1];
        (controls.querySelector('button[data-grade="4"]') as TestElement).dispatch("click");
        await nextTurn();

        fixture.panelElement.isConnected = false;
        response.resolve({
            ok: true,
            eventId: "accepted-event",
            rawGrade: 4,
            reviewAccepted: true,
            session: {
                sessionId: "replace-session",
                status: "active",
                stage: "outstanding",
                phase: "question",
                current: {kind: "element.item", elementId: "next-item", prompt: "Next"},
                remainingElementIds: [],
            },
        });
        await nextTurn();

        assert.equal(controls.textContent.includes("Learn"), false);
        assert.deepEqual(openElementCalls, []);
    });

    it("discards disposable Item draft and learning state when the tab is destroyed and recreated", async () => {
        let authoringReads = 0;
        getElementImpl = async () => ({ok: true, element: writableItem});
        getItemAuthoringImpl = async (elementId) => {
            authoringReads++;
            return {ok: true, authoring: {
                elementId, prompt: "Authoritative prompt", answer: "Authoritative answer", contentRevision: "rev-authority",
            }};
        };
        const fixture = createTabFixture();
        const first = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "item-id"});
        await nextTurn();
        await nextTurn();
        const prompt = fixture.panelElement.querySelector('textarea[data-role="prompt"]') as TestElement;
        prompt.value = "Disposable local draft";
        prompt.dispatch("input");
        first.destroy();

        const second = new ElementTab({app: {} as App, tab: fixture.tab, elementId: "item-id"});
        await nextTurn();
        await nextTurn();

        assert.equal(authoringReads, 2);
        assert.equal((fixture.panelElement.querySelector('textarea[data-role="prompt"]') as TestElement).value, "Authoritative prompt");
        assert.equal(fixture.panelElement.textContent.includes("Disposable local draft"), false);
        second.destroy();
    });
});
