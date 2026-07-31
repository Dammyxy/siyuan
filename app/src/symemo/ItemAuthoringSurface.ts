import {getItemAuthoring, saveItemQA} from "./api";
import {ItemAuthoringSession, ItemAuthoringSnapshot} from "./itemAuthoring";
import type {ElementDetailView, ModelTransitionReason, ModelTransitionResult} from "./types";

export interface ItemAuthoringSurfaceOptions {
    container: HTMLElement;
    language?: (key: string) => string;
    debounceMs?: number;
    onTransitionReadyChange?: (ready: boolean) => void;
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
    private statusElement?: HTMLElement;
    private actionsElement?: HTMLElement;
    private detail?: ElementDetailView;
    private destroyed = false;
    private readOnly = false;
    private interactionBlocked = false;
    private epoch = 0;
    private lastReady?: boolean;

    constructor(private readonly options: ItemAuthoringSurfaceOptions) {
        this.language = options.language || defaultLanguage;
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
        this.promptElement?.focus();
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
            root.append(promptLabel, prompt, answerLabel, answer);
            this.promptElement = prompt;
            this.answerElement = answer;
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

    private createReadOnlySection(key: string, role: string, value: string): HTMLElement {
        const section = document.createElement("section");
        const heading = document.createElement("h2");
        heading.textContent = this.language(key);
        const content = document.createElement("div");
        content.setAttribute("data-role", role);
        content.textContent = value;
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
        for (const element of [this.promptElement, this.answerElement]) {
            if (!element) continue;
            if (this.interactionBlocked || this.session?.snapshot().state === "acceptanceUnknown" ||
                this.session?.snapshot().state === "acceptedRecovering") element.setAttribute("disabled", "disabled");
            else element.removeAttribute("disabled");
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
