import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import type {App} from "../index";
import type {ElementOpenHost, ElementTabHandle} from "./openElement";
import type {OpenElementOptions, SymemoElementLayoutData} from "./types";

class TestClassList {
    private readonly values = new Set<string>();

    constructor(...values: string[]) {
        this.add(...values);
    }

    public add(...values: string[]) {
        values.forEach((value) => this.values.add(value));
    }

    public remove(...values: string[]) {
        values.forEach((value) => this.values.delete(value));
    }

    public contains(value: string) {
        return this.values.has(value);
    }
}

class TestHeadElement {
    public readonly classList = new TestClassList();
    private readonly attributes = new Map<string, string>();

    public getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
    }

    public setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
    }
}

class TestLayout {
    constructor(
        public direction: "lr" | "tb" = "lr",
        public children: Array<TestLayout | TestWnd> = [],
    ) {}
}

class TestElementTab {
    public readonly elementId: string;

    constructor(value: string | {elementId: string}) {
        this.elementId = typeof value === "string" ? value : value.elementId;
    }
}

class TestTab {
    public static instances: TestTab[] = [];
    public readonly id = `tab-${TestTab.instances.length + 1}`;
    public headElement?: TestHeadElement = new TestHeadElement();
    public panelElement = {} as HTMLElement;
    public parent!: TestWnd;
    public model?: TestElementTab;
    public readonly callback?: (tab: TestTab) => void;

    constructor(options: {callback?: (tab: TestTab) => void}) {
        this.callback = options.callback;
        TestTab.instances.push(this);
    }

    public addModel(model: TestElementTab) {
        this.model = model;
    }
}

class TestWnd {
    public readonly element = {} as HTMLElement;
    public parent!: TestLayout;
    public children: TestTab[] = [];
    public readonly added: TestTab[] = [];
    public readonly removed: string[] = [];
    public readonly splitCalls: Array<"lr" | "tb"> = [];
    public readonly switched: TestHeadElement[] = [];
    public headingCount = 0;
    public splitResult?: TestWnd;
    private mutationTail: Promise<void> = Promise.resolve();

    public addTab(tab: TestTab) {
        this.added.push(tab);
        this.children.push(tab);
        if (!allTabs.includes(tab)) allTabs.push(tab);
        tab.parent = this;
        tab.callback?.(tab);
    }

    public removeTab(id: string) {
        this.removed.push(id);
        this.children = this.children.filter((tab) => tab.id !== id);
    }

    public async replaceTab(tab: TestTab, options: {commit: () => boolean}) {
        if (!transitionAllowed || !this.children.includes(tab) || !options.commit()) {
            return false;
        }
        this.removeTab(tab.id);
        return true;
    }

    public runTabMutation<T>(callback: () => Promise<T> | T): Promise<T> {
        const result = this.mutationTail.then(callback, callback);
        this.mutationTail = result.then(() => undefined, () => undefined);
        return result;
    }

    public async trimOverflowTabs(): Promise<void> {
        return undefined;
    }

    public showHeading() {
        this.headingCount++;
    }

    public split(direction: "lr" | "tb") {
        this.splitCalls.push(direction);
        return this.splitResult || this;
    }

    public switchTab(headElement: TestHeadElement) {
        this.switched.push(headElement);
    }
}

const stubPaths = [
    require.resolve("../layout"),
    require.resolve("../layout/Tab"),
    require.resolve("../layout/getAll"),
    require.resolve("../layout/util"),
    require.resolve("./ElementTab"),
    require.resolve("./authoringRegistry"),
];
const originalModules = stubPaths.map((modulePath) => require.cache[modulePath]);
let openElementWithHost: typeof import("./openElement").openElementWithHost;
let createNativeHost: typeof import("./openElement").createNativeHost;
let activeWnd: TestWnd | undefined;
let allTabs: TestTab[] = [];
let pdfLoading = new Set<HTMLElement>();
let pdfChecks: HTMLElement[] = [];
let authoringBusy = false;
let transitionAllowed = true;

before(async () => {
    require.cache[stubPaths[0]] = {exports: {Layout: TestLayout}} as NodeModule;
    require.cache[stubPaths[1]] = {exports: {Tab: TestTab}} as NodeModule;
    require.cache[stubPaths[2]] = {exports: {
        getAllTabs: () => allTabs,
        getAllModels: () => ({elements: [] as import("./Elements").Elements[]}),
    }} as NodeModule;
    require.cache[stubPaths[3]] = {exports: {
        getInstanceById: (): undefined => undefined,
        getWndByLayout: () => activeWnd,
        pdfIsLoading: (element: HTMLElement) => {
            pdfChecks.push(element);
            return pdfLoading.has(element);
        },
    }} as NodeModule;
    require.cache[stubPaths[4]] = {exports: {ElementTab: TestElementTab}} as NodeModule;
    require.cache[stubPaths[5]] = {exports: {
        isWindowAuthoringBusy: () => authoringBusy,
        prepareModelTransition: async () => transitionAllowed ? {allowed: true} : {allowed: false, reason: "save-failed"},
    }} as NodeModule;

    (globalThis as unknown as {window: Window}).window = {
        siyuan: {
            config: {fileTree: {alwaysSelectOpenedFile: false, maxOpenTabCount: 8, openFilesUseCurrentTab: false}},
            languages: {untitled: "Untitled"},
            layout: {centerLayout: {}},
        },
    } as unknown as Window;
    (globalThis as unknown as {document: Document}).document = {
        querySelector: (selector: string): null => {
            void selector;
            return null;
        },
    } as unknown as Document;
    ({createNativeHost, openElementWithHost} = await import("./openElement"));
});

beforeEach(() => {
    activeWnd = undefined;
    allTabs = [];
    pdfLoading = new Set();
    pdfChecks = [];
    TestTab.instances = [];
    authoringBusy = false;
    transitionAllowed = true;
    window.siyuan.config.fileTree.openFilesUseCurrentTab = false;
    window.siyuan.config.fileTree.maxOpenTabCount = 8;
});

after(() => {
    stubPaths.forEach((modulePath, index) => {
        if (originalModules[index]) require.cache[modulePath] = originalModules[index];
        else delete require.cache[modulePath];
    });
});

const options = (overrides: Partial<OpenElementOptions> = {}): OpenElementOptions => ({
    app: {} as App,
    elementId: "topic-id",
    title: "Topic",
    type: "topic",
    intent: "ordinary",
    ...overrides,
});

const identity: SymemoElementLayoutData = {
    instance: "SymemoElement",
    elementId: "topic-id",
    title: "Topic",
    icon: "iconFile",
};

const createHost = () => {
    const focused: ElementTabHandle[] = [];
    const created: Array<{identity: SymemoElementLayoutData; intent: string}> = [];
    const matches: ElementTabHandle[] = [];
    const host: ElementOpenHost = {
        untitled: "Untitled",
        findOrdinaryMatches: () => matches,
        focusTab(tab) {
            focused.push(tab);
        },
        createTab(tabIdentity, intent) {
            created.push({identity: tabIdentity, intent});
            return {elementId: tabIdentity.elementId};
        },
    };
    return {created, focused, host, matches};
};

const attachWnd = (wnd: TestWnd, parent = new TestLayout()) => {
    wnd.parent = parent;
    if (!parent.children.includes(wnd)) parent.children.push(wnd);
    activeWnd = wnd;
    return wnd;
};

const addExistingTab = (wnd: TestWnd, model?: TestElementTab, initData?: object) => {
    const tab = new TestTab({});
    tab.parent = wnd;
    tab.model = model;
    if (initData) tab.headElement?.setAttribute("data-initdata", JSON.stringify(initData));
    wnd.children.push(tab);
    allTabs.push(tab);
    return tab;
};

describe("ordinary Element opening", () => {
    it("refuses a blank Element ID without touching host tabs", async () => {
        const fixture = createHost();
        assert.equal(await openElementWithHost(options({elementId: "  "}), fixture.host), undefined);
        assert.equal(fixture.created.length, 0);
        assert.equal(fixture.focused.length, 0);
    });

    it("creates one ordinary native identity with safe title and semantic icon metadata", async () => {
        const fixture = createHost();
        const result = await openElementWithHost(options({title: "<img onerror=alert(1)>", type: "topic"}), fixture.host);

        assert.ok(result);
        assert.deepEqual(fixture.created, [{identity: {
            instance: "SymemoElement", elementId: "topic-id", title: "<img onerror=alert(1)>", icon: "iconFile",
        }, intent: "ordinary"}]);
    });

    it("keeps Item Q/A, session, event, and grade facts out of native layout identity", async () => {
        const fixture = createHost();
        const withDisposableFacts = {
            ...options({elementId: "item-id", title: "Derived question", type: "item"}),
            prompt: "Private question",
            answer: "Private answer",
            contentRevision: "rev-item",
            sessionId: "mixed-session",
            eventId: "grade-event",
            rawGrade: 2,
        } as OpenElementOptions;

        await openElementWithHost(withDisposableFacts, fixture.host);

        assert.deepEqual(fixture.created, [{
            identity: {
                instance: "SymemoElement",
                elementId: "item-id",
                title: "Derived question",
                icon: "iconRiffCard",
            },
            intent: "ordinary",
        }]);
        assert.deepEqual(Object.keys(fixture.created[0].identity).sort(), ["elementId", "icon", "instance", "title"]);
    });

    it("focuses a live same-ID match instead of creating a duplicate", async () => {
        const fixture = createHost();
        const existing = {elementId: "topic-id"};
        fixture.matches.push(existing);

        assert.equal(await openElementWithHost(options(), fixture.host), existing);
        assert.deepEqual(fixture.focused, [existing]);
        assert.equal(fixture.created.length, 0);
    });

    it("bypasses all matches for explicit new and delegates current/right/bottom intent", async () => {
        for (const intent of ["new", "current", "right", "bottom"] as const) {
            const fixture = createHost();
            fixture.matches.push({elementId: "topic-id"});
            await openElementWithHost(options({intent}), fixture.host);
            assert.equal(fixture.focused.length, 0);
            assert.equal(fixture.created[0].intent, intent);
        }
    });
});

describe("native Element host", () => {
    it("opens right and bottom in an empty Wnd without splitting", async () => {
        for (const intent of ["right", "bottom"] as const) {
            const wnd = attachWnd(new TestWnd());
            const placeholder = new TestTab({});
            placeholder.headElement = undefined;
            placeholder.parent = wnd;
            wnd.children.push(placeholder);

            const result = await createNativeHost({} as App).createTab(identity, intent);

            assert.ok(result);
            assert.deepEqual(wnd.splitCalls, []);
            assert.equal(wnd.added.length, 1);
            assert.deepEqual(pdfChecks, [wnd.element]);
            activeWnd = undefined;
            pdfChecks = [];
            TestTab.instances = [];
        }
    });

    it("blocks empty-Wnd right and bottom opens while its PDF is loading", async () => {
        for (const intent of ["right", "bottom"] as const) {
            const wnd = attachWnd(new TestWnd());
            const placeholder = new TestTab({});
            placeholder.headElement = undefined;
            placeholder.parent = wnd;
            wnd.children.push(placeholder);
            pdfLoading.add(wnd.element);
            const previousCount = TestTab.instances.length;

            assert.equal(await createNativeHost({} as App).createTab(identity, intent), undefined);
            assert.equal(TestTab.instances.length, previousCount);
            assert.deepEqual(wnd.splitCalls, []);
            assert.equal(wnd.added.length, 0);
            pdfLoading.clear();
            pdfChecks = [];
        }
    });

    it("checks an adjacent target Wnd before reusing or creating a tab there", async () => {
        const current = new TestWnd();
        const target = new TestWnd();
        addExistingTab(current, new TestElementTab("other"));
        const existing = addExistingTab(target, new TestElementTab("topic-id"));
        const parent = new TestLayout("lr", [current, target]);
        current.parent = parent;
        target.parent = parent;
        activeWnd = current;
        pdfLoading.add(target.element);

        assert.equal(await createNativeHost({} as App).createTab(identity, "right"), undefined);
        assert.deepEqual(pdfChecks, [target.element]);
        assert.equal(target.switched.length, 0);
        assert.equal(target.added.length, 0);
        assert.deepEqual(current.splitCalls, []);
        assert.ok(existing);
    });

    it("splits in the requested direction when there is no adjacent target", async () => {
        for (const [intent, direction] of [["right", "lr"], ["bottom", "tb"]] as const) {
            const current = attachWnd(new TestWnd());
            addExistingTab(current, new TestElementTab("other"));
            const splitWnd = new TestWnd();
            splitWnd.parent = current.parent;
            current.splitResult = splitWnd;

            const result = await createNativeHost({} as App).createTab(identity, intent);

            assert.ok(result);
            assert.deepEqual(current.splitCalls, [direction]);
            assert.equal(splitWnd.added.length, 1);
            assert.deepEqual(pdfChecks, []);
            activeWnd = undefined;
            pdfChecks = [];
            TestTab.instances = [];
            allTabs = [];
        }
    });

    it("returns an ordinary live match without switching away from a loading PDF", async () => {
        const current = attachWnd(new TestWnd());
        const target = new TestWnd();
        target.parent = current.parent;
        const existing = addExistingTab(target, new TestElementTab("topic-id"));
        pdfLoading.add(target.element);

        const result = await openElementWithHost(options(), createNativeHost({} as App));

        assert.equal(result?.tab, existing as unknown as import("../layout/Tab").Tab);
        assert.deepEqual(pdfChecks, [target.element]);
        assert.equal(target.switched.length, 0);
        assert.equal(TestTab.instances.length, 1);
    });

    it("finds both live and lazy tabs through the production adapter", () => {
        const wnd = attachWnd(new TestWnd());
        const live = addExistingTab(wnd, new TestElementTab("topic-id"));
        const lazy = addExistingTab(wnd, undefined, {instance: "SymemoElement", elementId: "topic-id"});
        live.headElement?.setAttribute("data-activetime", "1");
        lazy.headElement?.setAttribute("data-activetime", "2");

        assert.deepEqual(createNativeHost({} as App).findOrdinaryMatches("topic-id").map((item) => item.tab), [lazy, live]);
    });

    it("focuses an ordinary lazy match without creating a duplicate tab", async () => {
        const wnd = attachWnd(new TestWnd());
        const lazy = addExistingTab(wnd, undefined, {instance: "SymemoElement", elementId: "topic-id"});

        const result = await openElementWithHost(options(), createNativeHost({} as App));

        assert.equal(result?.tab, lazy as unknown as import("../layout/Tab").Tab);
        assert.deepEqual(wnd.switched, [lazy.headElement]);
        assert.equal(wnd.headingCount, 1);
        assert.equal(TestTab.instances.length, 1);
    });

    it("preserves a focused pinned tab and removes the eligible background transient fallback", async () => {
        const wnd = attachWnd(new TestWnd());
        const pinned = addExistingTab(wnd, new TestElementTab("pinned"));
        pinned.headElement?.classList.add("item--unupdate", "item--pin", "item--focus");
        const reusable = addExistingTab(wnd, new TestElementTab("reusable"));
        reusable.headElement?.classList.add("item--unupdate");

        await createNativeHost({} as App).createTab(identity, "current");

        assert.deepEqual(wnd.removed, [reusable.id]);
        assert.equal(wnd.children.includes(pinned), true);
    });

    it("preserves a focused updated tab and removes the eligible background transient fallback", async () => {
        const wnd = attachWnd(new TestWnd());
        const updated = addExistingTab(wnd, new TestElementTab("updated"));
        updated.headElement?.classList.add("item--focus");
        const reusable = addExistingTab(wnd, new TestElementTab("reusable"));
        reusable.headElement?.classList.add("item--unupdate");

        await createNativeHost({} as App).createTab(identity, "current");

        assert.deepEqual(wnd.removed, [reusable.id]);
        assert.equal(wnd.children.includes(updated), true);
    });

    it("replaces a mixed current target in the same native Wnd with only the returned Element identity", async () => {
        const wnd = attachWnd(new TestWnd());
        const topic = addExistingTab(wnd, new TestElementTab("topic-current"));
        topic.headElement?.classList.add("item--unupdate", "item--focus");
        const itemIdentity: SymemoElementLayoutData = {
            instance: "SymemoElement",
            elementId: "item-current",
            title: "Item question",
            icon: "iconRiffCard",
        };

        const result = await createNativeHost({} as App).createTab(itemIdentity, "current");

        assert.ok(result?.tab);
        assert.equal(result?.tab?.parent, wnd as unknown as import("../layout/Wnd").Wnd);
        assert.equal(result?.elementId, "item-current");
        assert.equal((result?.tab?.model as unknown as TestElementTab).elementId, "item-current");
        assert.deepEqual(wnd.removed, [topic.id]);
        assert.equal(wnd.children.length, 1);
    });

    it("delegates each new tab to Wnd.addTab so the host retains tab-cap enforcement", async () => {
        const wnd = attachWnd(new TestWnd());
        addExistingTab(wnd, new TestElementTab("other"));
        window.siyuan.config.fileTree.maxOpenTabCount = 1;

        const result = await createNativeHost({} as App).createTab(identity, "new");

        assert.ok(result);
        assert.equal(wnd.added.length, 1);
        assert.equal(wnd.added[0], result?.tab as unknown as TestTab);
    });

    it("serializes concurrent ordinary opens and creates only one same-ID tab", async () => {
        const wnd = attachWnd(new TestWnd());
        addExistingTab(wnd, new TestElementTab("other"));
        const host = createNativeHost({} as App);

        const [first, second] = await Promise.all([
            host.createTab(identity, "ordinary"),
            host.createTab(identity, "ordinary"),
        ]);

        assert.equal(wnd.added.length, 1);
        assert.equal(first?.tab, wnd.added[0] as unknown as import("../layout/Tab").Tab);
        assert.equal(second?.tab, wnd.added[0] as unknown as import("../layout/Tab").Tab);
    });

    it("does not connect a replacement tab when the reusable surface blocks", async () => {
        const wnd = attachWnd(new TestWnd());
        const reusable = addExistingTab(wnd, new TestElementTab("draft"));
        reusable.headElement?.classList.add("item--unupdate");
        transitionAllowed = false;

        const result = await createNativeHost({} as App).createTab(identity, "current");

        assert.equal(result, undefined);
        assert.equal(wnd.added.length, 0);
        assert.deepEqual(wnd.removed, []);
        assert.equal(wnd.children.includes(reusable), true);
    });

    it("does not focus, split, or create while the renderer authoring barrier is active", async () => {
        const wnd = attachWnd(new TestWnd());
        const existing = addExistingTab(wnd, new TestElementTab("topic-id"));
        authoringBusy = true;
        const {openElement} = await import("./openElement");

        assert.equal(await openElement(options()), undefined);
        assert.equal(wnd.added.length, 0);
        assert.equal(wnd.switched.length, 0);
        assert.equal(wnd.splitCalls.length, 0);
        assert.ok(existing);
    });

    it("prepares the exact reusable tab before a creating command may start", async () => {
        const wnd = attachWnd(new TestWnd());
        const reusable = addExistingTab(wnd, new TestElementTab("draft"));
        reusable.headElement?.classList.add("item--unupdate");
        window.siyuan.config.fileTree.openFilesUseCurrentTab = true;
        const {prepareNativeElementOpen} = await import("./openElement");

        assert.deepEqual(await prepareNativeElementOpen("ordinary"), {
            allowed: true,
            replacementTabId: reusable.id,
        });

        transitionAllowed = false;
        assert.deepEqual(await prepareNativeElementOpen("ordinary"), {allowed: false});
    });
});
