import type {TopicEditorSnapshotResult, TopicFormattingAction, TopicFormattingState} from "./TopicHtmlSurface";
import {
    ClientKeyFactory,
    repairTopicEditorIdentity,
    serializeTopicEditorHTML,
    serializeTopicEditorNodes,
    stripEditorMetadata,
    SYMEMO_CLIENT_KEY_ATTR,
    SYMEMO_NODE_ID_ATTR,
    TopicEditorIdentityError,
} from "./topicEditorIdentity";
import {htmlToPlainText, normalizeTopicFormulaHTML, prepareFormulaRenderFrames} from "./topicFormula";
import {
    browserTopicDomParser,
    serializeTopicDomNodes,
    TopicDomParser,
    topicDomNodesFromParent,
    walkTopicDomElements,
} from "./topicDom";

export interface TinyMceEditorLike {
    id?: string;
    targetElm?: HTMLElement;
    getBody?(): HTMLElement;
    getContent(options?: Record<string, unknown>): string;
    setContent(html: string, options?: Record<string, unknown>): void;
    insertContent?(html: string): void;
    execCommand?(command: string, ui?: boolean, value?: unknown): void;
    queryCommandState?(command: string): boolean;
    queryCommandValue?(command: string): string;
    focus?(): void;
    remove?(): void;
    on?(name: string, callback: (event: any) => void): void;
    off?(name: string, callback: (event: any) => void): void;
    mode?: {set?(mode: "design" | "readonly"): void};
    selection?: {
        getContent?(options?: Record<string, unknown>): string;
        setContent?(html: string): void;
        getNode?(): Node;
        getBookmark?(): unknown;
        moveToBookmark?(bookmark: unknown): void;
        setRng?(range: Range): void;
    };
    undoManager?: {
        transact?(callback: () => void): void;
        ignore?(callback: () => void): void;
        add?(): void;
        hasUndo?(): boolean;
        hasRedo?(): boolean;
    };
    formatter?: {
        match?(format: string): boolean;
    };
}

export interface TinyMceCoreLike {
    init(options: Record<string, unknown>): Promise<TinyMceEditorLike[]> | TinyMceEditorLike[];
    EditorManager?: {
        editors?: TinyMceEditorLike[];
        remove?(editor: TinyMceEditorLike): void;
        get?(id: string): TinyMceEditorLike | undefined;
    };
}

export interface TinyMceTopicEditorLoader {
    loadCore(): Promise<TinyMceCoreLike>;
    loadRegistrationModules(): Promise<void>;
}

export interface TopicClipboardWriter {
    (payload: {html: string; text: string}): Promise<void>;
}

export type TopicEditorMetadataResult =
    | {ok: true; mode: "incremental" | "canonical-replace" | "full-identity-reset"}
    | {ok: false; reason: "destroyed"};

export interface TinyMceTopicEditorAdapterOptions {
    host: HTMLElement;
    initialHTML: string;
    loader?: TinyMceTopicEditorLoader;
    createClientKey?: ClientKeyFactory;
    renderFormula?: (element: HTMLElement) => void;
    onDirty?: (html: string) => void;
    onCommandStateChange?: () => void;
    onSerializationFailure?: (reason: "identity-invalid" | "serialization-failed") => void;
    topicDomParser?: TopicDomParser;
}

const ADDRESSABLE_ATTRIBUTES = "id|style|data-symemo-node-id|data-symemo-client-node-key";
const STRUCTURAL_ATTRIBUTES = "id|style";
const TOPIC_VALID_ELEMENTS = [
    `a[href|title|${STRUCTURAL_ATTRIBUTES}]`,
    `blockquote[${ADDRESSABLE_ATTRIBUTES}]`,
    `br[${STRUCTURAL_ATTRIBUTES}]`,
    `code[${STRUCTURAL_ATTRIBUTES}]`,
    `div[data-content|data-subtype|data-symemo-katex-trust|data-type|${ADDRESSABLE_ATTRIBUTES}]`,
    `del[${STRUCTURAL_ATTRIBUTES}]`,
    `em[${STRUCTURAL_ATTRIBUTES}]`,
    `i[${STRUCTURAL_ATTRIBUTES}]`,
    `figcaption[${STRUCTURAL_ATTRIBUTES}]`,
    `figure[${ADDRESSABLE_ATTRIBUTES}]`,
    `h1[${ADDRESSABLE_ATTRIBUTES}],h2[${ADDRESSABLE_ATTRIBUTES}],h3[${ADDRESSABLE_ATTRIBUTES}],h4[${ADDRESSABLE_ATTRIBUTES}],h5[${ADDRESSABLE_ATTRIBUTES}],h6[${ADDRESSABLE_ATTRIBUTES}]`,
    `hr[${ADDRESSABLE_ATTRIBUTES}]`,
    `img[src|alt|title|${STRUCTURAL_ATTRIBUTES}]`,
    `ins[${STRUCTURAL_ATTRIBUTES}]`,
    `li[${ADDRESSABLE_ATTRIBUTES}]`,
    `mark[${STRUCTURAL_ATTRIBUTES}]`,
    `ol[start|reversed|${STRUCTURAL_ATTRIBUTES}]`,
    `p[${ADDRESSABLE_ATTRIBUTES}]`,
    `pre[${ADDRESSABLE_ATTRIBUTES}]`,
    `s[${STRUCTURAL_ATTRIBUTES}]`,
    `span[data-content|data-subtype|data-symemo-katex-trust|data-type|${STRUCTURAL_ATTRIBUTES}]`,
    `strong[${STRUCTURAL_ATTRIBUTES}]`,
    `b[${STRUCTURAL_ATTRIBUTES}]`,
    `sub[${STRUCTURAL_ATTRIBUTES}]`,
    `sup[${STRUCTURAL_ATTRIBUTES}]`,
    `table[${STRUCTURAL_ATTRIBUTES}],thead[${STRUCTURAL_ATTRIBUTES}],tbody[${STRUCTURAL_ATTRIBUTES}],tfoot[${STRUCTURAL_ATTRIBUTES}],tr[${STRUCTURAL_ATTRIBUTES}],th[colspan|rowspan|scope|${ADDRESSABLE_ATTRIBUTES}],td[colspan|rowspan|${ADDRESSABLE_ATTRIBUTES}]`,
    `u[${STRUCTURAL_ATTRIBUTES}]`,
    `ul[${STRUCTURAL_ATTRIBUTES}]`,
].join(",");

export const createSelfHostedTinyMceLoader = (): TinyMceTopicEditorLoader => ({
    async loadCore() {
        const module = await import(
            /* webpackChunkName: "symemo-tinymce" */
            "tinymce/tinymce"
        ) as unknown as {default?: TinyMceCoreLike} & TinyMceCoreLike;
        return module.default ?? module;
    },
    async loadRegistrationModules() {
        // @ts-ignore TinyMCE 副作用模块没有单独发布类型声明。
        await import(/* webpackChunkName: "symemo-tinymce" */ "tinymce/models/dom");
        // @ts-ignore TinyMCE 副作用模块没有单独发布类型声明。
        await import(/* webpackChunkName: "symemo-tinymce" */ "tinymce/icons/default");
        // @ts-ignore TinyMCE 副作用模块没有单独发布类型声明。
        await import(/* webpackChunkName: "symemo-tinymce" */ "tinymce/plugins/lists");
        // @ts-ignore TinyMCE 副作用模块没有单独发布类型声明。
        await import(/* webpackChunkName: "symemo-tinymce" */ "tinymce/plugins/link");
        // @ts-ignore TinyMCE 副作用模块没有单独发布类型声明。
        await import(/* webpackChunkName: "symemo-tinymce" */ "tinymce/plugins/table");
    },
});

export class TinyMceTopicEditorAdapter {
    private readonly loader: TinyMceTopicEditorLoader;
    private readonly createClientKey?: ClientKeyFactory;
    private readonly renderFormula?: (element: HTMLElement) => void;
    private readonly onDirty?: (html: string) => void;
    private readonly parser: TopicDomParser;
    private readonly removedEditors = new WeakSet<object>();
    private readonly activeAssignments = new Map<string, string>();
    private readonly retiredClientKeys = new Set<string>();
    private readonly retiredNodeIds = new Set<string>();
    private editor?: TinyMceEditorLike;
    private core?: TinyMceCoreLike;
    private epoch = 0;
    private destroyed = false;
    private removeCount = 0;
    private listenersInstalled = false;
    private suppressDirty = false;
    private sameAdapterMoveToken: HTMLElement | undefined;

    constructor(private readonly options: TinyMceTopicEditorAdapterOptions) {
        this.loader = options.loader ?? createSelfHostedTinyMceLoader();
        this.createClientKey = options.createClientKey;
        this.renderFormula = options.renderFormula;
        this.onDirty = options.onDirty;
        this.parser = options.topicDomParser ?? browserTopicDomParser;
    }

    public get removalCount() {
        return this.removeCount;
    }

    public get mountedEditor() {
        return this.editor;
    }

    public async mount(): Promise<TinyMceEditorLike | undefined> {
        if (this.destroyed) return undefined;
        const epoch = ++this.epoch;
        this.options.host.setAttribute("contenteditable", "false");
        this.options.host.setAttribute("aria-busy", "true");
        this.installDropGuards();

        const core = await this.loader.loadCore();
        this.core = core;
        if (!this.isCurrent(epoch)) return undefined;
        await this.loader.loadRegistrationModules();
        if (!this.isCurrent(epoch)) return undefined;

        const editors = await core.init(this.createInitOptions(epoch));
        const editor = Array.isArray(editors) ? editors[0] : editors;
        if (!editor) return undefined;
        if (!this.isCurrent(epoch)) {
            this.removeEditor(editor);
            return undefined;
        }

        this.editor = editor;
        try {
            const normalized = this.normalizeHTML(this.options.initialHTML, true);
            this.runIgnored(() => editor.setContent(normalized, {format: "html"}));
            this.afterProgrammaticMutation();
        } catch (error) {
            this.editor = undefined;
            this.removeEditor(editor);
            this.options.host.setAttribute("contenteditable", "false");
            this.options.host.removeAttribute("aria-busy");
            throw error;
        }
        if (!this.isCurrent(epoch)) {
            this.editor = undefined;
            this.removeEditor(editor);
            return undefined;
        }
        this.options.host.removeAttribute("aria-busy");
        this.options.host.setAttribute("contenteditable", "true");
        return editor;
    }

    public destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.epoch++;
        this.sameAdapterMoveToken = undefined;
        this.removeDropGuards();
        const editor = this.editor;
        this.editor = undefined;
        if (editor) this.removeEditor(editor);
        this.options.host.setAttribute("contenteditable", "false");
        this.options.host.removeAttribute("aria-busy");
    }

    public getAuthoritativeHTML(): TopicEditorSnapshotResult {
        if (this.destroyed || !this.editor) return {ok: false, reason: "destroyed"};
        try {
            this.normalizeLiveIdentity();
            const body = this.editor.getBody?.();
            const html = body
                ? serializeTopicEditorNodes(topicDomNodesFromParent(body.cloneNode(true) as ParentNode), {
                    createClientKey: this.createClientKey,
                    retiredClientKeys: this.retiredClientKeys,
                    retiredNodeIds: this.retiredNodeIds,
                })
                : serializeTopicEditorHTML(this.editor.getContent({format: "html"}), {
                    createClientKey: this.createClientKey,
                    retiredClientKeys: this.retiredClientKeys,
                    retiredNodeIds: this.retiredNodeIds,
                }, this.parser);
            return {ok: true, html};
        } catch (error) {
            return {ok: false, reason: error instanceof TopicEditorIdentityError ? "identity-invalid" : "serialization-failed"};
        }
    }

    public serializeForSave(): string {
        const result = this.getAuthoritativeHTML();
        return result.ok ? result.html : "";
    }

    public replaceHTML(html: string): void {
        if (!this.editor || this.destroyed) return;
        this.setProgrammaticHTML(this.normalizeHTML(html, true));
    }

    public reconcileAuthorityMetadata(
        canonicalHTML: string,
        assignments: Array<{clientNodeKey: string; nodeId: string}>,
    ): TopicEditorMetadataResult {
        if (this.destroyed || !this.editor) return {ok: false, reason: "destroyed"};
        const canonicalNodes = this.parser.parse(canonicalHTML);
        const canonicalNodeIds = new Set<string>();
        walkTopicDomElements(canonicalNodes, (element) => {
            const nodeId = element.attributes[SYMEMO_NODE_ID_ATTR];
            if (nodeId) canonicalNodeIds.add(nodeId);
        });

        for (const [clientKey, nodeId] of [...this.activeAssignments]) {
            if (canonicalNodeIds.has(nodeId)) continue;
            this.retiredClientKeys.add(clientKey);
            this.retiredNodeIds.add(nodeId);
            this.activeAssignments.delete(clientKey);
        }

        let ambiguous = false;
        const acceptedAssignments = new Map<string, string>();
        const assignedNodeIds = new Set<string>();
        for (const assignment of assignments) {
            if (!assignment.clientNodeKey || !assignment.nodeId || !canonicalNodeIds.has(assignment.nodeId) ||
                acceptedAssignments.has(assignment.clientNodeKey) || assignedNodeIds.has(assignment.nodeId) ||
                this.retiredClientKeys.has(assignment.clientNodeKey) || this.retiredNodeIds.has(assignment.nodeId)) {
                ambiguous = true;
                continue;
            }
            acceptedAssignments.set(assignment.clientNodeKey, assignment.nodeId);
            assignedNodeIds.add(assignment.nodeId);
        }

        const liveHTML = this.editor.getContent({format: "html"});
        const liveNodes = this.parser.parse(liveHTML);
        const clientCounts = new Map<string, number>();
        const nodeCounts = new Map<string, number>();
        walkTopicDomElements(liveNodes, (element) => {
            const clientKey = element.attributes[SYMEMO_CLIENT_KEY_ATTR];
            const nodeId = element.attributes[SYMEMO_NODE_ID_ATTR];
            if (clientKey) clientCounts.set(clientKey, (clientCounts.get(clientKey) ?? 0) + 1);
            if (nodeId) nodeCounts.set(nodeId, (nodeCounts.get(nodeId) ?? 0) + 1);
            if (clientKey && nodeId) ambiguous = true;
        });
        if ([...clientCounts.values()].some((count) => count > 1) || [...nodeCounts.values()].some((count) => count > 1)) {
            ambiguous = true;
        }

        walkTopicDomElements(liveNodes, (element) => {
            const clientKey = element.attributes[SYMEMO_CLIENT_KEY_ATTR];
            const nodeId = element.attributes[SYMEMO_NODE_ID_ATTR];
            if (nodeId && (!canonicalNodeIds.has(nodeId) || this.retiredNodeIds.has(nodeId))) {
                this.retiredNodeIds.add(nodeId);
                delete element.attributes[SYMEMO_NODE_ID_ATTR];
            }
            if (clientKey && this.retiredClientKeys.has(clientKey)) {
                delete element.attributes[SYMEMO_CLIENT_KEY_ATTR];
            }
            const acceptedNodeId = clientKey ? acceptedAssignments.get(clientKey) : undefined;
            if (acceptedNodeId && clientCounts.get(clientKey!) === 1 && !element.attributes[SYMEMO_NODE_ID_ATTR]) {
                element.attributes[SYMEMO_NODE_ID_ATTR] = acceptedNodeId;
                delete element.attributes[SYMEMO_CLIENT_KEY_ATTR];
                this.activeAssignments.set(clientKey!, acceptedNodeId);
            }
        });

        const liveVisible = stripEditorMetadata(liveHTML, true, true, this.parser);
        const canonicalVisible = stripEditorMetadata(canonicalHTML, true, true, this.parser);
        if (ambiguous) {
            if (liveVisible === canonicalVisible) {
                this.setProgrammaticHTML(this.normalizeHTML(canonicalHTML, true));
                return {ok: true, mode: "canonical-replace"};
            }
            const resetHTML = repairTopicEditorIdentity(stripEditorMetadata(liveHTML, true, true, this.parser), {
                createClientKey: this.createClientKey,
                retiredClientKeys: this.retiredClientKeys,
                retiredNodeIds: this.retiredNodeIds,
            }, this.parser);
            this.setProgrammaticHTML(normalizeTopicFormulaHTML(resetHTML, true, this.parser));
            return {ok: true, mode: "full-identity-reset"};
        }

        if (liveVisible === canonicalVisible) {
            this.setProgrammaticHTML(this.normalizeHTML(canonicalHTML, true));
            return {ok: true, mode: "canonical-replace"};
        }
        const reconciled = repairTopicEditorIdentity(serializeTopicDomNodes(liveNodes), {
            createClientKey: this.createClientKey,
            retiredClientKeys: this.retiredClientKeys,
            retiredNodeIds: this.retiredNodeIds,
        }, this.parser);
        this.setProgrammaticHTML(normalizeTopicFormulaHTML(reconciled, true, this.parser));
        return {ok: true, mode: "incremental"};
    }

    public insertHTML(html: string): void {
        if (!this.editor || this.destroyed) return;
        const normalized = this.normalizeHTML(html, true);
        this.runTransaction(() => this.editor?.insertContent?.(normalized));
        this.afterUserMutation();
    }

    public insertPlainText(text: string): void {
        const html = text.split(/\r\n|\r|\n/).map((line) => `<p>${line
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;") || "<br>"}</p>`).join("");
        this.insertHTML(html);
    }

    public execFormat(command: string, value?: unknown): void {
        if (!this.editor || this.destroyed) return;
        this.runTransaction(() => this.editor?.execCommand?.(command, false, value));
        this.afterUserMutation();
    }

    public execFormatting(action: TopicFormattingAction): void {
        const commands: Partial<Record<TopicFormattingAction["command"], string>> = {
            bold: "Bold",
            italic: "Italic",
            bulletList: "InsertUnorderedList",
            orderedList: "InsertOrderedList",
            blockquote: "mceBlockQuote",
            unlink: "unlink",
        };
        if (action.command === "undo" || action.command === "redo") {
            this.execHistoryCommand(action.command === "undo" ? "Undo" : "Redo");
        } else if (action.command === "code") this.execFormat("mceToggleFormat", "code");
        else if (action.command === "heading") this.execFormat("FormatBlock", action.value);
        else if (action.command === "link") this.execFormat("mceInsertLink", {href: action.href, title: action.title});
        else if (action.command === "table") this.execFormat("mceInsertTable", {rows: action.rows, columns: action.columns});
        else this.execFormat(commands[action.command] ?? action.command);
    }

    public queryFormatting(): TopicFormattingState {
        const editor = this.editor;
        const blockFormat = (editor?.queryCommandValue?.("FormatBlock") || "p").toLowerCase();
        const selectionNode = editor?.selection?.getNode?.() as HTMLElement | undefined;
        return {
            undoEnabled: editor?.undoManager?.hasUndo?.() ?? false,
            redoEnabled: editor?.undoManager?.hasRedo?.() ?? false,
            boldActive: editor?.queryCommandState?.("Bold") ?? false,
            italicActive: editor?.queryCommandState?.("Italic") ?? false,
            bulletListActive: editor?.queryCommandState?.("InsertUnorderedList") ?? false,
            orderedListActive: editor?.queryCommandState?.("InsertOrderedList") ?? false,
            blockquoteActive: editor?.queryCommandState?.("mceBlockQuote") ?? false,
            codeActive: editor?.formatter?.match?.("code") ?? false,
            linkActive: Boolean(selectionNode?.closest?.("a[href]")),
            tableActive: Boolean(selectionNode?.closest?.("table")),
            blockFormat: /^(p|h[1-6])$/.test(blockFormat) ? blockFormat as TopicFormattingState["blockFormat"] : "p",
        };
    }

    public captureSelection(): unknown {
        return this.editor?.selection?.getBookmark?.();
    }

    public restoreSelection(selection: unknown): boolean {
        if (!this.editor?.selection?.moveToBookmark || this.destroyed) return false;
        try {
            this.editor.selection.moveToBookmark(selection);
            return true;
        } catch {
            return false;
        }
    }

    public setInteractive(enabled: boolean): void {
        if (this.destroyed) return;
        this.options.host.setAttribute("contenteditable", enabled ? "true" : "false");
        this.editor?.mode?.set?.(enabled ? "design" : "readonly");
        if (!enabled) this.sameAdapterMoveToken = undefined;
    }

    public focus(): void {
        this.editor?.focus?.();
        this.editor?.targetElm?.focus?.();
    }

    public async copySelection(writeClipboard: TopicClipboardWriter): Promise<void> {
        const html = this.exportSelectionHTML();
        await writeClipboard({html, text: htmlToPlainText(html, this.parser)});
    }

    public async cutSelection(writeClipboard: TopicClipboardWriter): Promise<void> {
        const html = this.exportSelectionHTML();
        await writeClipboard({html, text: htmlToPlainText(html, this.parser)});
        this.runTransaction(() => this.editor?.selection?.setContent?.(""));
        this.afterUserMutation();
    }

    private createInitOptions(epoch: number): Record<string, unknown> {
        return {
            target: this.options.host,
            license_key: "gpl",
            inline: true,
            theme: false,
            icons: "default",
            menubar: false,
            toolbar: false,
            contextmenu: false,
            promotion: false,
            branding: false,
            content_css: false,
            paste_data_images: false,
            automatic_uploads: false,
            convert_urls: false,
            relative_urls: false,
            browser_spellcheck: true,
            plugins: "lists link table",
            paste_block_drop: false,
            forced_root_block: "p",
            valid_elements: TOPIC_VALID_ELEMENTS,
            extended_valid_elements: TOPIC_VALID_ELEMENTS,
            invalid_elements: "script,style,iframe,object,embed,form,input,textarea,button,video,audio,canvas,svg,math",
            setup: (editor: TinyMceEditorLike) => {
                editor.on?.("BeforeAddUndo", (event: any) => {
                    if (event?.level?.content && typeof event.level.content === "string") {
                        event.level.content = this.normalizeHTML(event.level.content, true);
                    }
                });
                editor.on?.("Undo", () => this.handleEditorMutation(epoch));
                editor.on?.("Redo", () => this.handleEditorMutation(epoch));
                editor.on?.("input", () => this.handleEditorMutation(epoch));
                editor.on?.("NodeChange", () => this.options.onCommandStateChange?.());
                editor.on?.("SelectionChange", () => this.options.onCommandStateChange?.());
                editor.on?.("copy", (event: any) => this.handleClipboardEvent(event, false));
                editor.on?.("cut", (event: any) => this.handleClipboardEvent(event, true));
            },
        };
    }

    private handleEditorMutation(epoch: number): void {
        if (this.isCurrent(epoch) && !this.suppressDirty) this.afterUserMutation();
    }

    private handleClipboardEvent(event: any, cut: boolean): void {
        const html = this.exportSelectionHTML();
        const clipboard = event?.clipboardData;
        if (!clipboard?.setData) return;
        clipboard.setData("text/html", html);
        clipboard.setData("text/plain", htmlToPlainText(html, this.parser));
        event.preventDefault?.();
        if (cut) {
            this.runTransaction(() => this.editor?.selection?.setContent?.(""));
            this.afterUserMutation();
        }
    }

    private exportSelectionHTML(): string {
        return stripEditorMetadata(this.editor?.selection?.getContent?.({format: "html"}) ?? "", true, true, this.parser);
    }

    private normalizeHTML(html: string, includeRenderFrame: boolean): string {
        return repairTopicEditorIdentity(normalizeTopicFormulaHTML(html, includeRenderFrame, this.parser), {
            createClientKey: this.createClientKey,
            retiredClientKeys: this.retiredClientKeys,
            retiredNodeIds: this.retiredNodeIds,
        }, this.parser);
    }

    private normalizeLiveIdentity(): void {
        if (!this.editor) return;
        const current = this.editor.getContent({format: "html"});
        const nodes = this.parser.parse(current);
        const clientCounts = new Map<string, number>();
        walkTopicDomElements(nodes, (element) => {
            const clientKey = element.attributes[SYMEMO_CLIENT_KEY_ATTR];
            if (clientKey) clientCounts.set(clientKey, (clientCounts.get(clientKey) ?? 0) + 1);
        });
        walkTopicDomElements(nodes, (element) => {
            const clientKey = element.attributes[SYMEMO_CLIENT_KEY_ATTR];
            const assignedNodeId = clientKey && clientCounts.get(clientKey) === 1
                ? this.activeAssignments.get(clientKey)
                : undefined;
            if (assignedNodeId && !this.retiredNodeIds.has(assignedNodeId)) {
                const currentNodeId = element.attributes[SYMEMO_NODE_ID_ATTR];
                if (!currentNodeId || currentNodeId === assignedNodeId) {
                    element.attributes[SYMEMO_NODE_ID_ATTR] = assignedNodeId;
                    delete element.attributes[SYMEMO_CLIENT_KEY_ATTR];
                } else {
                    delete element.attributes[SYMEMO_NODE_ID_ATTR];
                    delete element.attributes[SYMEMO_CLIENT_KEY_ATTR];
                }
            }
        });
        const normalized = this.normalizeHTML(serializeTopicDomNodes(nodes), true);
        if (normalized !== current) this.setProgrammaticHTML(normalized);
    }

    private setProgrammaticHTML(html: string): void {
        if (!this.editor) return;
        this.runIgnored(() => this.editor?.setContent(html, {format: "html"}));
        this.afterProgrammaticMutation();
    }

    private runIgnored(callback: () => void): void {
        this.suppressDirty = true;
        try {
            if (this.editor?.undoManager?.ignore) this.editor.undoManager.ignore(callback);
            else callback();
        } finally {
            this.suppressDirty = false;
        }
    }

    private runTransaction(callback: () => void): void {
        this.suppressDirty = true;
        try {
            if (this.editor?.undoManager?.transact) this.editor.undoManager.transact(callback);
            else callback();
        } finally {
            this.suppressDirty = false;
        }
    }

    private execHistoryCommand(command: "Undo" | "Redo"): void {
        if (!this.editor || this.destroyed) return;
        this.suppressDirty = true;
        try {
            this.editor.execCommand?.(command, false);
        } finally {
            this.suppressDirty = false;
        }
        this.afterUserMutation();
    }

    private afterProgrammaticMutation(): void {
        if (!this.options.host.isConnected) return;
        prepareFormulaRenderFrames(this.options.host);
        this.renderFormula?.(this.options.host);
    }

    private afterUserMutation(): void {
        this.afterProgrammaticMutation();
        const snapshot = this.getAuthoritativeHTML();
        if (snapshot.ok) {
            this.onDirty?.(snapshot.html);
        } else if ("reason" in snapshot && snapshot.reason !== "destroyed") {
            this.options.onSerializationFailure?.(snapshot.reason);
        }
    }

    private isCurrent(epoch: number): boolean {
        return !this.destroyed && this.epoch === epoch;
    }

    private removeEditor(editor: TinyMceEditorLike): void {
        if (this.removedEditors.has(editor as object)) return;
        this.removedEditors.add(editor as object);
        this.removeCount++;
        if (this.core?.EditorManager?.remove) this.core.EditorManager.remove(editor);
        else editor.remove?.();
    }

    private installDropGuards(): void {
        if (this.listenersInstalled) return;
        this.listenersInstalled = true;
        this.options.host.addEventListener("dragstart", this.handleDragStart, true);
        this.options.host.addEventListener("dragend", this.handleDragEnd, true);
        this.options.host.addEventListener("drop", this.handleDrop, true);
        this.options.host.addEventListener("dragover", this.handleDragOver, true);
    }

    private removeDropGuards(): void {
        if (!this.listenersInstalled) return;
        this.listenersInstalled = false;
        this.options.host.removeEventListener("dragstart", this.handleDragStart, true);
        this.options.host.removeEventListener("dragend", this.handleDragEnd, true);
        this.options.host.removeEventListener("drop", this.handleDrop, true);
        this.options.host.removeEventListener("dragover", this.handleDragOver, true);
    }

    private readonly handleDragStart = (event: DragEvent): void => {
        const target = event.target as Element | null;
        const movable = typeof target?.closest === "function"
            ? target.closest('[data-type="NodeMathBlock"],[data-type="inline-math"],img') as HTMLElement | null
            : null;
        if (movable && this.options.host.contains(movable)) {
            this.sameAdapterMoveToken = movable;
            event.dataTransfer?.setData("application/x-symemo-topic-editor-move", "1");
        }
    };

    private readonly handleDragEnd = (): void => {
        this.sameAdapterMoveToken = undefined;
    };

    private readonly handleDragOver = (event: DragEvent): void => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = this.isControlledMove(event) ? "move" : "none";
    };

    private readonly handleDrop = (event: DragEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        if (this.isControlledMove(event)) this.performControlledMove(event);
        this.sameAdapterMoveToken = undefined;
    };

    private isControlledMove(event: DragEvent): boolean {
        return Boolean(this.sameAdapterMoveToken) &&
            Array.from(event.dataTransfer?.types ?? []).includes("application/x-symemo-topic-editor-move");
    }

    private performControlledMove(event: DragEvent): void {
        const movable = this.sameAdapterMoveToken;
        if (!movable || !this.editor) return;
        const html = movable.outerHTML;
        const document = this.options.host.ownerDocument;
        const caretRange = (document as Document & {caretRangeFromPoint?(x: number, y: number): Range | null})
            .caretRangeFromPoint?.(event.clientX, event.clientY);
        if (caretRange && movable.contains(caretRange.startContainer)) return;
        this.runTransaction(() => {
            if (caretRange) this.editor?.selection?.setRng?.(caretRange);
            this.editor?.insertContent?.(html);
            movable.remove();
        });
        this.afterUserMutation();
    }
}
