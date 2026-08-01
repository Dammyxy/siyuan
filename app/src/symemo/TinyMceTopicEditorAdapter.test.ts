import * as assert from "node:assert/strict";
import test from "node:test";
import {TinyMceTopicEditorAdapter, TinyMceCoreLike, TinyMceEditorLike, TinyMceTopicEditorLoader} from "./TinyMceTopicEditorAdapter";
import {parse5TopicDom} from "./testTopicDom";

class FakeHost {
    public innerHTML = "";
    public isConnected = true;
    public readonly attributes = new Map<string, string>();
    public readonly listeners: string[] = [];
    public readonly listenerCallbacks = new Map<string, (event: any) => void>();
    public readonly ownerDocument = {caretRangeFromPoint: (): Range | undefined => undefined};

    public setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
    }

    public removeAttribute(name: string) {
        this.attributes.delete(name);
    }

    public addEventListener(type: string, callback: (event: any) => void) {
        this.listeners.push("add:" + type);
        this.listenerCallbacks.set(type, callback);
    }

    public removeEventListener(type: string) {
        this.listeners.push("remove:" + type);
        this.listenerCallbacks.delete(type);
    }

    public querySelectorAll(): HTMLElement[] {
        return [];
    }

    public contains() {
        return true;
    }

    public dispatch(type: string, event: any) {
        this.listenerCallbacks.get(type)?.(event);
    }
}

class FakeEditor implements TinyMceEditorLike {
    public content = "";
    public removed = false;
    public readonly handlers = new Map<string, (event: any) => void>();
    public readonly transactions: string[] = [];
    public readonly ignored: string[] = [];
    public readonly commands: Array<{command: string; ui?: boolean; value?: unknown}> = [];
    public readonly commandStates = new Map<string, boolean>();
    public blockFormat = "p";
    public selectionNode: {closest(selector: string): unknown} = {closest: () => null};
    public codeMatched = false;
    public selectionHTML = "";
    public readonly selection = {
        getContent: () => this.selectionHTML,
        setContent: (html: string) => {
            this.selectionHTML = html;
        },
        getNode: () => this.selectionNode as unknown as Node,
    };
    public readonly formatter = {
        match: (format: string) => format === "code" && this.codeMatched,
    };
    public readonly undoManager = {
        transact: (callback: () => void) => {
            this.transactions.push("transact");
            callback();
        },
        ignore: (callback: () => void) => {
            this.ignored.push("ignore");
            callback();
        },
    };

    public getContent() {
        return this.content;
    }

    public setContent(html: string) {
        this.content = html;
    }

    public insertContent(html: string) {
        this.content += html;
    }

    public execCommand(command: string, ui?: boolean, value?: unknown) {
        this.commands.push({command, ui, value});
    }

    public queryCommandState(command: string) {
        return this.commandStates.get(command) ?? false;
    }

    public queryCommandValue(command: string) {
        return command === "FormatBlock" ? this.blockFormat : "";
    }

    public remove() {
        this.removed = true;
    }

    public on(name: string, callback: (event: any) => void) {
        this.handlers.set(name, callback);
    }

    public emit(name: string, event: any = {}) {
        this.handlers.get(name)?.(event);
    }
}

const createLoader = (events: string[], editor = new FakeEditor()): {loader: TinyMceTopicEditorLoader; core: TinyMceCoreLike; editor: FakeEditor} => {
    const core: TinyMceCoreLike = {
        EditorManager: {
            editors: [editor],
            remove(removed: TinyMceEditorLike) {
                events.push("remove");
                removed.remove?.();
            },
        },
        async init(options: Record<string, unknown>) {
            events.push("init");
            assert.equal(options.inline, true);
            assert.equal(options.theme, false);
            assert.equal(options.icons, "default");
            assert.equal(options.menubar, false);
            assert.equal(options.toolbar, false);
            assert.equal(options.contextmenu, false);
            assert.equal(options.promotion, false);
            assert.equal(options.branding, false);
            assert.equal(options.content_css, false);
            assert.equal(options.paste_data_images, false);
            assert.equal(options.automatic_uploads, false);
            assert.equal(options.convert_urls, false);
            assert.equal(options.relative_urls, false);
            assert.equal(options.browser_spellcheck, true);
            assert.equal(options.plugins, "lists link table");
            assert.equal(options.paste_block_drop, false);
            assert.match(String(options.valid_elements), /data-symemo-client-node-key/);
            assert.match(String(options.valid_elements), /ins/);
            assert.match(String(options.valid_elements), /style/);
            assert.doesNotMatch(String(options.valid_elements), /em\[[^\]]*\]\/i\[/);
            assert.doesNotMatch(String(options.valid_elements), /strong\[[^\]]*\]\/b\[/);
            (options.setup as (editor: TinyMceEditorLike) => void)(editor);
            return [editor];
        },
    };
    return {
        core,
        editor,
        loader: {
            async loadCore() {
                events.push("core");
                return core;
            },
            async loadRegistrationModules() {
                events.push("registration");
            },
        },
    };
};

test("loads TinyMCE core before registrations and publishes only after inert init completes", async () => {
    const events: string[] = [];
    const {loader, editor} = createLoader(events);
    const host = new FakeHost();
    const dirty: string[] = [];
    const clientKeys = ["ck-1", "ck-2"];
    const adapter = new TinyMceTopicEditorAdapter({
        host: host as unknown as HTMLElement,
        initialHTML: '<p>Hello</p><div data-type="NodeMathBlock" data-subtype="math" data-content="x"><span>rendered</span></div>',
        loader,
        createClientKey: () => clientKeys.shift() ?? "ck-fallback",
        renderFormula: () => events.push("render"),
        onDirty: (html) => dirty.push(html),
        topicDomParser: parse5TopicDom,
    });

    assert.equal(host.attributes.get("contenteditable"), undefined);
    assert.equal(await adapter.mount(), editor);
    assert.deepEqual(events, ["core", "registration", "init", "render"]);
    assert.equal(host.attributes.get("contenteditable"), "true");
    assert.match(editor.content, /data-symemo-client-node-key="ck-1"/);
    assert.doesNotMatch(editor.content, /rendered/);

    editor.content = '<p data-mce-selected="1" data-symemo-client-node-key="ck-1">Saved</p>';
    editor.emit("input");
    assert.equal(dirty.at(-1), '<p data-symemo-client-node-key="ck-1">Saved</p>');
});

test("normalizes BeforeAddUndo snapshots before TinyMCE records undo", async () => {
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "",
        loader,
        createClientKey: () => "ck-undo",
        topicDomParser: parse5TopicDom,
    });

    await adapter.mount();
    const event = {level: {content: '<p>Undo</p><span data-type="inline-math" data-subtype="math" data-content="x"><b>rendered</b></span>'}};
    editor.emit("BeforeAddUndo", event);
    assert.equal(
        event.level.content,
        '<p data-symemo-client-node-key="ck-undo">Undo</p><span data-content="x" data-subtype="math" data-symemo-katex-trust="false" data-type="inline-math"></span>',
    );
});

test("maps toolbar formatting to TinyMCE core commands without wrapping undo or redo in transactions", async () => {
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "<p>Body</p>",
        loader,
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();

    adapter.execFormatting({command: "code"});
    adapter.execFormatting({command: "undo"});
    adapter.execFormatting({command: "redo"});

    assert.deepEqual(editor.commands, [
        {command: "mceToggleFormat", ui: false, value: "code"},
        {command: "Undo", ui: false, value: undefined},
        {command: "Redo", ui: false, value: undefined},
    ]);
    assert.deepEqual(editor.transactions, ["transact"]);
});

test("derives code, link, and table state from the formatter and selected DOM", async () => {
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "<p>Body</p>",
        loader,
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    editor.codeMatched = true;
    editor.selectionNode = {
        closest: (selector) => selector === "a[href]" || selector === "table" ? {} : null,
    };

    const state = adapter.queryFormatting();

    assert.equal(state.codeActive, true);
    assert.equal(state.linkActive, true);
    assert.equal(state.tableActive, true);
});

test("late init after destroy removes the editor exactly once and never publishes it", async () => {
    const events: string[] = [];
    const editor = new FakeEditor();
    let releaseCore!: () => void;
    const coreReady = new Promise<void>((resolve) => {
        releaseCore = resolve;
    });
    const core: TinyMceCoreLike = {
        EditorManager: {
            remove(removed: TinyMceEditorLike) {
                events.push("remove");
                removed.remove?.();
            },
        },
        async init() {
            events.push("init");
            return [editor];
        },
    };
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "<p>late</p>",
        loader: {
            async loadCore() {
                await coreReady;
                return core;
            },
            async loadRegistrationModules() {
                events.push("registration");
            },
        },
        topicDomParser: parse5TopicDom,
    });

    const mount = adapter.mount();
    adapter.destroy();
    releaseCore();
    assert.equal(await mount, undefined);
    assert.deepEqual(events, []);
    assert.equal(adapter.mountedEditor, undefined);
    assert.equal(adapter.removalCount, 0);
});

test("copy and cut serialize through export clone and one undo transaction", async () => {
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "",
        loader,
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    editor.selectionHTML = '<p data-symemo-node-id="stable" data-symemo-client-node-key="ck" data-mce-selected="1">Cut <strong>me</strong></p>';

    const writes: Array<{html: string; text: string}> = [];
    await adapter.cutSelection(async (payload) => {
        writes.push(payload);
    });

    assert.deepEqual(writes, [{html: "<p>Cut <strong>me</strong></p>", text: "Cut me"}]);
    assert.equal(editor.selectionHTML, "");
    assert.deepEqual(editor.transactions, ["transact"]);
});

test("returns a typed authoritative snapshot and preserves safe author metadata", async () => {
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "",
        loader,
        createClientKey: () => "ck-new",
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    editor.content = '<p style="color: red" data-mce-selected="1">Saved</p>' +
        '<span class="katex" data-type="inline-math" data-subtype="math" data-content="x"><b>rendered</b></span>';

    assert.deepEqual(adapter.getAuthoritativeHTML(), {
        ok: true,
        html: '<p data-symemo-client-node-key="ck-new" style="color: red">Saved</p>' +
            '<span data-content="x" data-subtype="math" data-symemo-katex-trust="false" data-type="inline-math"></span>',
    });
});

test("reconciles accepted assignments without replacing newer text", async () => {
    const {loader, editor} = createLoader([]);
    const keys = ["ck-fresh-1", "ck-fresh-2"];
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: '<p data-symemo-client-node-key="ck-1">old</p>',
        loader,
        createClientKey: () => keys.shift() ?? "ck-fallback",
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    editor.content = '<p data-symemo-client-node-key="ck-1">newer text</p>';

    assert.deepEqual(adapter.reconcileAuthorityMetadata(
        '<p data-symemo-node-id="stable-1">old</p>',
        [{clientNodeKey: "ck-1", nodeId: "stable-1"}],
    ), {ok: true, mode: "incremental"});
    assert.equal(editor.content, '<p data-symemo-node-id="stable-1">newer text</p>');
    assert.deepEqual(editor.ignored, ["ignore", "ignore"]);
});

test("rerenders formulas after live identity normalization and authority reconciliation", async () => {
    const {loader, editor} = createLoader([]);
    const renderedHTML: string[] = [];
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "",
        loader,
        createClientKey: () => "ck-live",
        renderFormula: () => renderedHTML.push(editor.content),
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    renderedHTML.length = 0;

    editor.content = '<p>Value <span data-content="x^2" data-subtype="math" data-type="inline-math"></span></p>';
    editor.emit("input");
    assert.match(renderedHTML.at(-1) ?? "", /data-symemo-client-node-key="ck-live"/);

    const renderCount = renderedHTML.length;
    assert.deepEqual(adapter.reconcileAuthorityMetadata(
        '<p data-symemo-node-id="stable-1">Value <span data-content="x^2" data-subtype="math" data-type="inline-math"></span></p>',
        [{clientNodeKey: "ck-live", nodeId: "stable-1"}],
    ), {ok: true, mode: "canonical-replace"});
    assert.equal(renderedHTML.length, renderCount + 1);
    assert.match(renderedHTML.at(-1) ?? "", /data-symemo-node-id="stable-1"/);
});

test("destroys safely during registration and removes a late initialized editor exactly once", async () => {
    let releaseRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
        releaseRegistration = resolve;
    });
    let initCalls = 0;
    const registrationAdapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "",
        topicDomParser: parse5TopicDom,
        loader: {
            async loadCore() {
                return {init: async () => {
                    initCalls++;
                    return [];
                }};
            },
            async loadRegistrationModules() {
                await registration;
            },
        },
    });
    const registrationMount = registrationAdapter.mount();
    await Promise.resolve();
    registrationAdapter.destroy();
    releaseRegistration();
    assert.equal(await registrationMount, undefined);
    assert.equal(initCalls, 0);

    const events: string[] = [];
    const editor = new FakeEditor();
    let releaseInit!: () => void;
    let markInitStarted!: () => void;
    const initGate = new Promise<void>((resolve) => {
        releaseInit = resolve;
    });
    const initStarted = new Promise<void>((resolve) => {
        markInitStarted = resolve;
    });
    const {core} = createLoader(events, editor);
    core.init = async () => {
        markInitStarted();
        await initGate;
        return [editor];
    };
    const initAdapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "",
        topicDomParser: parse5TopicDom,
        loader: {
            async loadCore() { return core; },
            async loadRegistrationModules() {},
        },
    });
    const initMount = initAdapter.mount();
    await initStarted;
    initAdapter.destroy();
    releaseInit();
    assert.equal(await initMount, undefined);
    assert.equal(initAdapter.removalCount, 1);
    assert.equal(editor.removed, true);
});

test("uses canonical replacement and conservative full identity reset when reconciliation is not incremental", async () => {
    const canonicalEditor = new FakeEditor();
    const canonical = createLoader([], canonicalEditor);
    const canonicalAdapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: '<p data-symemo-client-node-key="ck-1">same</p>',
        loader: canonical.loader,
        topicDomParser: parse5TopicDom,
    });
    await canonicalAdapter.mount();
    assert.deepEqual(canonicalAdapter.reconcileAuthorityMetadata(
        '<p data-symemo-node-id="stable-1">same</p>',
        [{clientNodeKey: "ck-1", nodeId: "stable-1"}],
    ), {ok: true, mode: "canonical-replace"});
    assert.equal(canonicalEditor.content, '<p data-symemo-node-id="stable-1">same</p>');

    const resetEditor = new FakeEditor();
    const reset = createLoader([], resetEditor);
    const keys = ["fresh-1", "fresh-2"];
    const resetAdapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "",
        loader: reset.loader,
        createClientKey: () => keys.shift() ?? "fresh-fallback",
        topicDomParser: parse5TopicDom,
    });
    await resetAdapter.mount();
    resetEditor.content = '<p data-symemo-client-node-key="ck-1">newer A</p><p data-symemo-client-node-key="ck-1">newer B</p>';
    assert.deepEqual(resetAdapter.reconcileAuthorityMetadata(
        '<p data-symemo-node-id="stable-1">old</p>',
        [{clientNodeKey: "ck-1", nodeId: "stable-1"}],
    ), {ok: true, mode: "full-identity-reset"});
    assert.equal(
        resetEditor.content,
        '<p data-symemo-client-node-key="fresh-1">newer A</p><p data-symemo-client-node-key="fresh-2">newer B</p>',
    );
});

test("wires native copy and cut and rejects every external drop before TinyMCE mutation", async () => {
    const host = new FakeHost();
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: host as unknown as HTMLElement,
        initialHTML: "",
        loader,
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    editor.selectionHTML = '<p data-symemo-node-id="stable">Copy <strong>me</strong></p>';
    const clipboard = new Map<string, string>();
    let copyPrevented = false;
    editor.emit("copy", {
        clipboardData: {setData: (type: string, value: string) => clipboard.set(type, value)},
        preventDefault: () => { copyPrevented = true; },
    });
    assert.equal(copyPrevented, true);
    assert.equal(clipboard.get("text/html"), "<p>Copy <strong>me</strong></p>");
    assert.equal(clipboard.get("text/plain"), "Copy me");

    let dropPrevented = false;
    let dropStopped = false;
    host.dispatch("drop", {
        dataTransfer: {types: []},
        preventDefault: () => { dropPrevented = true; },
        stopPropagation: () => { dropStopped = true; },
    });
    assert.equal(dropPrevented, true);
    assert.equal(dropStopped, true);
    assert.deepEqual(editor.transactions, []);
});

test("performs a same-adapter atomic object move in one undo transaction", async () => {
    const host = new FakeHost();
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: host as unknown as HTMLElement,
        initialHTML: "",
        loader,
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    let removed = false;
    const movable = {
        outerHTML: '<img src="https://example.com/a.png">',
        remove: () => { removed = true; },
    };
    const types: string[] = [];
    const dataTransfer = {
        types,
        setData: (type: string) => types.push(type),
        dropEffect: "none",
    };
    host.dispatch("dragstart", {
        target: {closest: () => movable},
        dataTransfer,
    });
    let prevented = false;
    host.dispatch("drop", {
        dataTransfer,
        clientX: 1,
        clientY: 2,
        preventDefault: () => { prevented = true; },
        stopPropagation() {},
    });

    assert.equal(prevented, true);
    assert.equal(removed, true);
    assert.equal(editor.content, '<img src="https://example.com/a.png">');
    assert.deepEqual(editor.transactions, ["transact"]);
});

test("keeps an atomic object intact when it is dropped onto its own rendered subtree", async () => {
    const {loader, editor} = createLoader([]);
    const host = new FakeHost();
    const adapter = new TinyMceTopicEditorAdapter({
        host: host as unknown as HTMLElement,
        initialHTML: "",
        loader,
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    const renderedChild = {};
    let removed = false;
    const movable = {
        outerHTML: '<div data-content="x" data-subtype="math" data-type="NodeMathBlock"></div>',
        contains: (node: unknown) => node === renderedChild,
        remove: () => { removed = true; },
    };
    (host.ownerDocument as {caretRangeFromPoint: () => Range}).caretRangeFromPoint = () => ({
        startContainer: renderedChild,
    } as unknown as Range);
    const types: string[] = [];
    const dataTransfer = {
        types,
        setData: (type: string) => types.push(type),
        dropEffect: "none",
    };
    host.dispatch("dragstart", {
        target: {closest: () => movable},
        dataTransfer,
    });

    host.dispatch("drop", {
        dataTransfer,
        clientX: 1,
        clientY: 2,
        preventDefault() {},
        stopPropagation() {},
    });

    assert.equal(removed, false);
    assert.equal(editor.content, "");
    assert.deepEqual(editor.transactions, []);
});

test("reports a typed local serialization failure without publishing stale HTML", async () => {
    const {loader, editor} = createLoader([]);
    let broken = false;
    const dirty: string[] = [];
    const failures: string[] = [];
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "",
        loader,
        topicDomParser: {
            parse(html) {
                if (broken) throw new Error("parser failed");
                return parse5TopicDom.parse(html);
            },
        },
        onDirty: (html) => dirty.push(html),
        onSerializationFailure: (reason) => failures.push(reason),
    });
    await adapter.mount();
    editor.content = "<p>Unsaved live DOM</p>";
    broken = true;
    editor.emit("input");

    assert.deepEqual(dirty, []);
    assert.deepEqual(failures, ["serialization-failed"]);
});

test("removes an initialized editor when initial DOM normalization fails", async () => {
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "<p>Initial</p>",
        loader,
        topicDomParser: {parse: () => { throw new Error("parser failed"); }},
    });

    await assert.rejects(adapter.mount(), /parser failed/);
    assert.equal(adapter.mountedEditor, undefined);
    assert.equal(adapter.removalCount, 1);
    assert.equal(editor.removed, true);
});

test("classifies unrecoverable duplicate identity as identity-invalid", async () => {
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "",
        loader,
        createClientKey: () => "same-key",
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    editor.content = "<p>One</p><p>Two</p>";

    assert.deepEqual(adapter.getAuthoritativeHTML(), {ok: false, reason: "identity-invalid"});
});

test("repairs an authoritative assignment restored by an older undo snapshot before serialization", async () => {
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: '<p data-symemo-client-node-key="ck-1">old</p>',
        loader,
        topicDomParser: parse5TopicDom,
    });
    await adapter.mount();
    editor.content = '<p data-symemo-client-node-key="ck-1">newer</p>';
    adapter.reconcileAuthorityMetadata(
        '<p data-symemo-node-id="stable-1">old</p>',
        [{clientNodeKey: "ck-1", nodeId: "stable-1"}],
    );

    editor.content = '<p data-symemo-client-node-key="ck-1">undo text</p>';
    assert.deepEqual(adapter.getAuthoritativeHTML(), {
        ok: true,
        html: '<p data-symemo-node-id="stable-1">undo text</p>',
    });
    assert.equal(editor.content, '<p data-symemo-node-id="stable-1">undo text</p>');
});

test("inserts ordered native asset references only after upload succeeds", async () => {
    const {loader, editor} = createLoader([]);
    const host = new FakeHost();
    const adapter = new TinyMceTopicEditorAdapter({
        host: host as unknown as HTMLElement,
        initialHTML: "<p>Before</p>",
        loader,
        topicDomParser: parse5TopicDom,
        uploadImages: async () => ({
            ok: true,
            references: ["assets/first.png", "assets/second.png"],
            selection: {id: "bookmark"},
        }),
    });
    await adapter.mount();

    const result = await adapter.insertImageFiles([
        new File(["1"], "first.png", {type: "image/png"}),
        new File(["2"], "second.png", {type: "image/png"}),
    ]);

    assert.equal(result.ok, true);
    assert.match(editor.content, /assets\/first\.png/);
    assert.match(editor.content, /assets\/second\.png/);
    assert.equal(editor.content.includes("data:image"), false);
});

test("leaves pasted image files to TopicHtmlSurface as the single upload owner", async () => {
    const {loader, editor} = createLoader([]);
    let uploadCount = 0;
    let prevented = false;
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "<p>Before</p>",
        loader,
        topicDomParser: parse5TopicDom,
        uploadImages: async () => {
            uploadCount++;
            return {ok: true, references: ["assets/pasted.png"], selection: {id: "bookmark"}};
        },
    });
    await adapter.mount();

    editor.emit("paste", {
        clipboardData: {files: [new File(["1"], "pasted.png", {type: "image/png"})]},
        preventDefault: () => { prevented = true; },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(uploadCount, 0);
    assert.equal(prevented, false);
    assert.doesNotMatch(editor.content, /pasted\.png/);
});

test("does not insert a placeholder when native asset upload fails", async () => {
    const {loader, editor} = createLoader([]);
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "<p>Before</p>",
        loader,
        topicDomParser: parse5TopicDom,
        uploadImages: async () => ({ok: false, kind: "response", selection: {id: "bookmark"}}),
    });
    await adapter.mount();

    const result = await adapter.insertImageFiles([new File(["1"], "failed.png", {type: "image/png"})]);

    assert.equal(result.ok, false);
    assert.match(editor.content, /Before/);
    assert.doesNotMatch(editor.content, /failed\.png|data:image/);
});

test("does not insert a late image upload after the editor becomes non-interactive", async () => {
    const {loader, editor} = createLoader([]);
    let releaseUpload!: (result: import("./assetStore").AssetImportResult) => void;
    const upload = new Promise<import("./assetStore").AssetImportResult>((resolve) => {
        releaseUpload = resolve;
    });
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "<p>Before</p>",
        loader,
        topicDomParser: parse5TopicDom,
        uploadImages: async () => upload,
    });
    await adapter.mount();

    const pending = adapter.insertImageFiles([new File(["1"], "late.png", {type: "image/png"})]);
    adapter.setInteractive(false);
    releaseUpload({ok: true, references: ["assets/late.png"], selection: {}});
    await pending;

    assert.match(editor.content, /Before/);
    assert.doesNotMatch(editor.content, /late\.png/);
});

test("reports native drop upload failures through the adapter callback", async () => {
    const {loader, editor} = createLoader([]);
    const host = new FakeHost();
    const failures: import("./assetStore").AssetImportResult[] = [];
    const adapter = new TinyMceTopicEditorAdapter({
        host: host as unknown as HTMLElement,
        initialHTML: "<p>Before</p>",
        loader,
        topicDomParser: parse5TopicDom,
        uploadImages: async () => ({ok: false, kind: "response", selection: {}}),
        onImageImportFailure: (result) => failures.push(result),
    });
    await adapter.mount();

    host.dispatch("drop", {
        dataTransfer: {files: [new File(["1"], "failed-drop.png", {type: "image/png"})], types: []},
        preventDefault() {},
        stopPropagation() {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.ok, false);
    assert.match(editor.content, /Before/);
});

test("does not apply an upload captured before a barrier even after interaction resumes", async () => {
    const {loader, editor} = createLoader([]);
    let releaseUpload!: (result: import("./assetStore").AssetImportResult) => void;
    const upload = new Promise<import("./assetStore").AssetImportResult>((resolve) => {
        releaseUpload = resolve;
    });
    const adapter = new TinyMceTopicEditorAdapter({
        host: new FakeHost() as unknown as HTMLElement,
        initialHTML: "<p>Before</p>",
        loader,
        topicDomParser: parse5TopicDom,
        uploadImages: async () => upload,
    });
    await adapter.mount();

    const pending = adapter.insertImageFiles([new File(["1"], "stale.png", {type: "image/png"})]);
    adapter.setInteractive(false);
    adapter.setInteractive(true);
    releaseUpload({ok: true, references: ["assets/stale.png"], selection: {}});
    await pending;

    assert.match(editor.content, /Before/);
    assert.doesNotMatch(editor.content, /stale\.png/);
});
