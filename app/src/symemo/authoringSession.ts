import type {
    AuthoringFieldSlot,
    AuthoringStatus,
    CreateHTMLTopicResult,
    ElementAuthoringField,
    ElementChangeResult,
    ElementDetailResult,
    ModelTransitionReason,
    ModelTransitionResult,
} from "./types";

const DEFAULT_DEBOUNCE_MS = 256;

type SaveTitle = (elementId: string, expectedTitleRevision: string, title: string) => Promise<ElementChangeResult>;
type SaveMaterial = (elementId: string, expectedMaterialRevision: string, html: string) => Promise<ElementChangeResult>;
type GetElement = (elementId: string) => Promise<ElementDetailResult>;
type CreateHTMLTopic = (title: string, html: string) => Promise<CreateHTMLTopicResult>;

export interface AuthoringSessionOptions {
    elementId: string;
    title: string;
    html: string;
    titleRevision: string;
    materialRevision: string;
    saveTitle: SaveTitle;
    saveMaterial: SaveMaterial;
    getElement?: GetElement;
    createHTMLTopic?: CreateHTMLTopic;
    onAcceptedChange?: (change: import("./types").AcceptedElementChange, submittedGenerationIsCurrent: boolean) => void;
    debounceMs?: number;
}

export interface AuthoringFieldSnapshot {
    localValue: string;
    canonicalBaseline: string;
    revision: string;
    state: AuthoringFieldSlot["state"];
    failure?: AuthoringFieldSlot["failure"];
    conflictRevision?: string;
    canRetry?: boolean;
}

export interface AuthoringRecoverySnapshot {
    state: "idle" | "reloading" | "reloaded" | "preservingAsNew" | "preservedAsNew" | "failed";
    interactionBarrierActive: boolean;
    acceptedElementId?: string;
    errorCode?: string;
}

export interface AuthoringSessionSnapshot {
    title: AuthoringFieldSnapshot;
    material: AuthoringFieldSnapshot;
    recovery: AuthoringRecoverySnapshot;
}

export type ReloadRecoveryResult =
    | {ok: true; kind: "reloaded"}
    | {ok: false; kind: "reloadFailed"; errorCode: string};

export type SaveAsNewRecoveryResult =
    | {ok: true; kind: "preservedAsNew"; elementId: string}
    | {ok: false; kind: "preserveFailed"; errorCode: string};

const cloneSlot = (
    field: ElementAuthoringField,
    localValue: string,
    revision: string,
): AuthoringFieldSlot => ({
    field,
    localValue,
    canonicalBaseline: localValue,
    revision,
    localGeneration: 0,
    acknowledgedGeneration: 0,
    state: "clean",
});

const statusRank: AuthoringStatus[] = ["conflict", "failed", "acceptedRecovering", "saving", "pending", "clean"];

export class AuthoringSession {
    private readonly elementId: string;
    private readonly saveTitle: SaveTitle;
    private readonly saveMaterial: SaveMaterial;
    private readonly getElement?: GetElement;
    private readonly createHTMLTopic?: CreateHTMLTopic;
    private readonly onAcceptedChange?: AuthoringSessionOptions["onAcceptedChange"];
    private readonly debounceMs: number;
    private readonly slots: Record<ElementAuthoringField, AuthoringFieldSlot>;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private drainPromise: Promise<void> | undefined;
    private transitionPromise: Promise<ModelTransitionResult> | undefined;
    private reloadPromise: Promise<ReloadRecoveryResult> | undefined;
    private saveAsNewPromise: Promise<SaveAsNewRecoveryResult> | undefined;
    private recovery: AuthoringRecoverySnapshot = {state: "idle", interactionBarrierActive: false};
    private destroyed = false;

    constructor(options: AuthoringSessionOptions) {
        this.elementId = options.elementId;
        this.saveTitle = options.saveTitle;
        this.saveMaterial = options.saveMaterial;
        this.getElement = options.getElement;
        this.createHTMLTopic = options.createHTMLTopic;
        this.onAcceptedChange = options.onAcceptedChange;
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.slots = {
            title: cloneSlot("title", options.title, options.titleRevision),
            material: cloneSlot("material", options.html, options.materialRevision),
        };
    }

    public editTitle(title: string) {
        this.edit("title", title);
    }

    public editMaterial(html: string) {
        this.edit("material", html);
    }

    public getStatus(): AuthoringStatus {
        const states = [this.slots.title.state, this.slots.material.state];
        return statusRank.find((state) => states.includes(state)) || "clean";
    }

    public snapshot(): AuthoringSessionSnapshot {
        return {
            title: this.snapshotSlot(this.slots.title),
            material: this.snapshotSlot(this.slots.material),
            recovery: {...this.recovery},
        };
    }

    public flush(reason: ModelTransitionReason): Promise<ModelTransitionResult> {
        void reason;
        if (this.recovery.state === "preservedAsNew" && this.recovery.acceptedElementId) {
            return Promise.resolve({allowed: true});
        }
        if (this.destroyed) {
            return Promise.resolve({allowed: false, reason: "unavailable"});
        }
        if (this.recovery.interactionBarrierActive) {
            return Promise.resolve({allowed: false, reason: "busy"});
        }
        if (this.transitionPromise) {
            return this.transitionPromise;
        }
        this.transitionPromise = this.flushInternal().finally(() => {
            this.transitionPromise = undefined;
        });
        return this.transitionPromise;
    }

    public retryFailed(field: ElementAuthoringField): boolean {
        const slot = this.slots[field];
        if (this.destroyed || this.recovery.interactionBarrierActive || slot.state !== "failed" || slot.failure?.retryable !== true) {
            return false;
        }
        slot.state = "pending";
        delete slot.failure;
        slot.dirtySince = Date.now();
        this.scheduleDrain();
        return true;
    }

    public reloadFromAuthority(): Promise<ReloadRecoveryResult> {
        if (this.reloadPromise) return this.reloadPromise;
        if (this.saveAsNewPromise || this.recovery.interactionBarrierActive) {
            return Promise.resolve({ok: false, kind: "reloadFailed", errorCode: "busy"});
        }
        if (this.destroyed || !this.getElement) {
            return Promise.resolve({ok: false, kind: "reloadFailed", errorCode: "unavailable"});
        }
        this.cancelTimer();
        this.recovery = {state: "reloading", interactionBarrierActive: true};
        this.reloadPromise = this.prepareReload()
            .then((ready): Promise<ElementDetailResult> => {
                if (!ready) {
                    return Promise.reject(new Error("safe-field-save-failed"));
                }
                return this.getElement!(this.elementId);
            })
            .then((detail): ReloadRecoveryResult => {
                if (!detail.ok) {
                    const failure = detail as Extract<ElementDetailResult, {ok: false}>;
                    this.recovery = {state: "failed", interactionBarrierActive: false, errorCode: failure.kind};
                    return {ok: false, kind: "reloadFailed", errorCode: failure.kind};
                }
                if (detail.element.type !== "topic" || detail.element.topicMaterial?.kind !== "html" ||
                    typeof detail.element.titleRevision !== "string" ||
                    typeof detail.element.topicMaterial.revision !== "string") {
                    this.recovery = {state: "failed", interactionBarrierActive: false, errorCode: "response"};
                    return {ok: false, kind: "reloadFailed", errorCode: "response"};
                }
                this.resetSlot(this.slots.title, detail.element.title, detail.element.titleRevision);
                this.resetSlot(this.slots.material, detail.element.topicMaterial.html ?? "", detail.element.topicMaterial.revision);
                this.recovery = {state: "reloaded", interactionBarrierActive: false};
                return {ok: true, kind: "reloaded"};
            })
            .catch((): ReloadRecoveryResult => {
                this.recovery = {state: "failed", interactionBarrierActive: false, errorCode: "request"};
                return {ok: false, kind: "reloadFailed", errorCode: "request"};
            })
            .finally(() => {
                this.reloadPromise = undefined;
            });
        return this.reloadPromise;
    }

    public saveAsNew(): Promise<SaveAsNewRecoveryResult> {
        if (this.saveAsNewPromise) return this.saveAsNewPromise;
        if (this.reloadPromise || this.recovery.interactionBarrierActive) {
            return Promise.resolve({ok: false, kind: "preserveFailed", errorCode: "busy"});
        }
        if (this.destroyed || !this.createHTMLTopic) {
            return Promise.resolve({ok: false, kind: "preserveFailed", errorCode: "unavailable"});
        }
        this.cancelTimer();
        this.recovery = {state: "preservingAsNew", interactionBarrierActive: true};
        this.saveAsNewPromise = this.awaitCurrentDrain()
            .then(() => {
                const frozenTitle = this.slots.title.localValue;
                const frozenHTML = this.slots.material.localValue;
                return this.createHTMLTopic!(frozenTitle, frozenHTML);
            })
            .then((result): SaveAsNewRecoveryResult => {
                if (!result.ok) return this.applySaveAsNewFailure((result as Extract<CreateHTMLTopicResult, {ok: false}>).failure);
                this.recovery = {
                    state: "preservedAsNew",
                    interactionBarrierActive: true,
                    acceptedElementId: result.elementId,
                };
                return {ok: true, kind: "preservedAsNew", elementId: result.elementId};
            })
            .catch((): SaveAsNewRecoveryResult => {
                this.recovery = {state: "failed", interactionBarrierActive: false, errorCode: "request"};
                return {ok: false, kind: "preserveFailed", errorCode: "request"};
            })
            .finally(() => {
                this.saveAsNewPromise = undefined;
            });
        return this.saveAsNewPromise;
    }

    private applySaveAsNewFailure(failure: Extract<CreateHTMLTopicResult, {ok: false}>["failure"]): SaveAsNewRecoveryResult {
        if (failure.acceptedElementId) {
            this.recovery = {
                state: "preservedAsNew",
                interactionBarrierActive: true,
                acceptedElementId: failure.acceptedElementId,
                errorCode: failure.errorCode,
            };
            return {ok: true, kind: "preservedAsNew", elementId: failure.acceptedElementId};
        }
        this.recovery = {
            state: "failed",
            interactionBarrierActive: false,
            acceptedElementId: failure.acceptedElementId,
            errorCode: failure.errorCode,
        };
        return {ok: false, kind: "preserveFailed", errorCode: failure.errorCode};
    }

    public destroy() {
        this.destroyed = true;
        this.cancelTimer();
    }

    private snapshotSlot(slot: AuthoringFieldSlot): AuthoringFieldSnapshot {
        const snapshot: AuthoringFieldSnapshot = {
            localValue: slot.localValue,
            canonicalBaseline: slot.canonicalBaseline,
            revision: slot.revision,
            state: slot.state,
        };
        if (slot.failure) {
            snapshot.failure = {...slot.failure};
            snapshot.canRetry = slot.failure.retryable === true;
        }
        if (slot.conflictRevision) {
            snapshot.conflictRevision = slot.conflictRevision;
        }
        return snapshot;
    }

    private edit(field: ElementAuthoringField, value: string) {
        if (this.destroyed || this.recovery.interactionBarrierActive) return;
        const slot = this.slots[field];
        slot.localValue = value;
        slot.localGeneration++;
        slot.dirtySince = Date.now();
        if (slot.state === "conflict" || slot.state === "failed" || slot.state === "acceptedRecovering") {
            this.cancelTimer();
            return;
        }
        delete slot.failure;
        if (slot.state !== "saving") {
            slot.state = "pending";
        }
        this.scheduleDrain();
    }

    private scheduleDrain() {
        if (this.debounceMs < 0 || this.destroyed || this.recovery.interactionBarrierActive) return;
        this.cancelTimer();
        const now = Date.now();
        const delays = ([this.slots.title, this.slots.material] as AuthoringFieldSlot[])
            .filter((slot) => slot.localGeneration > slot.acknowledgedGeneration)
            .filter((slot) => slot.state === "pending" || slot.state === "saving")
            .filter((slot) => slot.dirtySince !== undefined)
            .map((slot) => Math.max(0, (slot.dirtySince ?? now) + this.debounceMs - now));
        if (delays.length === 0) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.drain(false);
        }, Math.min(...delays));
    }

    private cancelTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private async flushInternal(): Promise<ModelTransitionResult> {
        this.cancelTimer();
        await this.drain(true);
        const status = this.getStatus();
        if (status === "conflict") {
            return {allowed: false, reason: "conflict"};
        }
        if (status === "failed") {
            return {allowed: false, reason: "save-failed"};
        }
        if (status === "pending" || status === "saving" || this.hasUnacknowledgedAcceptedRecoveringEdit()) {
            return {allowed: false, reason: "unavailable"};
        }
        return {allowed: true};
    }

    private async drain(force: boolean, allowDuringRecovery = false): Promise<void> {
        if (this.drainPromise) {
            await this.drainPromise;
            if (!force) return;
        }
        this.drainPromise = this.drainLoop(force, allowDuringRecovery).finally(() => {
            this.drainPromise = undefined;
        });
        await this.drainPromise;
    }

    private async drainLoop(force: boolean, allowDuringRecovery: boolean) {
        while (!this.destroyed && (allowDuringRecovery || !this.recovery.interactionBarrierActive)) {
            const slot = this.nextEligibleSlot(force);
            if (!slot) {
                if (!force && !allowDuringRecovery) this.scheduleDrain();
                return;
            }
            await this.submit(slot);
        }
    }

    private nextEligibleSlot(force: boolean): AuthoringFieldSlot | undefined {
        const now = Date.now();
        const candidates = ([this.slots.title, this.slots.material] as AuthoringFieldSlot[])
            .filter((slot) => slot.localGeneration > slot.acknowledgedGeneration)
            .filter((slot) => slot.state !== "failed" && slot.state !== "conflict" && slot.state !== "acceptedRecovering")
            .filter((slot) => force || (slot.dirtySince !== undefined && now - slot.dirtySince >= this.debounceMs));

        candidates.sort((left, right) => {
            const leftSince = left.dirtySince ?? 0;
            const rightSince = right.dirtySince ?? 0;
            if (leftSince !== rightSince) return leftSince - rightSince;
            return left.field === "title" ? -1 : 1;
        });
        return candidates[0];
    }

    private async submit(slot: AuthoringFieldSlot) {
        const submittedGeneration = slot.localGeneration;
        const submittedValue = slot.localValue;
        const expectedRevision = slot.revision;
        slot.state = "saving";
        slot.submittedGeneration = submittedGeneration;
        slot.submittedValue = submittedValue;

        const result = slot.field === "title"
            ? await this.saveTitle(this.elementId, expectedRevision, submittedValue)
            : await this.saveMaterial(this.elementId, expectedRevision, submittedValue);

        if (result.ok) {
            const submittedGenerationIsCurrent = slot.localGeneration === submittedGeneration;
            this.applyAccepted(slot, submittedGeneration, result.change.canonicalValue, result.change.revision, false);
            this.notifyAcceptedChange(result.change, submittedGenerationIsCurrent);
        } else {
            const failure = (result as Extract<ElementChangeResult, {ok: false}>).failure;
            if (failure.kind === "acceptedRecovering") {
                const submittedGenerationIsCurrent = slot.localGeneration === submittedGeneration;
                this.applyAccepted(slot, submittedGeneration, failure.change.canonicalValue, failure.change.revision, true);
                this.notifyAcceptedChange(failure.change, submittedGenerationIsCurrent);
            } else if (failure.kind === "conflict") {
                slot.state = "conflict";
                slot.conflictRevision = failure.currentRevision;
            } else {
                slot.state = "failed";
                slot.failure = {
                    errorCode: failure.errorCode,
                    retryable: failure.retryable,
                    acceptanceUnknown: failure.acceptanceUnknown,
                };
            }
        }
    }

    private notifyAcceptedChange(change: import("./types").AcceptedElementChange, submittedGenerationIsCurrent: boolean) {
        try {
            this.onAcceptedChange?.(change, submittedGenerationIsCurrent);
        } catch {
            // 编辑器协调失败不能回滚已经确认的权威变更。
        }
    }

    private applyAccepted(
        slot: AuthoringFieldSlot,
        submittedGeneration: number,
        canonicalValue: string,
        revision: string,
        acceptedRecovering: boolean,
    ) {
        slot.revision = revision;
        slot.canonicalBaseline = canonicalValue;
        slot.acknowledgedGeneration = Math.max(slot.acknowledgedGeneration, submittedGeneration);
        delete slot.failure;
        delete slot.conflictRevision;

        if (slot.localGeneration === submittedGeneration) {
            slot.localValue = canonicalValue;
            slot.state = acceptedRecovering ? "acceptedRecovering" : "clean";
            delete slot.dirtySince;
        } else {
            slot.state = acceptedRecovering ? "acceptedRecovering" : "pending";
            slot.dirtySince = Date.now();
        }
    }

    private resetSlot(slot: AuthoringFieldSlot, value: string, revision: string) {
        slot.localValue = value;
        slot.canonicalBaseline = value;
        slot.revision = revision;
        slot.localGeneration++;
        slot.acknowledgedGeneration = slot.localGeneration;
        slot.state = "clean";
        delete slot.dirtySince;
        delete slot.failure;
        delete slot.conflictRevision;
        delete slot.submittedGeneration;
        delete slot.submittedValue;
    }

    private async prepareReload(): Promise<boolean> {
        await this.awaitCurrentDrain();
        await this.drain(true, true);
        const slots = [this.slots.title, this.slots.material] as AuthoringFieldSlot[];
        return !slots.some((slot) => slot.state === "failed") &&
            slots.filter((slot) => slot.state === "conflict").length <= 1;
    }

    private async awaitCurrentDrain(): Promise<void> {
        if (this.drainPromise) {
            await this.drainPromise;
        }
    }

    private hasUnacknowledgedAcceptedRecoveringEdit(): boolean {
        return ([this.slots.title, this.slots.material] as AuthoringFieldSlot[])
            .some((slot) => slot.state === "acceptedRecovering" && slot.localGeneration > slot.acknowledgedGeneration);
    }
}
