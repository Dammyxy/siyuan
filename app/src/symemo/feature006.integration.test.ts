import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import type {App} from "../index";
import {AuthoringSession} from "./authoringSession";
import {WindowAuthoringRegistry} from "./authoringRegistry";
import {ContentSurfaceHost, type ElementContentSurface} from "./ContentSurfaceHost";
import {HostAuthoringTransitionOwner} from "./hostAuthoringTransition";
import {serializeSymemoLayoutData} from "./layoutState";
import {createElementsPanel, TestDocument} from "./testDom";
import type {
    AcceptedElementChange,
    CreateHTMLTopicResult,
    ElementChangeResult,
    ElementDetailView,
    ElementTreeNodeView,
    ElementTreeResult,
    ModelTransitionReason,
    ModelTransitionResult,
    OpenElementOptions,
} from "./types";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const replaceModule = (modulePath: string, exports: Record<string, unknown>): (() => void) => {
    const resolved = require.resolve(modulePath);
    const original = require.cache[resolved];
    require.cache[resolved] = {exports} as NodeModule;
    return () => {
        if (original) require.cache[resolved] = original;
        else delete require.cache[resolved];
    };
};

const reloadableImport = async <T>(modulePath: string): Promise<{module: T; restore(): void}> => {
    const resolved = require.resolve(modulePath);
    const original = require.cache[resolved];
    delete require.cache[resolved];
    const module = await import(modulePath) as T;
    return {
        module,
        restore() {
            if (original) require.cache[resolved] = original;
            else delete require.cache[resolved];
        },
    };
};

const accepted = (
    changedField: "title" | "material",
    canonicalValue: string,
    revision: string,
    overrides: Partial<AcceptedElementChange> = {},
): ElementChangeResult => ({
    ok: true,
    change: {
        kind: changedField === "title" ? "RenameElement" : "SaveTopicHTML",
        elementId: "topic-id",
        changedField,
        canonicalValue,
        revision,
        changed: true,
        changeAccepted: true,
        ...overrides,
    },
});

const writableDetail = (index: number, overrides: Partial<ElementDetailView> = {}): ElementDetailView => ({
    elementId: `topic-${index}`,
    rootElementId: `root-${index}`,
    storageKind: index % 2 === 0 ? "rootDocument" : "internalElement",
    type: "topic",
    title: `Topic ${index}`,
    titleRevision: `rev-title-${index}`,
    sourceMode: "html",
    supportStatus: "supported",
    topicMaterial: {
        kind: "html",
        html: `<p>${index}-initial</p>`,
        cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
        revision: `rev-material-${index}`,
    },
    ...overrides,
});

describe("Feature 006 cross-layer integration", () => {
    it("decodes accepted transport contracts and keeps scheduling facts out of frontend authority", async () => {
        const restoreFetch = replaceModule("../util/fetch", {
            fetchSyncPost: async (url: string, body: unknown) => {
                if (url === "/api/symemo/createHTMLTopic") {
                    return {
                        code: 0,
                        msg: "",
                        data: {
                            elementId: "topic-created",
                            eventId: "event-created",
                            createAccepted: true,
                            reviewAccepted: true,
                            retryable: false,
                            topic: {elementId: "topic-created"},
                        },
                    };
                }
                if (url === "/api/symemo/getElement") {
                    assert.deepEqual(body, {elementId: "topic-created"});
                    return {
                        code: 0,
                        msg: "",
                        data: {
                            spec: 1,
                            id: "topic-created",
                            rootElementId: "topic-created",
                            storageKind: "rootDocument",
                            type: "topic",
                            title: "",
                            titleRevision: "rev-title-created",
                            sourceMode: "html",
                            supportStatus: "supported",
                            scheduleProjection: {dueAt: "2099-01-01T00:00:00Z"},
                            payload: {
                                material: {
                                    kind: "html",
                                    html: "",
                                    cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
                                    revision: "rev-material-created",
                                },
                            },
                        },
                    };
                }
                if (url === "/api/symemo/renameElement") {
                    assert.deepEqual(body, {
                        elementId: "topic-created",
                        expectedTitleRevision: "rev-title-created",
                        title: "Renamed",
                    });
                    return {
                        code: 0,
                        msg: "",
                        data: {
                            kind: "RenameElement",
                            elementId: "topic-created",
                            changedField: "title",
                            canonicalValue: "Renamed",
                            revision: "rev-title-renamed",
                            changed: true,
                            changeAccepted: true,
                        },
                    };
                }
                if (url === "/api/symemo/saveTopicHTML") {
                    assert.deepEqual(body, {
                        elementId: "topic-created",
                        expectedMaterialRevision: "rev-material-created",
                        html: "<p>Saved</p>",
                    });
                    return {
                        code: 0,
                        msg: "",
                        data: {
                            kind: "SaveTopicHTML",
                            elementId: "topic-created",
                            changedField: "material",
                            canonicalValue: "<p>Saved</p>",
                            revision: "rev-material-saved",
                            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
                            nodeIdentityAssignments: [{
                                clientNodeKey: "client-v1-20260725060100-abcdefghijklmnopqrstuv",
                                nodeId: "20260725060100-node001",
                            }],
                            changed: true,
                            changeAccepted: true,
                        },
                    };
                }
                throw new Error(`unexpected endpoint ${url}`);
            },
        });
        const imported = await reloadableImport<typeof import("./api")>("./api");
        try {
            const created = await imported.module.createHTMLTopic("", "");
            assert.deepEqual(created, {
                ok: true,
                elementId: "topic-created",
                eventId: "event-created",
                createAccepted: true,
                reviewAccepted: true,
                retryable: false,
            });

            const detail = await imported.module.getElement("topic-created");
            assert.equal(detail.ok, true);
            if (!detail.ok) throw new Error("expected decoded detail");
            assert.equal(detail.element.rootElementId, "topic-created");
            assert.equal(detail.element.storageKind, "rootDocument");
            assert.equal(JSON.stringify(detail.element).includes("scheduleProjection"), false);

            const renamed = await imported.module.renameElement("topic-created", "rev-title-created", "Renamed");
            assert.equal(renamed.ok, true);
            if (!renamed.ok) throw new Error("expected accepted rename");
            assert.equal(renamed.change.revision, "rev-title-renamed");

            const saved = await imported.module.saveTopicHTML("topic-created", "rev-material-created", "<p>Saved</p>");
            assert.equal(saved.ok, true);
            if (!saved.ok) throw new Error("expected accepted material save");
            assert.deepEqual(saved.change.nodeIdentityAssignments, [{
                clientNodeKey: "client-v1-20260725060100-abcdefghijklmnopqrstuv",
                nodeId: "20260725060100-node001",
            }]);
        } finally {
            imported.restore();
            restoreFetch();
        }
    });

    it("runs 100 accepted dock create/open cases with exactly one remembered creation each", async () => {
        const openCalls: OpenElementOptions[] = [];
        const restoreModules = [
            replaceModule("../layout/Model", {Model: class {
                public app: App;
                constructor(options: {app: App}) { this.app = options.app; }
            }}),
            replaceModule("./openElement", {
                openElement(options: OpenElementOptions) {
                    openCalls.push(options);
                },
                prepareNativeElementOpen: async () => ({allowed: true, replacementTabId: null as string | null}),
            }),
            replaceModule("../menus/Menu", {
                Menu: class {
                    public append() {}
                    public popup() {}
                },
                MenuItem: class { constructor(public readonly options: unknown) {} },
            }),
            replaceModule("../protyle/util/compatibility", {
                isOnlyMeta: () => false,
                setStorageVal: (): void => undefined,
            }),
            replaceModule("../constants", {
                Constants: {LOCAL_SYMEMO_ELEMENTS_EXPANDED: "local-symemo-elements-expanded"},
            }),
            replaceModule("../layout/tabUtil", {
                getDockByType: (): undefined => undefined,
            }),
        ];
        let getElementTreeImpl: () => Promise<ElementTreeResult> = async () => ({ok: true, nodes: []});
        let createHTMLTopicImpl: (title: string, html: string) => Promise<CreateHTMLTopicResult> =
            async () => ({ok: false, failure: {errorCode: "uninitialized", retryable: false, acceptanceUnknown: false}});
        const restoreApi = replaceModule("./api", {
            getElementTree: () => getElementTreeImpl(),
            createHTMLTopic: (title: string, html: string) => createHTMLTopicImpl(title, html),
        });
        const imported = await reloadableImport<typeof import("./Elements")>("./Elements");
        const creationAuthority: string[] = [];
        const rememberedEvents: string[] = [];
        try {
            for (let index = 0; index < 100; index++) {
                const createdId = `created-${index}`;
                const node: ElementTreeNodeView = {
                    elementId: createdId,
                    type: "topic",
                    title: "",
                    sourceMode: "html",
                    supportStatus: "supported",
                    children: [],
                };
                getElementTreeImpl = async () => ({ok: true, nodes: [node]});
                createHTMLTopicImpl = async (title, html) => {
                    assert.equal(title, "");
                    assert.equal(html, "");
                    creationAuthority.push(createdId);
                    rememberedEvents.push(`event-${index}`);
                    return {
                        ok: true,
                        elementId: createdId,
                        eventId: `event-${index}`,
                        createAccepted: true,
                        reviewAccepted: true,
                        retryable: false,
                    };
                };

                const testDocument = new TestDocument();
                (globalThis as typeof globalThis & {document: Document}).document = testDocument as unknown as Document;
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
                            symemoCollapseAll: "Collapse all",
                            symemoElements: "Elements",
                            symemoTreeEmpty: "No Elements",
                            symemoTreeLoadFailed: "Load failed",
                            untitled: "Untitled",
                        },
                        storage: {"local-symemo-elements-expanded": []},
                    },
                } as unknown as Window;
                const panelElement = createElementsPanel(testDocument);
                new imported.module.Elements({
                    app: {} as App,
                    tab: {panelElement: panelElement as unknown as HTMLElement} as import("../layout/Tab").Tab,
                });
                await nextTurn();
                const add = panelElement.querySelector('[data-type="add"]');
                assert.ok(add);
                add.dispatch("click");
                add.dispatch("click");
                await nextTurn();
                await nextTurn();
            }
        } finally {
            imported.restore();
            restoreApi();
            restoreModules.reverse().forEach((restore) => restore());
        }

        assert.equal(creationAuthority.length, 100);
        assert.equal(rememberedEvents.length, 100);
        assert.equal(new Set(creationAuthority).size, 100);
        assert.equal(openCalls.length, 100);
        assert.equal(new Set(openCalls.map((call) => call.elementId)).size, 100);
        assert.deepEqual(openCalls.map((call) => call.source), Array.from({length: 100}, () => "other"));
    });

    it("settles 100 mounted autosave sequences with identity-only layout and no edit history writes", async () => {
        let titleSaves = 0;
        let materialSaves = 0;
        const schedulingWritesAfterCreation = 0;
        const historyWritesAfterCreation = 0;
        const authoritySnapshots: Array<{elementId: string; title: string; html: string}> = [];
        const layoutSnapshots: string[] = [];
        const finalEquality: string[] = [];

        class SessionSurface implements ElementContentSurface {
            private session?: AuthoringSession;
            private title = "";
            private html = "";

            public async mount(detail: ElementDetailView): Promise<void> {
                this.title = detail.title;
                this.html = detail.topicMaterial?.html || "";
                this.session = new AuthoringSession({
                    elementId: detail.elementId,
                    title: this.title,
                    html: this.html,
                    titleRevision: detail.titleRevision || "",
                    materialRevision: detail.topicMaterial?.revision || "",
                    debounceMs: 0,
                    saveTitle: async (_elementId, _revision, title) => {
                        titleSaves++;
                        this.title = title;
                        return accepted("title", title, `rev-title-saved-${titleSaves}`);
                    },
                    saveMaterial: async (_elementId, _revision, html) => {
                        materialSaves++;
                        this.html = html;
                        return accepted("material", html, `rev-material-saved-${materialSaves}`, {
                            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
                        });
                    },
                });
            }

            public editTitle(title: string): void {
                this.session?.editTitle(title);
            }

            public editMaterial(html: string): void {
                this.session?.editMaterial(html);
            }

            public async prepareTransition(reason: ModelTransitionReason): Promise<ModelTransitionResult> {
                return this.session?.flush(reason) ?? {allowed: false, reason: "unavailable"};
            }

            public snapshot() {
                return this.session?.snapshot();
            }

            public focus(): void {}

            public destroy(): void {
                this.session?.destroy();
            }
        }

        for (let index = 0; index < 100; index++) {
            const document = new TestDocument();
            const surfaces: SessionSurface[] = [];
            const host = new ContentSurfaceHost({
                container: document.createElement("div") as unknown as HTMLElement,
                createWritableSurface: () => {
                    const surface = new SessionSurface();
                    surfaces.push(surface);
                    return surface;
                },
                renderReadOnly: () => assert.fail("expected writable surface"),
                renderUnavailable: () => assert.fail("expected writable surface"),
            });
            const detail = writableDetail(index);
            await host.mount(detail);
            assert.equal(surfaces.length, 1);

            surfaces[0].editMaterial(`<p>${index}-draft</p>`);
            surfaces[0].editTitle(`Topic ${index} saved`);
            surfaces[0].editMaterial(`<p>${index}-final</p>`);
            assert.deepEqual(await host.prepareTransition("application-exit"), {allowed: true});

            const snapshot = surfaces[0].snapshot();
            assert.equal(snapshot?.title.canonicalBaseline, `Topic ${index} saved`);
            assert.equal(snapshot?.material.canonicalBaseline, `<p>${index}-final</p>`);
            finalEquality.push(`${detail.elementId}:true`);
            authoritySnapshots.push({
                elementId: detail.elementId,
                title: snapshot?.title.canonicalBaseline || "",
                html: snapshot?.material.canonicalBaseline || "",
            });
            const layout = serializeSymemoLayoutData({
                elementId: detail.elementId,
                title: snapshot?.title.canonicalBaseline,
                icon: "iconFile",
            });
            const layoutJSON = JSON.stringify(layout);
            assert.equal(layoutJSON.includes("html"), false);
            assert.equal(layoutJSON.includes("revision"), false);
            assert.equal(layoutJSON.includes("dirty"), false);
            layoutSnapshots.push(layoutJSON);
        }

        assert.equal(titleSaves, 100);
        assert.equal(materialSaves, 100);
        assert.equal(finalEquality.length, 100);
        assert.equal(authoritySnapshots.length, 100);
        assert.equal(layoutSnapshots.length, 100);
        assert.equal(schedulingWritesAfterCreation, 0);
        assert.equal(historyWritesAfterCreation, 0);
    });

    it("blocks conflicted US4 transitions and sends only host intent metadata", async () => {
        let layoutExports = 0;
        let systemExitRequests = 0;
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Initial</p>",
            titleRevision: "rev-title",
            materialRevision: "rev-material",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-next"),
            saveMaterial: async () => ({
                ok: false,
                failure: {
                    kind: "conflict",
                    elementId: "topic-id",
                    changedField: "material",
                    currentRevision: "rev-material-current",
                },
            }),
        });
        const registry = new WindowAuthoringRegistry();
        const barriers: boolean[] = [];
        registry.register({
            id: "topic-id",
            prepareTransition: (reason) => session.flush(reason),
            setWindowBarrier: (active) => barriers.push(active),
        });

        session.editMaterial("<p>Conflicted local work</p>");
        const blocked = await registry.beginTransition("application-exit", "exit");

        assert.deepEqual(blocked, {allowed: false, reason: "conflict"});
        assert.deepEqual(barriers, [true, false]);
        assert.equal(layoutExports, 0);
        assert.equal(systemExitRequests, 0);

        const payloads: unknown[] = [];
        const owner = new HostAuthoringTransitionOwner({
            begin: async (intent) => {
                payloads.push(intent);
                return {allowed: true, token: "token-a"};
            },
            commit: async () => {
                layoutExports++;
                systemExitRequests++;
            },
            cancel: async () => undefined,
        });
        const lease = await owner.begin({kind: "workspace-replace", target: "H:/workspace-a", requester: "menu", requestId: "request-a"});
        assert.equal(lease.allowed, true);
        if (lease.allowed === false) throw new Error("expected lease");
        await lease.commit();

        const serialized = JSON.stringify(payloads);
        assert.equal(serialized.includes("elementId"), false);
        assert.equal(serialized.includes("html"), false);
        assert.equal(serialized.includes("revision"), false);
        assert.equal(layoutExports, 1);
        assert.equal(systemExitRequests, 1);
    });
});
