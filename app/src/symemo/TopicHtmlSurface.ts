import {mathRender} from "../protyle/render/mathRender";
import {readClipboard} from "../protyle/util/compatibility";
import {fetchPost} from "../util/fetch";
import {Menu, MenuItem} from "../menus/Menu";
import {createHTMLTopic, getElement, renameElement, saveTopicHTML} from "./api";
import {AuthoringSession} from "./authoringSession";
import {
    getTopicPasteAvailability,
    projectClipboardData,
    projectClipboardEvent,
    selectTopicPasteFlavor,
} from "./clipboardPolicy";
import {filterTopicHTMLIngress, isSafeTopicHref} from "./topicHtmlIngress";
import {mapMarkdownFormulaHTML} from "./topicFormula";
import type {TopicDomParser} from "./topicDom";
import type {
    AuthoringStatus,
    ElementChangeResult,
    ElementDetailView,
    ModelTransitionReason,
    ModelTransitionResult,
    SiyuanMarkdownHTMLFragment,
    TopicClipboardSnapshot,
    TopicPasteCommand,
    TopicPasteFlavor,
} from "./types";

export type TopicBlockFormat = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export type TopicFormattingAction =
    | {command: "undo" | "redo" | "bold" | "italic" | "bulletList" | "orderedList" | "blockquote" | "code"}
    | {command: "heading"; value: TopicBlockFormat}
    | {command: "link"; href: string; title?: string}
    | {command: "unlink"}
    | {command: "table"; rows: number; columns: number};

export interface TopicFormattingState {
    undoEnabled: boolean;
    redoEnabled: boolean;
    boldActive: boolean;
    italicActive: boolean;
    bulletListActive: boolean;
    orderedListActive: boolean;
    blockquoteActive: boolean;
    codeActive: boolean;
    linkActive: boolean;
    tableActive: boolean;
    blockFormat: TopicBlockFormat;
}

export type TopicEditorSnapshotResult =
    | {ok: true; html: string}
    | {ok: false; reason: "destroyed" | "identity-invalid" | "serialization-failed"};

export interface TopicHtmlEditorAdapter {
    mount(): Promise<unknown>;
    destroy(): void;
    focus?(): void;
    execFormatting?(action: TopicFormattingAction): void;
    queryFormatting?(): TopicFormattingState;
    insertHTML?(html: string): void;
    insertImageFiles?(files: File[]): Promise<import("./assetStore").AssetImportResult>;
    captureSelectionBookmark?(): unknown;
    restoreSelectionBookmark?(bookmark: unknown): boolean;
    replaceHTML?(html: string): void;
    setInteractive?(enabled: boolean): void;
    reconcileAuthorityMetadata?(canonicalHTML: string, assignments: Array<{clientNodeKey: string; nodeId: string}>): void;
    getAuthoritativeHTML?(): TopicEditorSnapshotResult;
}

export interface TopicHtmlEditorFactoryContext {
    host: HTMLElement;
    initialHTML: string;
    surface: TopicHtmlSurface;
    onDirty(html: string): void;
    onCommandStateChange(): void;
    onSerializationFailure(reason: "identity-invalid" | "serialization-failed"): void;
    onImageImportFailure?: (result: import("./assetStore").AssetImportResult) => void;
}

export type TopicHtmlEditorFactory =
    (context: TopicHtmlEditorFactoryContext) => TopicHtmlEditorAdapter | Promise<TopicHtmlEditorAdapter>;

export interface TopicHtmlSurfaceOptions {
    container: HTMLElement;
    createEditor?: TopicHtmlEditorFactory;
    language?: (key: string) => string;
    debounceMs?: number;
    topicDomParser?: TopicDomParser;
    onSaveAsNew?: (elementId: string) => void;
    onTitleChange?: (title: string) => void;
    onTransitionReadyChange?: (ready: boolean) => void;
}

export interface NormalizedTopicTitleInput {
    title: string;
    valid: boolean;
}

const DEFAULT_DEBOUNCE_MS = 256;
const TITLE_MAX_LENGTH = 512;
const LUTE_MARKDOWN_ROUTE = "/api/lute/md2html";

const defaultLanguage = (key: string): string => window.siyuan?.languages?.[key] || "";

const stripTitleControlCharacters = (value: string): string => Array.from(value).filter((character) => {
    const code = character.charCodeAt(0);
    return !(code <= 31 || (code >= 127 && code <= 159));
}).join("");

export const normalizeTopicTitleInput = (value: string): NormalizedTopicTitleInput => {
    const title = stripTitleControlCharacters(value).trim();
    return {
        title,
        valid: Array.from(title).length <= TITLE_MAX_LENGTH,
    };
};

const statusLanguageKeys: Record<AuthoringStatus, string[]> = {
    acceptedRecovering: ["symemoTopicAcceptedRecovering", "symemoAcceptedRecovering"],
    clean: ["symemoTopicClean", "symemoSaved"],
    conflict: ["symemoTopicConflict", "symemoRevisionConflict"],
    failed: ["symemoTopicFailed", "symemoSaveFailed"],
    pending: ["symemoTopicPending", "symemoSavePending"],
    saving: ["symemoTopicSaving", "symemoSaving"],
};

const escapeHTML = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const plainTextToHTML = (text: string): string => {
    const lines = text.split(/\r\n|\r|\n/);
    return lines.map((line) => `<p>${escapeHTML(line) || "<br>"}</p>`).join("");
};

export class TopicHtmlSurface {
    public lifecycleRegistered = false;
    private readonly createEditor: TopicHtmlEditorFactory;
    private readonly language: (key: string) => string;
    private readonly debounceMs: number;
    private session?: AuthoringSession;
    private editor?: TopicHtmlEditorAdapter;
    private titleElement?: HTMLElement;
    private editorHost?: HTMLElement;
    private statusElement?: HTMLElement;
    private actionsElement?: HTMLElement;
    private toolbarElement?: HTMLElement;
    private epoch = 0;
    private operationEpoch = 0;
    private destroyed = false;
    private mounting = false;
    private composingTitle = false;
    private titleInvalid = false;
    private interactionBlocked = false;
    private lastTransitionReady?: boolean;
    private lastPublishedTitle?: string;
    private serializationFailure?: "identity-invalid" | "serialization-failed";

    constructor(private readonly options: TopicHtmlSurfaceOptions) {
        this.createEditor = options.createEditor ?? this.createDefaultEditor;
        this.language = options.language ?? defaultLanguage;
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    }

    public async mount(detail: ElementDetailView): Promise<void> {
        const titleRevision = detail.titleRevision;
        const materialRevision = detail.topicMaterial?.revision;
        if (!titleRevision || !materialRevision) {
            return;
        }
        this.destroyed = false;
        this.mounting = true;
        this.titleInvalid = false;
        this.interactionBlocked = false;
        this.lastTransitionReady = undefined;
        this.serializationFailure = undefined;
        this.lastPublishedTitle = detail.title;
        const epoch = ++this.epoch;
        this.operationEpoch++;
        const initialHTML = detail.topicMaterial?.html || "";
        this.session = new AuthoringSession({
            elementId: detail.elementId,
            title: detail.title,
            html: initialHTML,
            titleRevision,
            materialRevision,
            saveTitle: this.saveTitle,
            saveMaterial: this.saveMaterial,
            getElement,
            createHTMLTopic,
            onAcceptedChange: (change) => {
                if (change.changedField === "material") {
                    this.editor?.reconcileAuthorityMetadata?.(
                        change.canonicalValue,
                        change.nodeIdentityAssignments ?? [],
                    );
                }
            },
            debounceMs: this.debounceMs,
        });
        this.lifecycleRegistered = true;
        this.renderShell(detail, initialHTML);
        const host = this.editorHost;
        if (!host) {
            this.mounting = false;
            this.updateStatus();
            return;
        }

        const editor = await this.createEditor({
            host,
            initialHTML,
            surface: this,
            onDirty: (html) => {
                this.serializationFailure = undefined;
                this.session?.editMaterial(html);
                this.updateStatus();
            },
            onCommandStateChange: () => this.updateToolbarState(),
            onSerializationFailure: (reason) => {
                this.serializationFailure = reason;
                this.updateStatus();
            },
            onImageImportFailure: (result) => this.reportImageImportFailure(result),
        });
        if (!this.isCurrent(epoch)) {
            editor.destroy();
            return;
        }
        this.editor = editor;
        try {
            await editor.mount();
            if (this.interactionBlocked) {
                editor.setInteractive?.(false);
            }
        } catch (error) {
            if (this.editor === editor) {
                this.editor = undefined;
            }
            editor.destroy();
            throw error;
        } finally {
            this.mounting = false;
            this.updateStatus();
            this.updateToolbarState();
        }
        if (!this.isCurrent(epoch)) {
            if (this.editor === editor) {
                this.editor = undefined;
            }
            editor.destroy();
        }
    }

    public async prepareTransition(reason: ModelTransitionReason): Promise<ModelTransitionResult> {
        if (this.mounting) {
            return {allowed: false, reason: "busy"};
        }
        if (this.titleInvalid || this.serializationFailure) {
            return {allowed: false, reason: "save-failed"};
        }
        const result = await (this.session?.flush(reason) ?? Promise.resolve({allowed: true} as ModelTransitionResult));
        this.updateStatus();
        return result;
    }

    public focus(): void {
        if (this.editor?.focus) {
            this.editor.focus();
            return;
        }
        this.titleElement?.focus?.();
    }

    public setWindowBarrier(active: boolean): void {
        const recoveryBarrier = this.session?.snapshot().recovery.interactionBarrierActive === true;
        this.setInteractionBlocked(active || recoveryBarrier);
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.epoch++;
        this.operationEpoch++;
        this.mounting = false;
        this.session?.destroy();
        this.session = undefined;
        this.serializationFailure = undefined;
        const editor = this.editor;
        this.editor = undefined;
        editor?.destroy();
        this.options.container.replaceChildren();
    }

    private renderShell(detail: ElementDetailView, initialHTML: string): void {
        this.options.container.replaceChildren();
        const root = document.createElement("div");
        root.className = "symemo-topic-html-surface fn__flex fn__flex-column fn__flex-1";

        const titleRow = document.createElement("div");
        titleRow.className = "symemo-topic-html-surface__title-row";
        const title = document.createElement("div");
        title.className = "symemo-topic-html-surface__title";
        title.setAttribute("contenteditable", "true");
        title.setAttribute("spellcheck", "true");
        title.setAttribute("data-placeholder", this.language("untitled") || "Untitled");
        title.textContent = detail.title;
        title.addEventListener("compositionstart", () => {
            this.composingTitle = true;
        });
        title.addEventListener("compositionend", () => {
            this.composingTitle = false;
            this.commitTitleInput();
        });
        title.addEventListener("input", () => {
            if (!this.composingTitle) {
                this.commitTitleInput();
            }
        });
        title.addEventListener("paste", (event) => {
            event.stopPropagation();
            event.preventDefault();
            if (this.interactionBlocked) {
                return;
            }
            const text = stripTitleControlCharacters((event as ClipboardEvent).clipboardData?.getData("text/plain") || "");
            document.execCommand("insertText", false, text);
            this.commitTitleInput();
        });
        const status = document.createElement("div");
        status.className = "symemo-topic-html-surface__status b3-label__text";
        status.textContent = this.languageAny(statusLanguageKeys.clean) || "";
        const actions = document.createElement("div");
        actions.className = "symemo-topic-html-surface__actions";
        titleRow.append(title, status, actions);

        const toolbar = document.createElement("div");
        toolbar.className = "symemo-topic-html-surface__toolbar";
        this.renderToolbar(toolbar);

        const viewport = document.createElement("div");
        viewport.className = "symemo-topic-html-surface__viewport fn__flex-1";
        const editorHost = document.createElement("div");
        editorHost.className = "symemo-topic-html-surface__editor b3-typography";
        editorHost.setAttribute("data-placeholder", this.language("symemoTopicBodyPlaceholder") || "");
        editorHost.innerHTML = initialHTML;
        editorHost.addEventListener("contextmenu", (event) => {
            void this.openPasteMenu(event as MouseEvent);
        });
        editorHost.addEventListener("paste", (event) => {
            void this.handleKeyboardPaste(event as ClipboardEvent);
        });
        viewport.append(editorHost);
        root.append(titleRow, toolbar, viewport);
        this.options.container.append(root);
        this.titleElement = title;
        this.editorHost = editorHost;
        this.statusElement = status;
        this.actionsElement = actions;
        this.toolbarElement = toolbar;
    }

    private renderToolbar(toolbar: HTMLElement): void {
        toolbar.append(
            this.createToolbarButton("undo", "iconUndo", ["undo"], () => this.executeFormatting({command: "undo"})),
            this.createToolbarButton("redo", "iconRedo", ["redo"], () => this.executeFormatting({command: "redo"})),
            this.createToolbarButton("image" as TopicFormattingAction["command"], "iconImage", ["image", "insertImage"], (button) => {
                this.openImagePicker(button);
            }),
            this.createHeadingControl(),
            this.createToolbarButton("bold", "iconBold", ["bold"], () => this.executeFormatting({command: "bold"})),
            this.createToolbarButton("italic", "iconItalic", ["italic"], () => this.executeFormatting({command: "italic"})),
            this.createToolbarButton("bulletList", "iconList", ["unorderedList", "list"], () => {
                this.executeFormatting({command: "bulletList"});
            }),
            this.createToolbarButton("orderedList", "iconOrderedList", ["ordered-list", "list"], () => {
                this.executeFormatting({command: "orderedList"});
            }),
            this.createToolbarButton("blockquote", "iconQuote", ["quote"], () => {
                this.executeFormatting({command: "blockquote"});
            }),
            this.createToolbarButton("code", "iconCode", ["code"], () => this.executeFormatting({command: "code"})),
            this.createToolbarButton("link", "iconLink", ["link", "hyperlink"], (button) => this.openLinkMenu(button)),
            this.createToolbarButton("unlink", "iconLinkOff", ["symemoUnlink", "unlink"], () => {
                this.executeFormatting({command: "unlink"});
            }),
            this.createToolbarButton("table", "iconTable", ["table"], (button) => this.openTableMenu(button)),
        );
        this.updateToolbarState();
    }

    private createToolbarButton(
        command: TopicFormattingAction["command"],
        icon: string,
        languageKeys: string[],
        handler: (button: HTMLButtonElement) => void,
    ): HTMLButtonElement {
        const button = document.createElement("button");
        button.className = "block__icon block__icon--show ariaLabel";
        button.setAttribute("type", "button");
        button.setAttribute("data-command", command);
        button.setAttribute("aria-label", this.languageAny(languageKeys) || command);
        button.setAttribute("disabled", "disabled");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", `#${icon}`);
        use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${icon}`);
        svg.append(use);
        button.append(svg);
        button.addEventListener("mousedown", (event) => this.preventDefault(event));
        button.addEventListener("click", (event) => {
            this.preventDefault(event);
            if (!button.getAttribute("disabled")) {
                handler(button);
            }
        });
        return button;
    }

    private createHeadingControl(): HTMLSelectElement {
        const select = document.createElement("select");
        select.className = "b3-select symemo-topic-html-surface__heading";
        select.setAttribute("data-command", "heading");
        select.setAttribute("aria-label", this.languageAny(["headings", "paragraph"]) || "Heading");
        select.setAttribute("disabled", "disabled");
        (["p", "h1", "h2", "h3", "h4", "h5", "h6"] as TopicBlockFormat[]).forEach((value, index) => {
            const option = document.createElement("option");
            option.setAttribute("value", value);
            option.textContent = value === "p"
                ? this.languageAny(["paragraph"]) || "Paragraph"
                : this.languageAny([`heading${index}`]) || `H${index}`;
            select.append(option);
        });
        select.value = "p";
        select.addEventListener("change", () => {
            const value = select.value as TopicBlockFormat;
            if (/^(p|h[1-6])$/.test(value)) {
                this.executeFormatting({command: "heading", value});
            }
        });
        return select;
    }

    private executeFormatting(action: TopicFormattingAction): void {
        if (!this.editor || this.mounting || this.destroyed || this.interactionBlocked) return;
        this.editor?.execFormatting?.(action);
        this.editor?.focus?.();
        this.updateToolbarState();
    }

    private openLinkMenu(anchor: HTMLElement): void {
        const epoch = this.operationEpoch;
        const bookmark = this.editor?.captureSelectionBookmark?.();
        const menu = new Menu();
        const form = this.createToolbarMenuForm();
        const href = this.createToolbarMenuInput("href", "url", this.languageAny(["hyperlink", "link"]) || "URL");
        const title = this.createToolbarMenuInput("title", "text", this.languageAny(["title"]) || "Title");
        const confirm = this.createToolbarMenuConfirm(() => {
            if (!this.isOperationCurrent(epoch)) {
                menu.remove();
                return;
            }
            const normalizedHref = href.value.trim();
            if (!isSafeTopicHref(normalizedHref)) {
                href.setAttribute("aria-invalid", "true");
                href.focus();
                return;
            }
            href.removeAttribute("aria-invalid");
            if (this.editor?.restoreSelectionBookmark && !this.editor.restoreSelectionBookmark(bookmark)) {
                menu.remove();
                return;
            }
            this.executeFormatting({
                command: "link",
                href: normalizedHref,
                title: title.value.trim() || undefined,
            });
            menu.remove();
        });
        form.append(href, title, confirm);
        menu.append(form);
        this.popupToolbarMenu(menu, anchor);
        href.focus();
    }

    private openTableMenu(anchor: HTMLElement): void {
        const epoch = this.operationEpoch;
        const bookmark = this.editor?.captureSelectionBookmark?.();
        const menu = new Menu();
        const form = this.createToolbarMenuForm();
        const rows = this.createToolbarMenuInput("rows", "number", this.languageAny(["row"]) || "Rows");
        const columns = this.createToolbarMenuInput("columns", "number", this.languageAny(["column"]) || "Columns");
        rows.value = "2";
        columns.value = "2";
        [rows, columns].forEach((input) => {
            input.setAttribute("min", "1");
            input.setAttribute("max", "20");
            input.setAttribute("step", "1");
        });
        const confirm = this.createToolbarMenuConfirm(() => {
            if (!this.isOperationCurrent(epoch)) {
                menu.remove();
                return;
            }
            const rowCount = Number(rows.value);
            const columnCount = Number(columns.value);
            const rowsValid = Number.isInteger(rowCount) && rowCount >= 1 && rowCount <= 20;
            const columnsValid = Number.isInteger(columnCount) && columnCount >= 1 && columnCount <= 20;
            if (rowsValid) rows.removeAttribute("aria-invalid");
            else rows.setAttribute("aria-invalid", "true");
            if (columnsValid) columns.removeAttribute("aria-invalid");
            else columns.setAttribute("aria-invalid", "true");
            if (!rowsValid || !columnsValid) {
                (rowsValid ? columns : rows).focus();
                return;
            }
            if (this.editor?.restoreSelectionBookmark && !this.editor.restoreSelectionBookmark(bookmark)) {
                menu.remove();
                return;
            }
            this.executeFormatting({command: "table", rows: rowCount, columns: columnCount});
            menu.remove();
        });
        form.append(rows, columns, confirm);
        menu.append(form);
        this.popupToolbarMenu(menu, anchor);
        rows.focus();
    }

    private createToolbarMenuForm(): HTMLElement {
        const form = document.createElement("div");
        form.className = "symemo-topic-html-surface__menu-form";
        return form;
    }

    private createToolbarMenuInput(field: string, type: string, placeholder: string): HTMLInputElement {
        const input = document.createElement("input");
        input.className = "b3-text-field";
        input.setAttribute("data-field", field);
        input.setAttribute("type", type);
        input.setAttribute("placeholder", placeholder);
        return input;
    }

    private createToolbarMenuConfirm(handler: () => void): HTMLButtonElement {
        const button = document.createElement("button");
        button.className = "b3-button b3-button--text";
        button.setAttribute("type", "button");
        button.setAttribute("data-action", "confirm");
        button.textContent = this.languageAny(["confirm"]) || "Confirm";
        button.addEventListener("click", (event) => {
            this.preventDefault(event);
            handler();
        });
        return button;
    }

    private popupToolbarMenu(menu: Menu, anchor: HTMLElement): void {
        const rect = anchor.getBoundingClientRect();
        menu.popup({x: rect.left, y: rect.bottom});
    }

    private updateToolbarState(): void {
        const toolbar = this.toolbarElement;
        if (!toolbar) {
            return;
        }
        const mounted = Boolean(this.editor) && !this.mounting && !this.destroyed && !this.interactionBlocked;
        const state = mounted ? this.editor?.queryFormatting?.() : undefined;
        const setButtonState = (command: string, enabled: boolean, active = false) => {
            const button = toolbar.querySelector(`[data-command="${command}"]`) as HTMLElement | null;
            if (!button) {
                return;
            }
            if (enabled) button.removeAttribute("disabled");
            else button.setAttribute("disabled", "disabled");
            button.classList.toggle("block__icon--active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        };
        setButtonState("undo", Boolean(state?.undoEnabled));
        setButtonState("redo", Boolean(state?.redoEnabled));
        setButtonState("image", mounted);
        setButtonState("bold", mounted, Boolean(state?.boldActive));
        setButtonState("italic", mounted, Boolean(state?.italicActive));
        setButtonState("bulletList", mounted, Boolean(state?.bulletListActive));
        setButtonState("orderedList", mounted, Boolean(state?.orderedListActive));
        setButtonState("blockquote", mounted, Boolean(state?.blockquoteActive));
        setButtonState("code", mounted, Boolean(state?.codeActive));
        setButtonState("link", mounted, Boolean(state?.linkActive));
        setButtonState("unlink", mounted && Boolean(state?.linkActive));
        setButtonState("table", mounted, Boolean(state?.tableActive));
        const heading = toolbar.querySelector('[data-command="heading"]') as HTMLSelectElement | null;
        if (heading) {
            heading.value = state?.blockFormat || "p";
            if (mounted) heading.removeAttribute("disabled");
            else heading.setAttribute("disabled", "disabled");
        }
    }

    private commitTitleInput(): void {
        if (!this.titleElement || !this.session || this.interactionBlocked) {
            return;
        }
        const normalized = normalizeTopicTitleInput(this.titleElement.textContent || "");
        if (!normalized.valid) {
            this.titleInvalid = true;
            this.titleElement.classList.add("symemo-topic-html-surface__title--invalid");
            this.updateStatus();
            return;
        }
        this.titleInvalid = false;
        this.titleElement.classList.remove("symemo-topic-html-surface__title--invalid");
        this.session.editTitle(normalized.title);
        this.updateStatus();
    }

    private updateStatus(): void {
        const session = this.session;
        const recovery = session?.snapshot().recovery;
        const status = recovery?.state === "preservedAsNew"
            ? "clean"
            : this.titleInvalid || this.serializationFailure ? "failed" : session?.getStatus() || "clean";
        if (this.statusElement) {
            this.statusElement.textContent = this.languageAny(statusLanguageKeys[status]) || status;
        }
        this.renderStatusActions(status);
        if (session) {
            const snapshot = session.snapshot();
            if (!this.titleInvalid && snapshot.title.state === "clean") {
                this.reconcileAcceptedTitle(snapshot.title.localValue);
            }
        }
        this.publishTransitionReadiness(status);
    }

    private renderStatusActions(status: AuthoringStatus): void {
        if (!this.actionsElement) {
            return;
        }
        this.actionsElement.replaceChildren();
        if (status === "failed") {
            const snapshot = this.session?.snapshot();
            if (this.serializationFailure || snapshot?.title.canRetry || snapshot?.material.canRetry) {
                this.actionsElement.append(this.createActionButton("retry", this.languageAny(["symemoTopicRetry", "retry"]) || "Retry", () => {
                    this.retryFailedSaves();
                }));
            }
        } else if (status === "conflict") {
            this.actionsElement.append(
                this.createActionButton("reload", this.languageAny(["symemoTopicReload", "symemoReloadTopic"]) || "Reload", () => {
                    void this.resolveConflict("reload");
                }),
                this.createActionButton("save-as-new", this.languageAny(["symemoTopicSaveAsNew", "symemoSaveAsNew"]) || "Save as new", () => {
                    void this.resolveConflict("save-as-new");
                }),
            );
        }
    }

    private async resolveConflict(action: "reload" | "save-as-new"): Promise<void> {
        const session = this.session;
        if (!session || this.interactionBlocked) {
            return;
        }
        this.setInteractionBlocked(true);
        this.updateStatus();

        const result = action === "reload"
            ? await session.reloadFromAuthority()
            : await session.saveAsNew();
        if (!this.session || this.session !== session || this.destroyed) {
            return;
        }

        if (result.ok && result.kind === "reloaded") {
            const snapshot = session.snapshot();
            this.editor?.replaceHTML?.(snapshot.material.localValue);
            this.reconcileAcceptedTitle(snapshot.title.localValue);
            this.setInteractionBlocked(false);
        } else if (result.ok && result.kind === "preservedAsNew") {
            this.options.onSaveAsNew?.(result.elementId);
        } else {
            this.setInteractionBlocked(false);
        }
        this.updateStatus();
    }

    private setInteractionBlocked(blocked: boolean): void {
        if (blocked && !this.interactionBlocked) {
            this.operationEpoch++;
        }
        this.interactionBlocked = blocked;
        if (this.titleElement) {
            this.titleElement.setAttribute("contenteditable", blocked ? "false" : "true");
            this.titleElement.setAttribute("aria-disabled", blocked ? "true" : "false");
        }
        this.editor?.setInteractive?.(!blocked);
        this.updateToolbarState();
        this.updateStatus();
    }

    private createActionButton(action: string, label: string, handler: () => void): HTMLElement {
        const button = document.createElement("button");
        button.className = "b3-button b3-button--text";
        button.setAttribute("type", "button");
        button.setAttribute("data-action", action);
        button.textContent = label;
        if (this.interactionBlocked) {
            button.setAttribute("disabled", "disabled");
        }
        button.addEventListener("click", (event) => {
            this.preventDefault(event);
            handler();
        });
        return button;
    }

    private preventDefault(event: Event): void {
        (event as Event & {preventDefault?: () => void}).preventDefault?.();
    }

    private async openPasteMenu(event: MouseEvent): Promise<void> {
        if (!this.editor || this.interactionBlocked) {
            return;
        }
        this.preventDefault(event);
        const epoch = this.operationEpoch;
        const bookmark = this.editor.captureSelectionBookmark?.();
        let snapshot: TopicClipboardSnapshot;
        try {
            snapshot = projectClipboardData(await readClipboard());
        } catch {
            return;
        }
        if (!this.isOperationCurrent(epoch)) {
            return;
        }

        const availability = getTopicPasteAvailability(snapshot);
        const menu = new Menu();
        [
            {
                command: "paste" as const,
                disabled: !availability.paste,
                icon: "iconPaste",
                id: "symemo-topic-paste",
                label: this.languageAny(["paste"]) || "Paste",
            },
            {
                command: "pasteAsPlainText" as const,
                disabled: !availability.pasteAsPlainText,
                icon: "iconEdit",
                id: "symemo-topic-paste-plain",
                label: this.languageAny(["pasteAsPlainText"]) || "Paste as plain text",
            },
            {
                command: "pasteAsHTML" as const,
                disabled: !availability.pasteAsHTML,
                icon: "iconHTML5",
                id: "symemo-topic-paste-html",
                label: this.languageAny(["symemoPasteAsHTML"]) || "Paste as HTML",
            },
        ].forEach((item) => menu.append(new MenuItem({
            disabled: item.disabled,
            icon: item.icon,
            id: item.id,
            label: item.label,
            click: () => {
                void this.applyPaste(snapshot, item.command, bookmark, epoch);
            },
        }).element));
        menu.popup({x: event.clientX || 0, y: event.clientY || 0});
    }

    private async handleKeyboardPaste(event: ClipboardEvent): Promise<void> {
        if (!this.editor || this.interactionBlocked) {
            return;
        }
        this.preventDefault(event);
        const files = Array.from(event.clipboardData?.files ?? []) as File[];
        if (files.length > 0) {
            const result = await this.editor.insertImageFiles?.(files);
            this.reportImageImportFailure(result);
            return;
        }
        const epoch = this.operationEpoch;
        const bookmark = this.editor.captureSelectionBookmark?.();
        await this.applyPaste(projectClipboardEvent(event), "paste", bookmark, epoch);
    }

    private openImagePicker(anchor: HTMLElement): void {
        if (!this.editor || this.interactionBlocked || this.destroyed) return;
        const input = document.createElement("input");
        input.type = "file";
        input.setAttribute("type", "file");
        input.accept = "image/*";
        input.setAttribute("accept", "image/*");
        input.multiple = true;
        input.setAttribute("multiple", "multiple");
        input.setAttribute("aria-hidden", "true");
        input.style.display = "none";
        input.addEventListener("change", (event) => {
            const target = event.target as HTMLInputElement | null;
            const files = Array.from(target?.files ?? input.files ?? []) as File[];
            if (files.length > 0) {
                void this.editor?.insertImageFiles?.(files).then((result) => {
                    this.reportImageImportFailure(result);
                });
            }
            input.remove();
        });
        anchor.parentElement?.append(input);
        (input as HTMLInputElement & {click?: () => void}).click?.();
    }

    private reportImageImportFailure(result?: import("./assetStore").AssetImportResult): void {
        if (!result || result.ok || this.destroyed || !this.statusElement) return;
        this.statusElement.textContent = this.languageAny(["symemoImageUploadFailed"]) || "Image upload failed.";
    }

    private async applyPaste(
        snapshot: TopicClipboardSnapshot,
        command: TopicPasteCommand,
        bookmark: unknown,
        epoch: number,
    ): Promise<void> {
        const html = await this.resolvePasteHTML(selectTopicPasteFlavor(snapshot, command));
        if (!html || !this.isOperationCurrent(epoch)) {
            return;
        }
        if (this.editor?.restoreSelectionBookmark && !this.editor.restoreSelectionBookmark(bookmark)) {
            return;
        }
        this.editor?.insertHTML?.(html);
    }

    private async resolvePasteHTML(flavor: TopicPasteFlavor): Promise<string> {
        if (flavor.kind === "none") {
            return "";
        }
        if (flavor.kind === "html") {
            return filterTopicHTMLIngress(flavor.html, this.options.topicDomParser);
        }
        if (flavor.kind === "plainText") {
            return filterTopicHTMLIngress(plainTextToHTML(flavor.text), this.options.topicDomParser);
        }
        const html = await this.convertMarkdown(flavor.markdown);
        if (!html) {
            return "";
        }
        return filterTopicHTMLIngress(
            mapMarkdownFormulaHTML(html, this.options.topicDomParser),
            this.options.topicDomParser,
        );
    }

    private convertMarkdown(markdown: string): Promise<SiyuanMarkdownHTMLFragment | undefined> {
        return new Promise((resolve) => {
            try {
                fetchPost(LUTE_MARKDOWN_ROUTE, {markdown, mode: ""}, (response) => {
                    resolve(response?.code === 0 && typeof response.data?.html === "string"
                        ? {provenance: "siyuan-md2html", html: response.data.html}
                        : undefined);
                });
            } catch {
                resolve(undefined);
            }
        });
    }

    private languageAny(keys: string[]): string {
        for (const key of keys) {
            const value = this.language(key);
            if (value) {
                return value;
            }
        }
        return "";
    }

    private retryFailedSaves(): void {
        if (this.interactionBlocked || this.destroyed) {
            return;
        }
        if (this.serializationFailure) {
            const editorSnapshot = this.editor?.getAuthoritativeHTML?.();
            if (!editorSnapshot?.ok) {
                this.updateStatus();
                return;
            }
            this.serializationFailure = undefined;
            this.session?.editMaterial(editorSnapshot.html);
            this.updateStatus();
            return;
        }
        const snapshot = this.session?.snapshot();
        if (!snapshot || !this.session) {
            return;
        }
        if (snapshot.title.canRetry) {
            this.session.retryFailed("title");
        }
        if (snapshot.material.canRetry) {
            this.session.retryFailed("material");
        }
        this.updateStatus();
    }

    private reconcileAcceptedTitle(title: string): void {
        if (this.titleElement && this.titleElement.textContent !== title) {
            this.titleElement.textContent = title;
        }
        if (title !== this.lastPublishedTitle) {
            this.lastPublishedTitle = title;
            this.options.onTitleChange?.(title);
        }
    }

    private publishTransitionReadiness(status: AuthoringStatus): void {
        const ready = !this.mounting && !this.titleInvalid && status === "clean";
        if (ready === this.lastTransitionReady) {
            return;
        }
        this.lastTransitionReady = ready;
        this.options.onTransitionReadyChange?.(ready);
    }

    private queueStatusRefresh(): void {
        setTimeout(() => {
            if (!this.destroyed) {
                this.updateStatus();
            }
        }, 0);
    }

    private readonly saveTitle = async (
        elementId: string,
        expectedTitleRevision: string,
        title: string,
    ): Promise<ElementChangeResult> => {
        this.queueStatusRefresh();
        try {
            return await renameElement(elementId, expectedTitleRevision, title);
        } finally {
            this.queueStatusRefresh();
        }
    };

    private readonly saveMaterial = async (
        elementId: string,
        expectedMaterialRevision: string,
        html: string,
    ): Promise<ElementChangeResult> => {
        this.queueStatusRefresh();
        try {
            return await saveTopicHTML(elementId, expectedMaterialRevision, html);
        } finally {
            this.queueStatusRefresh();
        }
    };

    private isCurrent(epoch: number): boolean {
        return !this.destroyed && this.epoch === epoch;
    }

    private isOperationCurrent(epoch: number): boolean {
        return !this.destroyed && !this.interactionBlocked && this.operationEpoch === epoch;
    }

    private readonly createDefaultEditor: TopicHtmlEditorFactory = async (context) => {
        const module = await import("./TinyMceTopicEditorAdapter");
        const adapter = new module.TinyMceTopicEditorAdapter({
            host: context.host,
            initialHTML: context.initialHTML,
            renderFormula: mathRender,
            onDirty: context.onDirty,
            onCommandStateChange: context.onCommandStateChange,
            onSerializationFailure: context.onSerializationFailure,
            onImageImportFailure: context.onImageImportFailure,
        });
        return {
            mount: () => adapter.mount(),
            destroy: () => adapter.destroy(),
            focus: () => adapter.mountedEditor?.targetElm?.focus?.(),
            execFormatting: (action) => adapter.execFormatting(action),
            queryFormatting: () => adapter.queryFormatting(),
            insertHTML: (html) => adapter.insertHTML(html),
            insertImageFiles: (files) => adapter.insertImageFiles(files),
            captureSelectionBookmark: () => adapter.captureSelection(),
            restoreSelectionBookmark: (bookmark) => adapter.restoreSelection(bookmark),
            replaceHTML: (html) => adapter.replaceHTML(html),
            setInteractive: (enabled) => adapter.setInteractive(enabled),
            reconcileAuthorityMetadata: (canonicalHTML, assignments) => {
                adapter.reconcileAuthorityMetadata(canonicalHTML, assignments);
            },
            getAuthoritativeHTML: () => adapter.getAuthoritativeHTML(),
        };
    };
}
