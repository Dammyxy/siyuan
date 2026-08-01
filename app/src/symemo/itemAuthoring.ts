import type {
    ItemAuthoringResult,
    ItemQAChangeResult,
    ModelTransitionReason,
    ModelTransitionResult,
} from "./types";

export interface ItemEditorSelection {
    range?: Range;
}

export const captureItemEditorSelection = (editor: HTMLElement): ItemEditorSelection => {
    const selection = typeof window !== "undefined" ? window.getSelection?.() : undefined;
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
    if (!range || !editor.contains?.(range.commonAncestorContainer)) return {};
    return {range: range.cloneRange()};
};

export const insertItemHTMLAtSelection = (
    editor: HTMLElement,
    html: string,
    selection: ItemEditorSelection = {},
): void => {
    const range = selection.range;
    if (!range || !editor.contains?.(range.commonAncestorContainer) || !range.createContextualFragment) {
        editor.innerHTML += html;
        return;
    }
    const fragment = range.createContextualFragment(html);
    range.deleteContents();
    range.insertNode(fragment);
    range.collapse(false);
    const currentSelection = typeof window !== "undefined" ? window.getSelection?.() : undefined;
    if (currentSelection) {
        currentSelection.removeAllRanges();
        currentSelection.addRange(range);
    }
};

export type ItemAuthoringState =
    | "loading"
    | "clean"
    | "pending"
    | "saving"
    | "invalid"
    | "failed"
    | "acceptanceUnknown"
    | "conflict"
    | "acceptedRecovering";

export interface ItemAuthoringSnapshot {
    state: ItemAuthoringState;
    localPrompt: string;
    localAnswer: string;
    baselinePrompt: string;
    baselineAnswer: string;
    revision: string;
    localGeneration: number;
    acknowledgedGeneration: number;
    conflictRevision?: string;
}

export interface ItemAuthoringSessionOptions {
    elementId: string;
    getItemAuthoring: (elementId: string) => Promise<ItemAuthoringResult>;
    saveItemQA: (elementId: string, revision: string, prompt: string, answer: string) => Promise<ItemQAChangeResult>;
    debounceMs?: number;
    onChange?: (snapshot: ItemAuthoringSnapshot) => void;
}

export class ItemAuthoringSession {
    private readonly elementId: string;
    private readonly getAuthoring: NonNullable<ItemAuthoringSessionOptions["getItemAuthoring"]>;
    private readonly saveQA: NonNullable<ItemAuthoringSessionOptions["saveItemQA"]>;
    private readonly debounceMs: number;
    private readonly onChange?: ItemAuthoringSessionOptions["onChange"];
    private state: ItemAuthoringState = "loading";
    private localPrompt = "";
    private localAnswer = "";
    private baselinePrompt = "";
    private baselineAnswer = "";
    private revision = "";
    private localGeneration = 0;
    private acknowledgedGeneration = 0;
    private conflictRevision?: string;
    private uncertainSubmission?: {revision: string; prompt: string; answer: string};
    private timer?: ReturnType<typeof setTimeout>;
    private flushPromise?: Promise<ModelTransitionResult>;
    private destroyed = false;

    constructor(options: ItemAuthoringSessionOptions) {
        this.elementId = options.elementId;
        this.getAuthoring = options.getItemAuthoring;
        this.saveQA = options.saveItemQA;
        this.debounceMs = options.debounceMs ?? 800;
        this.onChange = options.onChange;
    }

    public snapshot(): ItemAuthoringSnapshot {
        const snapshot: ItemAuthoringSnapshot = {
            state: this.state,
            localPrompt: this.localPrompt,
            localAnswer: this.localAnswer,
            baselinePrompt: this.baselinePrompt,
            baselineAnswer: this.baselineAnswer,
            revision: this.revision,
            localGeneration: this.localGeneration,
            acknowledgedGeneration: this.acknowledgedGeneration,
        };
        if (this.conflictRevision) {
            snapshot.conflictRevision = this.conflictRevision;
        }
        return snapshot;
    }

    public async load(): Promise<{ok: boolean}> {
        if (this.destroyed) {
            return {ok: false};
        }
        this.clearTimer();
        this.state = "loading";
        this.publish();
        const result = await this.getAuthoring(this.elementId);
        if (this.destroyed) {
            return {ok: false};
        }
        if (result.ok === false) {
            this.state = "failed";
            this.publish();
            return {ok: false};
        }
        const {prompt, answer, contentRevision} = result.authoring;
        this.localPrompt = prompt;
        this.localAnswer = answer;
        this.baselinePrompt = prompt;
        this.baselineAnswer = answer;
        this.revision = contentRevision;
        this.localGeneration = 0;
        this.acknowledgedGeneration = 0;
        this.conflictRevision = undefined;
        this.uncertainSubmission = undefined;
        this.state = "clean";
        this.publish();
        return {ok: true};
    }

    public editPrompt(prompt: string): void {
        if (this.destroyed || this.state === "acceptedRecovering" || this.state === "acceptanceUnknown") {
            return;
        }
        this.localPrompt = prompt;
        this.markEdited();
    }

    public editAnswer(answer: string): void {
        if (this.destroyed || this.state === "acceptedRecovering" || this.state === "acceptanceUnknown") {
            return;
        }
        this.localAnswer = answer;
        this.markEdited();
    }

    public flush(reason: ModelTransitionReason): Promise<ModelTransitionResult> {
        void reason;
        this.clearTimer();
        if (this.flushPromise) {
            return this.flushPromise;
        }
        this.flushPromise = this.flushPending().finally(() => {
            this.flushPromise = undefined;
        });
        return this.flushPromise;
    }

    public retry(): boolean {
        if (this.destroyed || (this.state !== "failed" && this.state !== "acceptanceUnknown")) {
            return false;
        }
        if (this.uncertainSubmission) {
            this.revision = this.uncertainSubmission.revision;
            this.localPrompt = this.uncertainSubmission.prompt;
            this.localAnswer = this.uncertainSubmission.answer;
            this.localGeneration = Math.max(this.localGeneration, this.acknowledgedGeneration + 1);
        }
        this.state = this.hasValidPair() ? "pending" : "invalid";
        this.publish();
        return true;
    }

    public async reload(): Promise<{ok: boolean}> {
        if (this.destroyed) {
            return {ok: false};
        }
        if (this.state === "acceptanceUnknown") {
            return {ok: false};
        }
        if (this.state !== "acceptedRecovering" && this.state !== "conflict" && this.state !== "failed" &&
            this.localGeneration > this.acknowledgedGeneration) {
            const transition = await this.flush("surface-replacement");
            if (!transition.allowed) {
                return {ok: false};
            }
        }
        return this.load();
    }

    public destroy(): void {
        this.destroyed = true;
        this.clearTimer();
    }

    private markEdited(): void {
        this.localGeneration++;
        this.conflictRevision = undefined;
        this.state = this.hasValidPair() ? "pending" : "invalid";
        this.publish();
        this.scheduleFlush();
    }

    private hasValidPair(): boolean {
        return this.localPrompt.trim().length > 0 && this.localAnswer.trim().length > 0;
    }

    private scheduleFlush(): void {
        this.clearTimer();
        if (this.debounceMs < 0 || !this.hasValidPair() || this.destroyed) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush("surface-replacement");
        }, this.debounceMs);
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private async flushPending(): Promise<ModelTransitionResult> {
        if (this.destroyed || this.state === "loading" || this.state === "acceptedRecovering" || this.state === "acceptanceUnknown") {
            return {allowed: false, reason: "unavailable"};
        }
        if (this.state === "conflict") {
            return {allowed: false, reason: "conflict"};
        }
        if (!this.hasValidPair()) {
            this.state = "invalid";
            this.publish();
            return {allowed: false, reason: "save-failed"};
        }
        while (!this.destroyed && this.localGeneration > this.acknowledgedGeneration) {
            const generation = this.localGeneration;
            const prompt = this.localPrompt;
            const answer = this.localAnswer;
            const revision = this.revision;
            this.state = "saving";
            this.publish();
            const result = await this.saveQA(this.elementId, revision, prompt, answer);
            if (this.destroyed) {
                return {allowed: false, reason: "unavailable"};
            }
            if (result.ok === false) {
                if (result.failure.kind === "conflict") {
                    this.state = "conflict";
                    this.conflictRevision = result.failure.currentRevision;
                    this.publish();
                    return {allowed: false, reason: "conflict"};
                }
                if (result.failure.kind === "acceptedRecovering") {
                    this.adoptAccepted(result.failure.change, generation, true);
                    return {allowed: false, reason: "unavailable"};
                }
                if (result.failure.acceptanceUnknown) {
                    this.uncertainSubmission = {revision, prompt, answer};
                    this.state = "acceptanceUnknown";
                    this.publish();
                    return {allowed: false, reason: "unavailable"};
                }
                this.state = "failed";
                this.publish();
                return {allowed: false, reason: "save-failed"};
            }
            this.adoptAccepted(result.change, generation, false);
        }
        return this.destroyed ? {allowed: false, reason: "unavailable"} : {allowed: true};
    }

    private adoptAccepted(
        change: Extract<ItemQAChangeResult, {ok: true}>["change"],
        generation: number,
        recovering: boolean,
    ): void {
        this.baselinePrompt = change.itemQA.prompt;
        this.baselineAnswer = change.itemQA.answer;
        this.revision = change.itemQA.contentRevision;
        this.acknowledgedGeneration = generation;
        if (this.localGeneration === generation) {
            this.localPrompt = change.itemQA.prompt;
            this.localAnswer = change.itemQA.answer;
        }
        this.state = recovering ? "acceptedRecovering" :
            this.localGeneration === this.acknowledgedGeneration ? "clean" : "pending";
        this.uncertainSubmission = undefined;
        this.publish();
    }

    private publish(): void {
        this.onChange?.(this.snapshot());
    }
}
