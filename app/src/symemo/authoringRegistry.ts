import type {Model} from "../layout/Model";
import type {ModelTransitionReason, ModelTransitionResult} from "./types";

export interface WindowAuthoringParticipant {
    id: string;
    prepareTransition(reason: ModelTransitionReason): Promise<ModelTransitionResult> | ModelTransitionResult;
    setWindowBarrier(active: boolean, token?: string): void;
    cleanup?(): void;
}

export type TabOperationKind = "close" | "batch-close" | "evict" | "replace" | "detach" | "transfer";

export interface TabOperationIdentity {
    tabId: string;
    kind: TabOperationKind;
    operationKey?: string;
}

export interface WindowAuthoringLease {
    allowed: true;
    token: string;
    commit(): void;
    cancel(): void;
}

export type WindowAuthoringBlockReason = Extract<ModelTransitionResult, {allowed: false}>["reason"];
export type WindowAuthoringTransitionResult = WindowAuthoringLease | {allowed: false; reason: WindowAuthoringBlockReason};

type CancelCallback = () => void;

export interface TabEvictionCandidate {
    headElement?: {
        classList: {
            contains(name: string): boolean;
        };
    } | null;
}

export class WindowTabMutationQueue {
    private tail: Promise<void> = Promise.resolve();

    public run<T>(callback: () => Promise<T> | T): Promise<T> {
        const result = this.tail.then(callback, callback);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}

export const removeTabsSequentially = async <T>(
    tabs: T[],
    remove: (tab: T, index: number) => Promise<boolean> | boolean,
): Promise<{completed: boolean; removed: T[]}> => {
    const removed: T[] = [];
    for (let index = 0; index < tabs.length; index++) {
        const tab = tabs[index];
        if (!await remove(tab, index)) {
            return {completed: false, removed};
        }
        removed.push(tab);
    }
    return {completed: true, removed};
};

export const isTabEvictionCandidate = (tab: TabEvictionCandidate): boolean =>
    Boolean(tab.headElement) && !tab.headElement.classList.contains("item--pin") &&
    !tab.headElement.classList.contains("item--focus");

export class WindowAuthoringOperation {
    private readonly cancelCallbacks: CancelCallback[] = [];
    private readonly settlePromises = new Set<Promise<unknown>>();
    private cancelled = false;
    private finished = false;

    constructor(public readonly name: string, private readonly onIdle: () => void = () => undefined) {}

    public get isCancelled(): boolean {
        return this.cancelled;
    }

    public onCancel(callback: CancelCallback): void {
        if (this.cancelled) {
            callback();
            return;
        }
        this.cancelCallbacks.push(callback);
    }

    public waitUntilSettled(promise: Promise<unknown>): void {
        const tracked = promise.finally(() => {
            this.settlePromises.delete(tracked);
            if (this.finished && this.settlePromises.size === 0) {
                this.onIdle();
            }
        });
        this.settlePromises.add(tracked);
    }

    public finish(): void {
        this.finished = true;
        if (this.settlePromises.size === 0) {
            this.onIdle();
        }
    }

    public cancel(): void {
        if (this.cancelled) {
            return;
        }
        this.cancelled = true;
        this.cancelCallbacks.forEach((callback) => callback());
    }

    public async wait(): Promise<void> {
        while (this.settlePromises.size > 0) {
            await Promise.allSettled([...this.settlePromises]);
        }
    }
}

export class WindowAuthoringRegistry {
    private readonly participants = new Map<string, WindowAuthoringParticipant>();
    private readonly operations = new Set<WindowAuthoringOperation>();
    private activeToken?: string;
    private activeReason?: ModelTransitionReason;
    private activePromise?: Promise<WindowAuthoringTransitionResult>;
    private committedToken?: string;
    private committedHandoffCount = 0;
    private committedHandoffMaterializationDepth = 0;

    public canRegister(): boolean {
        return !this.activeToken && (
            this.committedHandoffCount === 0 || this.committedHandoffMaterializationDepth > 0
        );
    }

    public isBusy(): boolean {
        return Boolean(this.activeToken) || this.committedHandoffCount > 0;
    }

    public hasBarrier(): boolean {
        return Boolean(this.activeToken);
    }

    public register(participant: WindowAuthoringParticipant): () => void {
        if (!this.canRegister()) {
            throw new Error("authoring window barrier is active");
        }
        this.participants.set(participant.id, participant);
        return () => {
            if (this.participants.get(participant.id) === participant) {
                this.participants.delete(participant.id);
            }
        };
    }

    public createOperation(name: string): WindowAuthoringOperation {
        const operation: WindowAuthoringOperation = new WindowAuthoringOperation(
            name,
            () => this.operations.delete(operation),
        );
        this.operations.add(operation);
        return operation;
    }

    public async runOperation<T>(
        name: string,
        callback: (operation: WindowAuthoringOperation) => Promise<T> | T,
    ): Promise<{started: true; value: T} | {started: false}> {
        if (this.isBusy()) {
            return {started: false};
        }
        const operation = this.createOperation(name);
        try {
            const promise = Promise.resolve().then(() => callback(operation));
            operation.waitUntilSettled(promise);
            return {started: true, value: await promise};
        } finally {
            operation.finish();
            await operation.wait();
        }
    }

    public enterCommittedHandoff(): () => void {
        this.committedHandoffCount++;
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.committedHandoffCount = Math.max(0, this.committedHandoffCount - 1);
        };
    }

    public materializeCommittedHandoff<T>(callback: () => T): T {
        if (this.committedHandoffCount === 0) {
            return callback();
        }
        this.committedHandoffMaterializationDepth++;
        try {
            return callback();
        } finally {
            this.committedHandoffMaterializationDepth = Math.max(
                0,
                this.committedHandoffMaterializationDepth - 1,
            );
        }
    }

    public beginTransition(
        reason: ModelTransitionReason,
        token = createTransitionToken(),
    ): Promise<WindowAuthoringTransitionResult> {
        if (this.committedHandoffCount > 0) {
            return Promise.resolve({allowed: false, reason: "busy"});
        }
        if (this.activeToken) {
            if (this.activeToken === token && this.activeReason === reason && this.committedToken !== token &&
                this.activePromise) {
                return this.activePromise;
            }
            return Promise.resolve({allowed: false, reason: "busy"});
        }
        this.activeToken = token;
        this.activeReason = reason;
        const promise = this.prepareTransition(reason, token);
        this.activePromise = promise;
        return promise;
    }

    private async prepareTransition(
        reason: ModelTransitionReason,
        token: string,
    ): Promise<WindowAuthoringTransitionResult> {
        const participants = [...this.participants.values()];
        participants.forEach((participant) => participant.setWindowBarrier(true, token));
        await this.cancelPreparingOperations();
        for (const participant of participants) {
            let result: ModelTransitionResult;
            try {
                result = await participant.prepareTransition(reason);
            } catch (error) {
                console.error(error);
                result = {allowed: false, reason: "unavailable"};
            }
            if (result.allowed === false) {
                this.cancelTransition(token);
                return result;
            }
        }
        return this.createLease(token);
    }

    private async cancelPreparingOperations(): Promise<void> {
        const operations = [...this.operations];
        operations.forEach((operation) => operation.cancel());
        await Promise.allSettled(operations.map((operation) => operation.wait()));
        operations.forEach((operation) => this.operations.delete(operation));
    }

    private createLease(token: string): WindowAuthoringLease {
        return {
            allowed: true,
            token,
            commit: () => this.commitTransition(token),
            cancel: () => this.cancelTransition(token),
        };
    }

    private commitTransition(token: string): void {
        if (this.activeToken !== token) {
            return;
        }
        const participants = [...this.participants.values()];
        participants.forEach((participant) => {
            try {
                participant.cleanup?.();
            } catch (error) {
                console.error(error);
            }
        });
        this.committedToken = token;
    }

    private cancelTransition(token: string): void {
        if (this.activeToken !== token || this.committedToken === token) {
            return;
        }
        const participants = [...this.participants.values()];
        this.activeToken = undefined;
        this.activeReason = undefined;
        this.activePromise = undefined;
        participants.forEach((participant) => participant.setWindowBarrier(false, token));
    }
}

export const createTransitionToken = (): string => {
    const cryptoLike = globalThis.crypto;
    if (cryptoLike?.getRandomValues) {
        const bytes = new Uint8Array(16);
        cryptoLike.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
};

const defaultRegistry = new WindowAuthoringRegistry();

export const registerWindowAuthoringParticipant = (participant: WindowAuthoringParticipant): (() => void) =>
    defaultRegistry.register(participant);

export const beginWindowElementAuthoringTransition = (
    reason: ModelTransitionReason,
    token?: string,
): Promise<WindowAuthoringTransitionResult> => defaultRegistry.beginTransition(reason, token);

export const createWindowAuthoringOperation = (name: string): WindowAuthoringOperation =>
    defaultRegistry.createOperation(name);

export const runWindowAuthoringOperation = <T>(
    name: string,
    callback: (operation: WindowAuthoringOperation) => Promise<T> | T,
): Promise<{started: true; value: T} | {started: false}> => defaultRegistry.runOperation(name, callback);

export const enterCommittedHandoff = (): (() => void) => defaultRegistry.enterCommittedHandoff();

export const materializeCommittedHandoff = <T>(callback: () => T): T =>
    defaultRegistry.materializeCommittedHandoff(callback);

export const hasWindowAuthoringBarrier = (): boolean => defaultRegistry.hasBarrier();

export const isWindowAuthoringBusy = (): boolean => defaultRegistry.isBusy();

export const isModelTransitionGuarded = (model: Partial<Model> | undefined): boolean =>
    typeof model?.prepareTransition === "function";

export const prepareModelTransition = async (
    model: Partial<Model> | undefined,
    reason: ModelTransitionReason,
): Promise<ModelTransitionResult> => {
    if (!isModelTransitionGuarded(model)) {
        return {allowed: true};
    }
    try {
        return await model.prepareTransition(reason);
    } catch (error) {
        console.error(error);
        return {allowed: false, reason: "unavailable"};
    }
};

export const cleanupModelAfterTransition = (model: Partial<Model> | undefined): void => {
    try {
        model?.cleanup?.();
    } catch (error) {
        console.error(error);
    }
};

export const normalizeTabOperationKey = (operation: TabOperationIdentity): string =>
    `${operation.tabId}:${operation.kind}:${operation.operationKey || "default"}`;
