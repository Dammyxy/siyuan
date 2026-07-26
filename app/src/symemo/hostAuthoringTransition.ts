import {
    beginWindowElementAuthoringTransition,
    createTransitionToken,
    type WindowAuthoringLease,
} from "./authoringRegistry";
import type {ModelTransitionReason, ModelTransitionResult} from "./types";

const AUTHORING_TRANSITION_CHANNEL = "siyuan-symemo-authoring-transition";
const AUTHORING_TRANSITION_EVENT_CHANNEL = "siyuan-symemo-authoring-transition-event";

export type HostAuthoringIntent =
    | {kind: "application-exit"; requester: string; requestId?: string}
    | {kind: "workspace-replace" | "workspace-open"; target: string; requester: string; requestId?: string}
    | {kind: "update-install"; requester: string; requestId?: string};

export interface HostAuthoringLease {
    allowed: true;
    token: string;
    commit(): Promise<void>;
    cancel(): Promise<void>;
}

export type HostAuthoringBlockReason = "save-failed" | "conflict" | "unavailable" | "busy";
export type HostAuthoringTransitionResult = HostAuthoringLease | {allowed: false; reason: HostAuthoringBlockReason};

export interface HostAuthoringTransitionTransport {
    begin(intent: HostAuthoringIntent): Promise<{allowed: true; token: string} | {allowed: false; reason: HostAuthoringBlockReason}>;
    commit(token: string): Promise<void>;
    cancel(token: string): Promise<void>;
}

const getIpcRenderer = (): {invoke: (channel: string, payload: unknown) => Promise<unknown>; on?: (channel: string, listener: (...args: unknown[]) => void) => void} | undefined => {
    /// #if !BROWSER
    try {
        return require("electron").ipcRenderer;
    } catch (_) {
        return undefined;
    }
    /// #endif
    return undefined;
};

export const createHostTransitionIntentKey = (intent: HostAuthoringIntent): string => {
    const requester = intent.requester.trim();
    if (intent.kind === "workspace-open" || intent.kind === "workspace-replace") {
        const normalizedTarget = intent.target.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/")
            .replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`)
            .replace(/([^:])\/$/, "$1");
        return `${intent.kind}:${requester}:${normalizedTarget}`;
    }
    return `${intent.kind}:${requester}`;
};

export const transitionReasonForIntent = (intent: HostAuthoringIntent): ModelTransitionReason => {
    if (intent.kind === "update-install") {
        return "update-install";
    }
    if (intent.kind === "application-exit") {
        return "application-exit";
    }
    return "workspace-switch";
};

export class HostAuthoringTransitionOwner {
    private active?: {
        key: string;
        promise: Promise<HostAuthoringTransitionResult>;
        result?: HostAuthoringTransitionResult;
    };

    constructor(private readonly transport: HostAuthoringTransitionTransport) {}

    public begin(intent: HostAuthoringIntent): Promise<HostAuthoringTransitionResult> {
        const key = createHostTransitionIntentKey(intent);
        if (this.active) {
            if (this.active.key === key) {
                return this.active.promise;
            }
            return Promise.resolve({allowed: false, reason: "busy"});
        }
        const promise = this.transport.begin(intent).then((result): HostAuthoringTransitionResult => {
            if (result.allowed === false) {
                this.active = undefined;
                return result;
            }
            let disposition: "active" | "committing" | "committed" | "cancelling" | "cancelled" = "active";
            let settlement: Promise<void> | undefined;
            const lease: HostAuthoringLease = {
                allowed: true,
                token: result.token,
                commit: async () => {
                    if (disposition === "committed" || disposition === "cancelled") {
                        return;
                    }
                    if (settlement) {
                        return settlement;
                    }
                    disposition = "committing";
                    settlement = this.transport.commit(result.token).then(() => {
                        disposition = "committed";
                    }).catch((error) => {
                        disposition = "active";
                        throw error;
                    }).finally(() => {
                        settlement = undefined;
                    });
                    return settlement;
                },
                cancel: async () => {
                    if (disposition === "committed" || disposition === "cancelled") {
                        return;
                    }
                    if (settlement) {
                        return settlement;
                    }
                    disposition = "cancelling";
                    settlement = this.transport.cancel(result.token).then(() => {
                        disposition = "cancelled";
                        if (this.active?.result === lease) {
                            this.active = undefined;
                        }
                    }).catch((error) => {
                        disposition = "active";
                        throw error;
                    }).finally(() => {
                        settlement = undefined;
                    });
                    return settlement;
                },
            };
            if (this.active) {
                this.active.result = lease;
            }
            return lease;
        }).catch((error) => {
            console.error(error);
            this.active = undefined;
            return {allowed: false, reason: "unavailable"} as HostAuthoringTransitionResult;
        });
        this.active = {key, promise};
        return promise;
    }
}

export const createDefaultHostAuthoringTransitionTransport = (): HostAuthoringTransitionTransport => ({
    async begin(intent) {
        const ipcRenderer = getIpcRenderer();
        if (ipcRenderer) {
            return await ipcRenderer.invoke(AUTHORING_TRANSITION_CHANNEL, {
                action: "begin",
                intent,
                requestId: intent.requestId || createTransitionToken(),
                port: location.port,
            }) as {allowed: true; token: string} | {allowed: false; reason: "save-failed" | "conflict" | "unavailable" | "busy"};
        }
        const local = await beginWindowElementAuthoringTransition(transitionReasonForIntent(intent));
        if (local.allowed === false) {
            return local;
        }
        localLeases.set(local.token, local);
        return {allowed: true, token: local.token};
    },
    async commit(token) {
        const ipcRenderer = getIpcRenderer();
        if (ipcRenderer) {
            const committed = await ipcRenderer.invoke(AUTHORING_TRANSITION_CHANNEL, {action: "commit", token});
            if (!committed) {
                throw new Error("authoring transition commit rejected");
            }
        } else {
            localLeases.get(token)?.commit();
            localLeases.delete(token);
        }
    },
    async cancel(token) {
        const ipcRenderer = getIpcRenderer();
        if (ipcRenderer) {
            const cancelled = await ipcRenderer.invoke(AUTHORING_TRANSITION_CHANNEL, {action: "cancel", token});
            if (!cancelled) {
                throw new Error("authoring transition cancel rejected");
            }
        } else {
            localLeases.get(token)?.cancel();
            localLeases.delete(token);
        }
    },
});

const localLeases = new Map<string, WindowAuthoringLease>();

const defaultOwner = new HostAuthoringTransitionOwner(createDefaultHostAuthoringTransitionTransport());

export const beginHostAuthoringTransition = (intent: HostAuthoringIntent): Promise<HostAuthoringTransitionResult> =>
    defaultOwner.begin(intent);

export const withHostAuthoringTransition = async <T>(
    intent: HostAuthoringIntent,
    callback: (lease: HostAuthoringLease) => Promise<T> | T,
): Promise<T | undefined> => {
    const lease = await beginHostAuthoringTransition(intent);
    if (lease.allowed === false) {
        return undefined;
    }
    try {
        return await callback(lease);
    } catch (error) {
        await lease.cancel();
        throw error;
    }
};

const rendererLeases = new Map<string, WindowAuthoringLease>();
let rendererEventsRegistered = false;
let rendererRegistrationPromise: Promise<boolean> | undefined;

export const registerAuthoringTransitionRenderer = (): Promise<boolean> => {
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer?.on) {
        return Promise.resolve(true);
    }
    if (!rendererEventsRegistered) {
        rendererEventsRegistered = true;
        ipcRenderer.on(AUTHORING_TRANSITION_EVENT_CHANNEL, async (_event: unknown, payload: {
            action: "prepare" | "cancel" | "commit";
            token: string;
            reason?: ModelTransitionReason;
            requestId?: string;
        }) => {
            if (payload.action === "prepare") {
                const result = await beginWindowElementAuthoringTransition(payload.reason || "application-exit", payload.token);
                if (result.allowed) {
                    rendererLeases.set(payload.token, result);
                }
                await ipcRenderer.invoke(AUTHORING_TRANSITION_CHANNEL, {
                    action: "prepared",
                    requestId: payload.requestId,
                    token: payload.token,
                    result: result.allowed ? {allowed: true} : result,
                });
            } else if (payload.action === "cancel") {
                rendererLeases.get(payload.token)?.cancel();
                rendererLeases.delete(payload.token);
                await ipcRenderer.invoke(AUTHORING_TRANSITION_CHANNEL, {
                    action: "cancelled",
                    requestId: payload.requestId,
                    token: payload.token,
                });
            } else if (payload.action === "commit") {
                rendererLeases.get(payload.token)?.commit();
                rendererLeases.delete(payload.token);
                await ipcRenderer.invoke(AUTHORING_TRANSITION_CHANNEL, {
                    action: "committed",
                    requestId: payload.requestId,
                    token: payload.token,
                });
            }
        });
    }
    if (!rendererRegistrationPromise) {
        rendererRegistrationPromise = ipcRenderer.invoke(AUTHORING_TRANSITION_CHANNEL, {action: "register"})
            .then(Boolean)
            .catch(() => false);
    }
    return rendererRegistrationPromise;
};

export const isTransitionAllowed = (result: ModelTransitionResult): result is {allowed: true} => result.allowed;
