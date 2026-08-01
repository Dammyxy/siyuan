import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {deferred, TestDocument, TestElement} from "./testDom";
import type {ElementChangeResult} from "./types";
import type {ElementDetailView} from "./types";
import type {
    TopicFormattingAction,
    TopicFormattingState,
    TopicHtmlEditorAdapter,
    TopicHtmlEditorFactory,
} from "./TopicHtmlSurface";
import {parse5TopicDom} from "./testTopicDom";
import type {AssetImportResult} from "./assetStore";


const stubPaths = [
    require.resolve("./api"),
    require.resolve("../protyle/render/mathRender"),
    require.resolve("../protyle/util/compatibility"),
    require.resolve("../util/fetch"),
    require.resolve("../menus/Menu"),
];
const originalModules = stubPaths.map((modulePath) => require.cache[modulePath]);
let TopicHtmlSurface: typeof import("./TopicHtmlSurface").TopicHtmlSurface;
let titleSaves: Array<{elementId: string; revision: string; title: string}>;
let materialSaves: Array<{elementId: string; revision: string; html: string}>;
let titleResults: ElementChangeResult[];
let materialResults: ElementChangeResult[];
let getElementResult: import("./types").ElementDetailResult;
let createTopicResults: import("./types").CreateHTMLTopicResult[];
let readClipboardCalls: number;
let readClipboardResult: Partial<IClipboardData> & {hasHTML?: boolean};
let fetchPostCalls: Array<{url: string; data: unknown}>;
let fetchPostImpl: (url: string, data: unknown, cb?: (response: IWebSocketData) => void) => void;
let menuInstances: TestMenu[];

const acceptedChange = (field: "title" | "material", canonicalValue: string, revision: string): ElementChangeResult => ({
    ok: true,
    change: {
        kind: field === "title" ? "RenameElement" : "SaveTopicHTML",
        elementId: "topic-id",
        changedField: field,
        canonicalValue,
        revision,
        changed: true,
        changeAccepted: true,
    },
});

after(() => {
    stubPaths.forEach((modulePath, index) => {
        if (originalModules[index]) require.cache[modulePath] = originalModules[index];
        else delete require.cache[modulePath];
    });
});

const detail = (overrides: Partial<ElementDetailView> = {}): ElementDetailView => ({
    elementId: "topic-id",
    rootElementId: "topic-id",
    storageKind: "rootDocument",
    type: "topic",
    title: "",
    titleRevision: "rev-title",
    sourceMode: "html",
    supportStatus: "supported",
    topicMaterial: {
        kind: "html",
        html: "",
        cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
        revision: "rev-material",
    },
    ...overrides,
});

class FakeEditor implements TopicHtmlEditorAdapter {
    public mountGate = deferred<void>();
    public mounted = false;
    public destroyed = false;
    public focused = false;
    public formattingActions: TopicFormattingAction[] = [];
    public insertedHTML: string[] = [];
    public imageFiles: File[][] = [];
    public imageImportResult?: AssetImportResult;
    public replacedHTML: string[] = [];
    public interactive: boolean[] = [];
    public selectionTrace: string[] = [];
    public bookmark: unknown = "bookmark-1";
    public formattingState: TopicFormattingState = {
        undoEnabled: false,
        redoEnabled: false,
        boldActive: false,
        italicActive: false,
        bulletListActive: false,
        orderedListActive: false,
        blockquoteActive: false,
        codeActive: false,
        linkActive: false,
        tableActive: false,
        blockFormat: "p",
    };
    public getAuthoritativeHTML?: () => import("./TopicHtmlSurface").TopicEditorSnapshotResult;

    public async mount(): Promise<void> {
        await this.mountGate.promise;
        this.mounted = true;
    }

    public destroy(): void {
        this.destroyed = true;
    }

    public focus(): void {
        this.focused = true;
    }

    public execFormatting(action: TopicFormattingAction): void {
        this.formattingActions.push(action);
    }

    public queryFormatting(): TopicFormattingState {
        return this.formattingState;
    }

    public insertHTML(html: string): void {
        this.insertedHTML.push(html);
    }

    public async insertImageFiles(files: File[]): Promise<AssetImportResult> {
        this.imageFiles.push(files);
        if (this.imageImportResult) return this.imageImportResult;
        return {ok: true, references: files.map((file) => `assets/${file.name}`), selection: {}};
    }

    public replaceHTML(html: string): void {
        this.replacedHTML.push(html);
    }

    public setInteractive(enabled: boolean): void {
        this.interactive.push(enabled);
    }

    public captureSelectionBookmark(): unknown {
        this.selectionTrace.push("capture");
        return this.bookmark;
    }

    public restoreSelectionBookmark(bookmark: unknown): boolean {
        this.selectionTrace.push(`restore:${String(bookmark)}`);
        return bookmark === this.bookmark;
    }
}

class TestMenu {
    public readonly appended: Array<TestMenuItem | TestElement> = [];
    public popupPosition?: {x: number; y: number};
    public removed = false;

    constructor() {
        menuInstances.push(this);
    }

    public append(element: TestMenuItem | TestElement) {
        this.appended.push(element);
    }

    public popup(position: {x: number; y: number}) {
        this.popupPosition = position;
    }

    public remove() {
        this.removed = true;
    }
}

class TestMenuItem {
    public readonly element = this;

    constructor(public readonly options: {
        id?: string;
        label?: string;
        icon?: string;
        disabled?: boolean;
        click?: () => void | Promise<void>;
    }) {}

    public click() {
        if (!this.options.disabled) {
            return this.options.click?.();
        }
        return undefined;
    }
}

before(async () => {
    require.cache[stubPaths[0]] = {exports: {
        renameElement: async (elementId: string, revision: string, title: string) => {
            titleSaves.push({elementId, revision, title});
            return titleResults.shift() || acceptedChange("title", title, "rev-title-next");
        },
        saveTopicHTML: async (elementId: string, revision: string, html: string) => {
            materialSaves.push({elementId, revision, html});
            return materialResults.shift() || acceptedChange("material", html, "rev-material-next");
        },
        getElement: async () => getElementResult,
        createHTMLTopic: async () => createTopicResults.shift() || {ok: true, elementId: "topic-new", scheduledEventId: "event-new"},
    }} as NodeModule;
    require.cache[stubPaths[1]] = {exports: {mathRender() {}}} as NodeModule;
    require.cache[stubPaths[2]] = {exports: {
        readClipboard: async () => {
            readClipboardCalls++;
            return readClipboardResult;
        },
    }} as NodeModule;
    require.cache[stubPaths[3]] = {exports: {
        fetchPost: (url: string, data: unknown, cb?: (response: IWebSocketData) => void) => fetchPostImpl(url, data, cb),
    }} as NodeModule;
    require.cache[stubPaths[4]] = {exports: {Menu: TestMenu, MenuItem: TestMenuItem}} as NodeModule;
    ({TopicHtmlSurface} = await import("./TopicHtmlSurface"));
});

const createSurface = (factory: TopicHtmlEditorFactory, options: {
    debounceMs?: number;
    onTransitionReadyChange?: (ready: boolean) => void;
    onSaveAsNew?: (elementId: string) => void;
} = {}) => {
    const document = new TestDocument();
    (globalThis as unknown as {document: Document}).document = document as unknown as Document;
    const container = document.createElement("div") as unknown as HTMLElement;
    const surface = new TopicHtmlSurface({
        container,
        createEditor: factory,
        debounceMs: options.debounceMs,
        topicDomParser: parse5TopicDom,
        onSaveAsNew: options.onSaveAsNew,
        onTransitionReadyChange: options.onTransitionReadyChange,
        language: (key) => ({
            symemoTopicBodyPlaceholder: "Write material...",
            symemoTopicConflict: "Conflict",
            symemoTopicFailed: "Failed",
            symemoTopicPending: "Pending",
            symemoTopicReload: "Reload",
            symemoTopicRetry: "Retry",
            symemoTopicSaveAsNew: "Save as new",
            symemoTopicSaving: "Saving",
            symemoTopicClean: "Saved",
            symemoImageUploadFailed: "Image upload failed.",
            untitled: "Untitled",
        })[key] || "",
    });
    return {container: container as unknown as TestElement, surface};
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Topic HTML authoring surface", () => {
    beforeEach(() => {
        titleSaves = [];
        materialSaves = [];
        titleResults = [];
        materialResults = [];
        getElementResult = {ok: true, element: detail()};
        createTopicResults = [];
        readClipboardCalls = 0;
        readClipboardResult = {textHTML: "", textPlain: "", hasHTML: false};
        fetchPostCalls = [];
        fetchPostImpl = (url, data, cb) => {
            fetchPostCalls.push({url, data});
            cb?.({code: 0, msg: "", data: {html: ""}} as IWebSocketData);
        };
        menuInstances = [];
    });

    it("renders the native empty Topic shell before importing the editor adapter", async () => {
        let editorCreatedAfterShell = false;
        const editor = new FakeEditor();
        const {container, surface} = createSurface((context) => {
            editorCreatedAfterShell = Boolean(
                context.host.classList.contains("symemo-topic-html-surface__editor") &&
                context.surface.lifecycleRegistered,
            );
            return editor;
        });

        const mounted = surface.mount(detail());
        assert.equal(surface.lifecycleRegistered, true);
        assert.equal(container.querySelector(".symemo-topic-html-surface__title")?.getAttribute("data-placeholder"), "Untitled");
        assert.equal(container.querySelector(".symemo-topic-html-surface__editor")?.getAttribute("data-placeholder"), "Write material...");
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Saved");
        assert.equal(container.querySelector('[data-command="undo"]')?.getAttribute("disabled"), "disabled");
        assert.equal(container.querySelector('[data-command="bold"] use')?.getAttribute("href"), "#iconBold");
        assert.equal(
            container.querySelector('[data-command="bold"] svg')?.namespaceURI,
            "http://www.w3.org/2000/svg",
        );
        assert.equal(editorCreatedAfterShell, true);

        editor.mountGate.resolve();
        await mounted;
        assert.equal(editor.mounted, true);
    });

    it("routes pasted image files through the editor image seam", async () => {
        const editor = new FakeEditor();
        const {container, surface} = createSurface(() => editor);
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;
        let prevented = false;
        container.querySelector(".symemo-topic-html-surface__editor")?.dispatch("paste", {
            clipboardData: {files: [new File(["1"], "screenshot.png", {type: "image/png"})]},
            preventDefault: () => { prevented = true; },
        });
        await wait(0);
        assert.equal(prevented, true);
        assert.deepEqual(editor.imageFiles.map((files) => files.map((file) => file.name)), [["screenshot.png"]]);
    });

    it("exposes a native image picker that uses the same ordered file seam", async () => {
        const editor = new FakeEditor();
        const {container, surface} = createSurface(() => editor);
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;
        const imageButton = container.querySelector('[data-command="image"]');
        assert.ok(imageButton);
        imageButton.dispatch("click");
        const picker = container.querySelector('input[type="file"]');
        assert.ok(picker);
        picker.dispatch("change", {
            target: {files: [
                new File(["1"], "first.png", {type: "image/png"}),
                new File(["2"], "second.png", {type: "image/png"}),
            ]},
        });
        await wait(0);
        assert.deepEqual(editor.imageFiles.map((files) => files.map((file) => file.name)), [["first.png", "second.png"]]);
    });

    it("reports image upload failures from paste and the native picker", async () => {
        const editor = new FakeEditor();
        editor.imageImportResult = {ok: false, kind: "response", selection: {}};
        const {container, surface} = createSurface(() => editor);
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;

        container.querySelector(".symemo-topic-html-surface__editor")?.dispatch("paste", {
            clipboardData: {files: [new File(["1"], "failed-paste.png", {type: "image/png"})]},
            preventDefault() {},
        });
        await wait(0);
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent,
            "Image upload failed.");

        const imageButton = container.querySelector('[data-command="image"]');
        assert.ok(imageButton);
        imageButton.dispatch("click");
        const picker = container.querySelector('input[type="file"]');
        assert.ok(picker);
        picker.dispatch("change", {target: {files: [new File(["1"], "failed-picker.png", {type: "image/png"})]}});
        await wait(0);
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent,
            "Image upload failed.");
    });

    it("destroys a late editor after a cancelled mount and retries cleanly on the next mount", async () => {
        const first = new FakeEditor();
        const second = new FakeEditor();
        const editors = [first, second];
        const {surface} = createSurface(() => editors.shift() as FakeEditor);

        const firstMount = surface.mount(detail({elementId: "first"}));
        surface.destroy();
        first.mountGate.resolve();
        await firstMount;
        assert.equal(first.destroyed, true);

        const secondMount = surface.mount(detail({elementId: "second"}));
        second.mountGate.resolve();
        await secondMount;
        assert.equal(second.mounted, true);
        assert.equal(second.destroyed, false);

        surface.focus();
        assert.equal(second.focused, true);
    });

    it("destroys and forgets an editor whose mount rejects", async () => {
        const editor = new FakeEditor();
        editor.mount = async () => {
            throw new Error("editor mount failed");
        };
        const {surface} = createSurface(() => editor);

        await assert.rejects(surface.mount(detail()), /editor mount failed/);

        assert.equal(editor.destroyed, true);
        surface.focus();
        assert.equal(editor.focused, false);
    });

    it("normalizes title edits, ignores IME input, and saves through the shared authoring session", async () => {
        titleResults.push(acceptedChange("title", "Canonical Title", "rev-title-2"));
        const editor = new FakeEditor();
        const readiness: boolean[] = [];
        const {container, surface} = createSurface(() => editor, {
            debounceMs: 5,
            onTransitionReadyChange: (ready) => readiness.push(ready),
        });

        const mounted = surface.mount(detail({title: "Original"}));
        editor.mountGate.resolve();
        await mounted;
        const title = container.querySelector(".symemo-topic-html-surface__title") as TestElement;

        title.dispatch("compositionstart");
        title.textContent = " Composing ";
        title.dispatch("input");
        await wait(10);
        assert.equal(titleSaves.length, 0);

        title.textContent = "  Canonical Title\n\t";
        title.dispatch("compositionend");
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Pending");
        assert.equal(title.classList.contains("symemo-topic-html-surface__title--invalid"), false);

        await wait(20);
        assert.deepEqual(titleSaves, [{elementId: "topic-id", revision: "rev-title", title: "Canonical Title"}]);
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Saved");
        assert.equal(title.textContent, "Canonical Title");
        assert.deepEqual(readiness, [true, false, true]);
    });

    it("validates title controls and length before saving", async () => {
        const editor = new FakeEditor();
        const {container, surface} = createSurface(() => editor, {debounceMs: 5});
        const mounted = surface.mount(detail({title: "Original"}));
        editor.mountGate.resolve();
        await mounted;
        const title = container.querySelector(".symemo-topic-html-surface__title") as TestElement;

        title.textContent = "A".repeat(513);
        title.dispatch("input");
        await wait(10);

        assert.equal(titleSaves.length, 0);
        assert.equal(title.classList.contains("symemo-topic-html-surface__title--invalid"), true);
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Failed");
        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: false, reason: "save-failed"});
    });

    it("pastes only the plain-text clipboard flavor into the title", async () => {
        const editor = new FakeEditor();
        const {container, surface} = createSurface(() => editor);
        const mounted = surface.mount(detail({title: "Original"}));
        editor.mountGate.resolve();
        await mounted;
        const title = container.querySelector(".symemo-topic-html-surface__title") as TestElement;
        const commands: Array<{command: string; value: string}> = [];
        (document as Document & {execCommand(command: string, showUI: boolean, value: string): boolean}).execCommand =
            (command, _showUI, value) => {
                commands.push({command, value});
                return true;
            };
        let prevented = 0;
        let stopped = 0;

        title.dispatch("paste", {
            clipboardData: {
                getData(type: string) {
                    if (type === "text/html") return "<strong>Rich title</strong>";
                    if (type === "text/plain") return "Plain title";
                    return "";
                },
            },
            preventDefault() { prevented++; },
            stopPropagation() { stopped++; },
        });

        assert.deepEqual(commands, [{command: "insertText", value: "Plain title"}]);
        assert.equal(prevented, 1);
        assert.equal(stopped, 1);
    });

    it("autosaves body edits, exposes status actions, and preserves toolbar commands", async () => {
        materialResults.push(
            {ok: false, failure: {kind: "failed", errorCode: "request", retryable: true, acceptanceUnknown: true}},
            acceptedChange("material", "<p>Edited</p>", "rev-material-2"),
        );
        const editor = new FakeEditor();
        let dirty!: (html: string) => void;
        const {container, surface} = createSurface((context) => {
            dirty = context.onDirty;
            return editor;
        }, {debounceMs: 5});
        const mounted = surface.mount(detail({topicMaterial: {
            kind: "html",
            html: "<p>Initial</p>",
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            revision: "rev-material",
        }}));
        editor.mountGate.resolve();
        await mounted;

        const bold = container.querySelector('[data-command="bold"]') as TestElement;
        bold.dispatch("click");
        assert.deepEqual(editor.formattingActions, [{command: "bold"}]);

        dirty("<p>Edited</p>");
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Pending");
        await wait(20);
        assert.deepEqual(materialSaves, [{elementId: "topic-id", revision: "rev-material", html: "<p>Edited</p>"}]);
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Failed");

        surface.setWindowBarrier(true);
        (container.querySelector('[data-action="retry"]') as TestElement).dispatch("click");
        await wait(20);
        assert.equal(materialSaves.length, 1);

        surface.setWindowBarrier(false);
        (container.querySelector('[data-action="retry"]') as TestElement).dispatch("click");
        await wait(20);
        assert.equal(materialSaves.length, 2);
        assert.equal(materialSaves[1].html, "<p>Edited</p>");
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Saved");
    });

    it("reflects formatting state and validates heading, link, and table controls", async () => {
        const editor = new FakeEditor();
        editor.formattingState = {
            ...editor.formattingState,
            undoEnabled: true,
            boldActive: true,
            linkActive: true,
            blockFormat: "h3",
        };
        let refreshFormatting!: () => void;
        const {container, surface} = createSurface((context) => {
            refreshFormatting = context.onCommandStateChange;
            return editor;
        });
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;

        const undo = container.querySelector('[data-command="undo"]') as TestElement;
        const bold = container.querySelector('[data-command="bold"]') as TestElement;
        const unlink = container.querySelector('[data-command="unlink"]') as TestElement;
        const heading = container.querySelector('[data-command="heading"]') as TestElement;
        assert.equal(undo.getAttribute("disabled"), null);
        assert.equal(bold.classList.contains("block__icon--active"), true);
        assert.equal(unlink.getAttribute("disabled"), null);
        assert.equal(heading.value, "h3");

        editor.formattingState = {...editor.formattingState, undoEnabled: false, boldActive: false, linkActive: false, blockFormat: "p"};
        refreshFormatting();
        assert.equal(undo.getAttribute("disabled"), "disabled");
        assert.equal(bold.classList.contains("block__icon--active"), false);
        assert.equal(unlink.getAttribute("disabled"), "disabled");
        assert.equal(heading.value, "p");

        heading.value = "h4";
        heading.dispatch("change");
        assert.deepEqual(editor.formattingActions.at(-1), {command: "heading", value: "h4"});

        (container.querySelector('[data-command="link"]') as TestElement).dispatch("click");
        const linkForm = menuInstances.at(-1)?.appended[0] as TestElement;
        const href = linkForm.querySelector('[data-field="href"]') as TestElement;
        const linkTitle = linkForm.querySelector('[data-field="title"]') as TestElement;
        href.value = "javascript:alert(1)";
        linkForm.querySelector('[data-action="confirm"]')?.dispatch("click");
        assert.equal(href.getAttribute("aria-invalid"), "true");
        assert.notEqual(editor.formattingActions.at(-1)?.command, "link");

        href.value = "https://example.com/article";
        linkTitle.value = "Example";
        linkForm.querySelector('[data-action="confirm"]')?.dispatch("click");
        assert.deepEqual(editor.formattingActions.at(-1), {
            command: "link",
            href: "https://example.com/article",
            title: "Example",
        });

        (container.querySelector('[data-command="table"]') as TestElement).dispatch("click");
        const tableForm = menuInstances.at(-1)?.appended[0] as TestElement;
        const rows = tableForm.querySelector('[data-field="rows"]') as TestElement;
        const columns = tableForm.querySelector('[data-field="columns"]') as TestElement;
        rows.value = "21";
        columns.value = "2";
        tableForm.querySelector('[data-action="confirm"]')?.dispatch("click");
        assert.equal(rows.getAttribute("aria-invalid"), "true");

        rows.value = "3";
        columns.value = "4";
        tableForm.querySelector('[data-action="confirm"]')?.dispatch("click");
        assert.deepEqual(editor.formattingActions.at(-1), {command: "table", rows: 3, columns: 4});
    });

    it("cancels a toolbar menu command when a window barrier starts", async () => {
        const editor = new FakeEditor();
        const {container, surface} = createSurface(() => editor);
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;

        (container.querySelector('[data-command="link"]') as TestElement).dispatch("click");
        const menu = menuInstances.at(-1)!;
        const form = menu.appended[0] as TestElement;
        (form.querySelector('[data-field="href"]') as TestElement).value = "https://example.com";
        surface.setWindowBarrier(true);
        form.querySelector('[data-action="confirm"]')?.dispatch("click");

        assert.deepEqual(editor.formattingActions, []);
        assert.equal(menu.removed, true);
    });

    it("reloads both fields from authority through the session conflict barrier", async () => {
        titleResults.push({ok: false, failure: {
            kind: "conflict",
            elementId: "topic-id",
            changedField: "title",
            currentRevision: "rev-title-remote",
        }});
        const editor = new FakeEditor();
        const {container, surface} = createSurface(() => editor, {
            debounceMs: 5,
        });
        const mounted = surface.mount(detail({title: "Original", topicMaterial: {
            kind: "html",
            html: "<p>Local body</p>",
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            revision: "rev-material",
        }}));
        editor.mountGate.resolve();
        await mounted;
        const title = container.querySelector(".symemo-topic-html-surface__title") as TestElement;

        title.textContent = "Local title";
        title.dispatch("input");
        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: false, reason: "conflict"});

        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Conflict");
        getElementResult = {ok: true, element: detail({
            title: "Remote title",
            titleRevision: "rev-title-remote",
            topicMaterial: {
                kind: "html",
                html: "<p>Remote body</p>",
                cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
                revision: "rev-material-remote",
            },
        })};
        (container.querySelector('[data-action="reload"]') as TestElement).dispatch("click");
        await wait(0);

        assert.deepEqual(editor.replacedHTML, ["<p>Remote body</p>"]);
        assert.equal(title.textContent, "Remote title");
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Saved");
        assert.deepEqual(editor.interactive, [false, true]);
    });

    it("preserves the complete conflicted snapshot as one accepted new Topic", async () => {
        materialResults.push({ok: false, failure: {
            kind: "conflict",
            elementId: "topic-id",
            changedField: "material",
            currentRevision: "rev-material-remote",
        }});
        const editor = new FakeEditor();
        let dirty!: (html: string) => void;
        let acceptedElementId = "";
        const {container, surface} = createSurface((context) => {
            dirty = context.onDirty;
            return editor;
        }, {
            debounceMs: 5,
            onSaveAsNew: (elementId) => {
                acceptedElementId = elementId;
            },
        });
        const mounted = surface.mount(detail({title: "Local title", topicMaterial: {
            kind: "html",
            html: "<p>Original body</p>",
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            revision: "rev-material",
        }}));
        editor.mountGate.resolve();
        await mounted;
        dirty("<p>Local body</p>");
        await wait(20);

        (container.querySelector('[data-action="save-as-new"]') as TestElement).dispatch("click");
        await wait(0);

        assert.equal(acceptedElementId, "topic-new");
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Saved");
        assert.deepEqual(editor.interactive, [false]);
        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: true});
    });

    it("opens a body context menu with exact paste availability and restores selection before HTML insertion", async () => {
        readClipboardResult = {
            hasHTML: true,
            textHTML: '<p onclick="x()">Safe <strong>HTML</strong></p><img src="file:///tmp/local.png"><img src="https://example.com/ok.png" srcset="bad">',
            textPlain: "plain fallback",
        };
        const editor = new FakeEditor();
        const {container, surface} = createSurface(() => editor);
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;
        const host = container.querySelector(".symemo-topic-html-surface__editor") as TestElement;
        let prevented = 0;

        host.dispatch("contextmenu", {
            clientX: 14,
            clientY: 28,
            preventDefault() { prevented++; },
        });
        await Promise.resolve();

        assert.equal(prevented, 1);
        assert.equal(readClipboardCalls, 1);
        assert.equal(menuInstances.length, 1);
        assert.deepEqual((menuInstances[0].appended as TestMenuItem[]).map((item) => ({
            id: item.options.id,
            label: item.options.label,
            disabled: item.options.disabled === true,
        })), [
            {id: "symemo-topic-paste", label: "Paste", disabled: false},
            {id: "symemo-topic-paste-plain", label: "Paste as plain text", disabled: false},
            {id: "symemo-topic-paste-html", label: "Paste as HTML", disabled: false},
        ]);
        assert.deepEqual(menuInstances[0].popupPosition, {x: 14, y: 28});

        await (menuInstances[0].appended[2] as TestMenuItem).click();
        assert.deepEqual(editor.selectionTrace, ["capture", "restore:bookmark-1"]);
        assert.deepEqual(editor.insertedHTML, ['<p>Safe <strong>HTML</strong></p><img src="https://example.com/ok.png">']);
    });

    it("intercepts keyboard paste without rereading the OS clipboard and converts plain Markdown once", async () => {
        const editor = new FakeEditor();
        const {container, surface} = createSurface(() => editor);
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;
        const host = container.querySelector(".symemo-topic-html-surface__editor") as TestElement;
        fetchPostImpl = (url, data, cb) => {
            fetchPostCalls.push({url, data});
            cb?.({code: 0, msg: "", data: {
                html: '<p id="LUTE_NODE_ID" updated="20260725123100">Inline <span class="language-math">x&amp;y</span></p><script>alert(1)</script>',
            }} as IWebSocketData);
        };
        let prevented = 0;

        host.dispatch("paste", {
            clipboardData: {
                types: ["text/plain"],
                getData(type: string) {
                    return type === "text/plain" ? "## Heading\n$x&y$" : "";
                },
            },
            preventDefault() { prevented++; },
        });
        await Promise.resolve();
        await Promise.resolve();

        assert.equal(prevented, 1);
        assert.equal(readClipboardCalls, 0);
        assert.deepEqual(fetchPostCalls, [{url: "/api/lute/md2html", data: {markdown: "## Heading\n$x&y$", mode: ""}}]);
        assert.deepEqual(editor.selectionTrace, ["capture", "restore:bookmark-1"]);
        assert.equal(
            editor.insertedHTML[0],
            '<p id="LUTE_NODE_ID">Inline <span data-content="x&amp;y" data-subtype="math" data-symemo-katex-trust="false" data-type="inline-math"></span></p>',
        );
    });

    it("does not fall back from an empty HTML flavor and disables Paste as HTML when the flavor is absent", async () => {
        readClipboardResult = {hasHTML: false, textHTML: "<p>ignored</p>", textPlain: "<literal>"};
        const editor = new FakeEditor();
        const {container, surface} = createSurface(() => editor);
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;
        const host = container.querySelector(".symemo-topic-html-surface__editor") as TestElement;

        host.dispatch("contextmenu", {preventDefault() {}});
        await Promise.resolve();

        assert.deepEqual((menuInstances[0].appended as TestMenuItem[]).map((item) => item.options.disabled === true), [false, false, true]);
        await (menuInstances[0].appended[2] as TestMenuItem).click();
        assert.deepEqual(editor.insertedHTML, []);

        readClipboardResult = {hasHTML: true, textHTML: "", textPlain: "fallback must not convert"};
        host.dispatch("contextmenu", {preventDefault() {}});
        await Promise.resolve();
        await (menuInstances[1].appended[0] as TestMenuItem).click();

        assert.deepEqual(fetchPostCalls, []);
        assert.deepEqual(editor.insertedHTML, []);
    });

    it("cancels a late Markdown paste when the surface epoch changes before conversion returns", async () => {
        const editor = new FakeEditor();
        let release!: (response: IWebSocketData) => void;
        fetchPostImpl = (url, data, cb) => {
            fetchPostCalls.push({url, data});
            release = cb!;
        };
        const {container, surface} = createSurface(() => editor);
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;
        const host = container.querySelector(".symemo-topic-html-surface__editor") as TestElement;

        host.dispatch("paste", {
            clipboardData: {
                types: ["text/plain"],
                getData: () => "# late",
            },
            preventDefault() {},
        });
        surface.destroy();
        release({code: 0, msg: "", data: {html: "<h1>late</h1>"}} as IWebSocketData);
        await Promise.resolve();

        assert.deepEqual(editor.insertedHTML, []);
    });

    it("blocks transitions on local serialization failure and retries from the live editor DOM", async () => {
        const editor = new FakeEditor();
        let failSerialization!: (reason: "identity-invalid" | "serialization-failed") => void;
        let snapshot: import("./TopicHtmlSurface").TopicEditorSnapshotResult = {ok: false, reason: "serialization-failed"};
        editor.getAuthoritativeHTML = () => snapshot;
        const {container, surface} = createSurface((context) => {
            failSerialization = context.onSerializationFailure;
            return editor;
        }, {debounceMs: 5});
        const mounted = surface.mount(detail());
        editor.mountGate.resolve();
        await mounted;

        failSerialization("serialization-failed");
        assert.equal(container.querySelector(".symemo-topic-html-surface__status")?.textContent, "Failed");
        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: false, reason: "save-failed"});

        snapshot = {ok: true, html: "<p>Recovered live DOM</p>"};
        (container.querySelector('[data-action="retry"]') as TestElement).dispatch("click");
        await wait(20);
        assert.deepEqual(materialSaves, [{
            elementId: "topic-id",
            revision: "rev-material",
            html: "<p>Recovered live DOM</p>",
        }]);
        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: true});
    });
});
