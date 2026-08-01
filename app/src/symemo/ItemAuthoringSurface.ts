import {getItemAuthoring, saveItemQA} from "./api";
import {ItemAuthoringSession, ItemAuthoringSnapshot} from "./itemAuthoring";
import {AssetImportResult, importImages} from "./assetStore";
import {filterItemHTMLIngress} from "./itemHtmlIngress";
import type {TopicDomParser} from "./topicDom";
import {captureItemEditorSelection, insertItemHTMLAtSelection, ItemEditorSelection} from "./itemAuthoring";
import type {ElementDetailView, ModelTransitionReason, ModelTransitionResult} from "./types";

export interface ItemAuthoringSurfaceOptions {
    container: HTMLElement;
    language?: (key: string) => string;
    debounceMs?: number;
    onTransitionReadyChange?: (ready: boolean) => void;
    uploadImages?: (files: File[], selection: unknown) => Promise<AssetImportResult>;
    topicDomParser?: TopicDomParser;
}

const defaultLanguage = (key: string): string => window.siyuan?.languages?.[key] || "";

const statusKeys: Record<ItemAuthoringSnapshot["state"], string> = {
    loading: "symemoItemAuthoringLoading",
    clean: "symemoSaved",
    pending: "symemoSavePending",
    saving: "symemoSaving",
    invalid: "symemoItemQAInvalid",
    failed: "symemoSaveFailed",
    acceptanceUnknown: "symemoSaveFailed",
    conflict: "symemoRevisionConflict",
    acceptedRecovering: "symemoAcceptedRecovering",
};

export class ItemAuthoringSurface {
    private readonly language: (key: string) => string;
    private session?: ItemAuthoringSession;
    private promptElement?: HTMLTextAreaElement;
    private answerElement?: HTMLTextAreaElement;
    private promptEditor?: HTMLElement;
    private answerEditor?: HTMLElement;
    private promptImageButton?: HTMLButtonElement;
    private answerImageButton?: HTMLButtonElement;
    private statusElement?: HTMLElement;
    private actionsElement?: HTMLElement;
    private detail?: ElementDetailView;
    private destroyed = false;
    private readOnly = false;
    private interactionBlocked = false;
    private epoch = 0;
    private lastReady?: boolean;
    private readonly uploadImages: NonNullable<ItemAuthoringSurfaceOptions["uploadImages"]>;

    constructor(private readonly options: ItemAuthoringSurfaceOptions) {
        this.language = options.language || defaultLanguage;
        this.uploadImages = options.uploadImages ?? ((files, selection) => importImages(
            files,
            selection && typeof selection === "object" ? selection as Record<string, unknown> : {},
        ));
    }

    public async mount(detail: ElementDetailView): Promise<void> {
        this.destroyed = false;
        this.detail = detail;
        this.readOnly = window.siyuan?.config?.readonly === true;
        this.lastReady = undefined;
        const epoch = ++this.epoch;
        this.renderLoading();
        const session = new ItemAuthoringSession({
            elementId: detail.elementId,
            getItemAuthoring,
            saveItemQA,
            debounceMs: this.options.debounceMs,
            onChange: (snapshot) => {
                if (this.isCurrent(epoch, session)) {
                    this.updateFromSnapshot(snapshot);
                }
            },
        });
        this.session = session;
        const result = await session.load();
        if (!this.isCurrent(epoch, session)) {
            return;
        }
        if (!result.ok) {
            this.renderLoadFailure(epoch, session);
            return;
        }
        this.renderAuthoring(session.snapshot());
    }

    public async prepareTransition(reason: ModelTransitionReason): Promise<ModelTransitionResult> {
        if (this.destroyed) {
            return {allowed: false, reason: "unavailable"};
        }
        if (this.readOnly) {
            return {allowed: true};
        }
        const result = await (this.session?.flush(reason) || Promise.resolve({allowed: false, reason: "unavailable"} as ModelTransitionResult));
        if (this.session) {
            this.updateFromSnapshot(this.session.snapshot());
        }
        return result;
    }

    public focus(): void {
        (this.promptEditor || this.promptElement)?.focus();
    }

    public setWindowBarrier(active: boolean): void {
        this.interactionBlocked = active;
        this.updateInteraction();
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.epoch++;
        this.session?.destroy();
        this.session = undefined;
        this.promptElement = undefined;
        this.answerElement = undefined;
        this.promptEditor = undefined;
        this.answerEditor = undefined;
        this.promptImageButton = undefined;
        this.answerImageButton = undefined;
        this.statusElement = undefined;
        this.actionsElement = undefined;
        this.options.container.replaceChildren();
        this.publishReady(false);
    }

    private isCurrent(epoch: number, session: ItemAuthoringSession): boolean {
        return !this.destroyed && this.epoch === epoch && this.session === session;
    }

    private renderLoading(): void {
        this.options.container.replaceChildren();
        this.promptElement = undefined;
        this.answerElement = undefined;
        this.promptEditor = undefined;
        this.answerEditor = undefined;
        this.promptImageButton = undefined;
        this.answerImageButton = undefined;
        this.actionsElement = undefined;
        const status = document.createElement("div");
        status.setAttribute("data-role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = this.language("symemoItemAuthoringLoading");
        this.options.container.append(status);
        this.statusElement = status;
        this.publishReady(false);
    }

    private renderLoadFailure(epoch: number, session: ItemAuthoringSession): void {
        this.options.container.replaceChildren();
        this.promptElement = undefined;
        this.answerElement = undefined;
        this.promptEditor = undefined;
        this.answerEditor = undefined;
        this.promptImageButton = undefined;
        this.answerImageButton = undefined;
        const root = document.createElement("div");
        root.className = "symemo-item-authoring fn__flex fn__flex-column fn__flex-1";
        const status = document.createElement("div");
        status.setAttribute("data-role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = this.language("symemoItemAuthoringUnavailable") || this.language("symemoSaveFailed");
        const actions = document.createElement("div");
        actions.className = "symemo-item-authoring__actions";
        actions.append(this.createAction("retry", this.language("retry"), () => {
            if (this.interactionBlocked) return;
            void session.reload().then((result) => {
                if (!this.isCurrent(epoch, session)) return;
                if (result.ok) this.renderAuthoring(session.snapshot());
                else this.renderLoadFailure(epoch, session);
            });
        }));
        root.append(status, actions);
        this.options.container.append(root);
        this.statusElement = status;
        this.actionsElement = actions;
        this.updateInteraction();
        this.publishReady(false);
    }

    private renderAuthoring(snapshot: ItemAuthoringSnapshot): void {
        this.options.container.replaceChildren();
        this.promptElement = undefined;
        this.answerElement = undefined;
        this.promptEditor = undefined;
        this.answerEditor = undefined;
        this.promptImageButton = undefined;
        this.answerImageButton = undefined;
        const root = document.createElement("div");
        root.className = "symemo-item-authoring fn__flex fn__flex-column fn__flex-1";
        if (this.readOnly) {
            root.append(
                this.createReadOnlySection("symemoQuestion", "prompt-readonly", snapshot.localPrompt),
                this.createReadOnlySection("symemoAnswer", "answer-readonly", snapshot.localAnswer),
            );
        } else {
            const promptId = `symemo-item-prompt-${this.detail?.elementId || ""}`;
            const answerId = `symemo-item-answer-${this.detail?.elementId || ""}`;
            const promptLabel = this.createLabel("symemoQuestion", "prompt-label", promptId);
            const prompt = this.createTextarea("prompt", promptId, snapshot.localPrompt);
            const answerLabel = this.createLabel("symemoAnswer", "answer-label", answerId);
            const answer = this.createTextarea("answer", answerId, snapshot.localAnswer);
            const promptHTML = this.isHTMLMaterial(snapshot.localPrompt)
                ? this.createHTMLField("prompt", `${promptId}-editor`, snapshot.localPrompt)
                : undefined;
            const answerHTML = this.isHTMLMaterial(snapshot.localAnswer)
                ? this.createHTMLField("answer", `${answerId}-editor`, snapshot.localAnswer)
                : undefined;
            const promptImageButton = promptHTML ? this.createImagePicker("prompt", promptHTML) : undefined;
            const answerImageButton = answerHTML ? this.createImagePicker("answer", answerHTML) : undefined;
            if (promptHTML) {
                prompt.setAttribute("hidden", "true");
                root.append(promptLabel, promptHTML, promptImageButton!, prompt);
            } else {
                root.append(promptLabel, prompt);
            }
            if (answerHTML) {
                answer.setAttribute("hidden", "true");
                root.append(answerLabel, answerHTML, answerImageButton!, answer);
            } else {
                root.append(answerLabel, answer);
            }
            this.promptElement = prompt;
            this.answerElement = answer;
            this.promptEditor = promptHTML;
            this.answerEditor = answerHTML;
            this.promptImageButton = promptImageButton;
            this.answerImageButton = answerImageButton;
        }
        const status = document.createElement("div");
        status.setAttribute("data-role", "status");
        status.setAttribute("aria-live", "polite");
        const actions = document.createElement("div");
        actions.className = "symemo-item-authoring__actions";
        root.append(status, actions);
        this.options.container.append(root);
        this.statusElement = status;
        this.actionsElement = actions;
        this.updateFromSnapshot(snapshot);
    }

    private createLabel(key: string, role: string, target: string): HTMLLabelElement {
        const label = document.createElement("label");
        label.setAttribute("data-role", role);
        label.setAttribute("for", target);
        label.textContent = this.language(key);
        return label;
    }

    private createTextarea(role: "prompt" | "answer", id: string, value: string): HTMLTextAreaElement {
        const textarea = document.createElement("textarea");
        textarea.className = "b3-text-field fn__block symemo-item-authoring__field";
        textarea.setAttribute("data-role", role);
        textarea.setAttribute("id", id);
        textarea.value = value;
        textarea.addEventListener("input", () => {
            if (this.interactionBlocked) {
                return;
            }
            if (role === "prompt") {
                this.session?.editPrompt(textarea.value);
            } else {
                this.session?.editAnswer(textarea.value);
            }
        });
        return textarea;
    }

    private createHTMLField(role: "prompt" | "answer", id: string, value: string): HTMLElement {
        const editor = document.createElement("div");
        editor.className = "b3-text-field fn__block symemo-item-authoring__html-field";
        editor.setAttribute("data-role", `${role}-editor`);
        editor.setAttribute("id", id);
        editor.setAttribute("contenteditable", "true");
        editor.setAttribute("spellcheck", "true");
        editor.innerHTML = filterItemHTMLIngress(value, this.options.topicDomParser);
        editor.addEventListener("input", () => {
            if (this.interactionBlocked) return;
            if (role === "prompt") this.session?.editPrompt(editor.innerHTML);
            else this.session?.editAnswer(editor.innerHTML);
        });
        editor.addEventListener("paste", (event) => {
            const files = Array.from((event as ClipboardEvent).clipboardData?.files ?? []) as File[];
            if (files.length === 0) return;
            const selection = captureItemEditorSelection(editor);
            event.preventDefault();
            void this.insertImageFiles(role, editor, files, selection);
        });
        editor.addEventListener("drop", (event) => {
            const files = Array.from((event as DragEvent).dataTransfer?.files ?? []) as File[];
            if (files.length === 0) return;
            const selection = captureItemEditorSelection(editor);
            event.preventDefault();
            void this.insertImageFiles(role, editor, files, selection);
        });
        return editor;
    }

    private createImagePicker(role: "prompt" | "answer", editor: HTMLElement): HTMLButtonElement {
        const button = document.createElement("button");
        button.className = "b3-button b3-button--outline symemo-item-authoring__image-button";
        button.setAttribute("type", "button");
        button.setAttribute("data-action", `insert-${role}-image`);
        button.setAttribute("aria-label", this.language("symemoInsertImage") || "Insert image");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", "#iconImage");
        use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "#iconImage");
        svg.append(use);
        button.append(svg);
        button.addEventListener("click", () => {
            const selection = captureItemEditorSelection(editor);
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.multiple = true;
            input.setAttribute("type", "file");
            input.setAttribute("accept", "image/*");
            input.setAttribute("multiple", "multiple");
            input.style.display = "none";
            input.addEventListener("change", (event) => {
                const target = event.target as HTMLInputElement | null;
                const files = Array.from(target?.files ?? input.files ?? []) as File[];
                if (files.length > 0) void this.insertImageFiles(role, editor, files, selection);
                input.remove();
            });
            button.parentElement?.append(input);
            (input as HTMLInputElement & {click?: () => void}).click?.();
        });
        return button;
    }

    private async insertImageFiles(
        role: "prompt" | "answer",
        editor: HTMLElement,
        files: File[],
        selection?: ItemEditorSelection,
    ): Promise<void> {
        const result = await this.uploadImages(files, selection || {});
        if (!result.ok) {
            if (this.statusElement) {
                this.statusElement.textContent = this.language("symemoImageUploadFailed") || "Image upload failed.";
            }
            return;
        }
        if (this.destroyed || this.interactionBlocked) return;
        const html = result.references.map((reference) => `<img src="${reference}" alt="">`).join("");
        insertItemHTMLAtSelection(editor, html, selection);
        if (role === "prompt") this.session?.editPrompt(editor.innerHTML);
        else this.session?.editAnswer(editor.innerHTML);
    }

    private isHTMLMaterial(value: string): boolean {
        return /<[a-z][\s\S]*>/i.test(value);
    }

    private createReadOnlySection(key: string, role: string, value: string): HTMLElement {
        const section = document.createElement("section");
        const heading = document.createElement("h2");
        heading.textContent = this.language(key);
        const content = document.createElement("div");
        content.setAttribute("data-role", role);
        if (this.isHTMLMaterial(value)) content.innerHTML = filterItemHTMLIngress(value, this.options.topicDomParser);
        else content.textContent = value;
        section.append(heading, content);
        return section;
    }

    private updateFromSnapshot(snapshot: ItemAuthoringSnapshot): void {
        if (this.destroyed) {
            return;
        }
        if (this.promptElement && this.promptElement.value !== snapshot.localPrompt) {
            this.promptElement.value = snapshot.localPrompt;
        }
        if (this.answerElement && this.answerElement.value !== snapshot.localAnswer) {
            this.answerElement.value = snapshot.localAnswer;
        }
        if (this.promptEditor && this.promptEditor.innerHTML !== snapshot.localPrompt) {
            this.promptEditor.innerHTML = filterItemHTMLIngress(snapshot.localPrompt, this.options.topicDomParser);
        }
        if (this.answerEditor && this.answerEditor.innerHTML !== snapshot.localAnswer) {
            this.answerEditor.innerHTML = filterItemHTMLIngress(snapshot.localAnswer, this.options.topicDomParser);
        }
        if (this.statusElement) {
            this.statusElement.textContent = this.readOnly
                ? this.language("symemoItemReadOnly")
                : this.language(statusKeys[snapshot.state]) || this.language("symemoItemAuthoringUnavailable");
        }
        this.renderActions(snapshot);
        this.updateInteraction();
        this.publishReady(this.readOnly || snapshot.state === "clean");
    }

    private renderActions(snapshot: ItemAuthoringSnapshot): void {
        if (!this.actionsElement) {
            return;
        }
        this.actionsElement.replaceChildren();
        if (snapshot.state === "failed" || snapshot.state === "acceptanceUnknown") {
            this.actionsElement.append(this.createAction("retry", this.language("retry"), () => {
                this.session?.retry();
                if (this.session) this.updateFromSnapshot(this.session.snapshot());
            }));
        }
        if (snapshot.state === "conflict") {
            const compare = document.createElement("div");
            compare.setAttribute("data-role", "compare");
            compare.textContent = snapshot.conflictRevision || "";
            this.actionsElement.append(compare, this.createAction("reload", this.language("symemoReloadItem"), () => {
                void this.session?.reload().then(() => {
                    if (this.session) this.updateFromSnapshot(this.session.snapshot());
                });
            }));
        }
    }

    private createAction(action: string, label: string, callback: () => void): HTMLButtonElement {
        const button = document.createElement("button");
        button.className = "b3-button b3-button--outline";
        button.setAttribute("data-action", action);
        button.textContent = label;
        button.addEventListener("click", callback);
        return button;
    }

    private updateInteraction(): void {
        const blocked = this.interactionBlocked || this.session?.snapshot().state === "acceptanceUnknown" ||
            this.session?.snapshot().state === "acceptedRecovering";
        for (const element of [this.promptElement, this.answerElement, this.promptEditor, this.answerEditor,
            this.promptImageButton, this.answerImageButton]) {
            if (!element) continue;
            if (blocked) {
                element.setAttribute("disabled", "disabled");
                element.setAttribute("aria-disabled", "true");
                if (element === this.promptEditor || element === this.answerEditor) {
                    element.setAttribute("contenteditable", "false");
                }
            } else {
                element.removeAttribute("disabled");
                element.removeAttribute("aria-disabled");
                if (element === this.promptEditor || element === this.answerEditor) {
                    element.setAttribute("contenteditable", "true");
                }
            }
        }
        this.actionsElement?.querySelectorAll("button").forEach((button) => {
            if (this.interactionBlocked) button.setAttribute("disabled", "disabled");
            else button.removeAttribute("disabled");
        });
    }

    private publishReady(ready: boolean): void {
        if (ready === this.lastReady) {
            return;
        }
        this.lastReady = ready;
        this.options.onTransitionReadyChange?.(ready);
    }
}
