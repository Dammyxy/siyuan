import type {Tab} from "../layout/Tab";
import type {SymemoElementLayoutData} from "./types";
import {
    enterCommittedHandoff,
    isModelTransitionGuarded,
    isWindowAuthoringBusy,
    materializeCommittedHandoff,
} from "./authoringRegistry";
import {normalizeSymemoLayoutData, serializeSymemoLayoutData} from "./layoutState";

const TAB_TRANSFER_CHANNEL = "siyuan-symemo-tab-transfer";
const TAB_TRANSFER_EVENT_CHANNEL = "siyuan-symemo-tab-transfer-event";

export interface TabTransferOffer<T = unknown> {
    offerId: string;
    tab: T;
    dragEnded: boolean;
}

export interface TabTransferReservation {
    transferId: string;
    destination: unknown;
    sourceOfferId?: string;
    sourceTab?: unknown;
    ready: boolean;
    committed: boolean;
    identity?: SymemoElementLayoutData;
}

export interface HostTabTransferCoordinatorOptions {
    randomId?: () => string;
    scheduleExpiry?: (ms: number, callback: () => void) => () => void;
}

export const createOpaqueTransferId = (): string => {
    const cryptoLike = globalThis.crypto;
    if (cryptoLike?.getRandomValues) {
        const bytes = new Uint8Array(16);
        cryptoLike.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    /// #if !BROWSER
    try {
        return require("crypto").randomBytes(16).toString("hex");
    } catch (_) {
        // 继续执行下方的保守失败路径。
    }
    /// #endif
    throw new Error("cryptographic randomness is unavailable");
};

export class HostTabTransferCoordinator {
    private readonly offers = new Map<string, TabTransferOffer>();
    private readonly reservations = new Map<string, TabTransferReservation>();
    private readonly expiryCancels = new Map<string, () => void>();
    private readonly randomId: () => string;
    private readonly scheduleExpiry: (ms: number, callback: () => void) => () => void;
    private committedHandoffs = 0;

    constructor(options: HostTabTransferCoordinatorOptions = {}) {
        this.randomId = options.randomId || createOpaqueTransferId;
        this.scheduleExpiry = options.scheduleExpiry || ((ms, callback) => {
            const timer = window.setTimeout(callback, ms);
            return () => window.clearTimeout(timer);
        });
    }

    public createOffer(tab: unknown): TabTransferOffer {
        const offer = {offerId: this.randomId(), tab, dragEnded: false};
        this.offers.set(offer.offerId, offer);
        return offer;
    }

    public markDragEnd(offerId: string): void {
        const offer = this.offers.get(offerId);
        if (!offer) {
            return;
        }
        offer.dragEnded = true;
        const cancel = this.scheduleExpiry(60000, () => {
            this.offers.delete(offerId);
            this.expiryCancels.delete(offerId);
        });
        this.expiryCancels.set(offerId, cancel);
    }

    public claimOffer(offerId: string, tab: unknown): TabTransferOffer | undefined {
        const offer = this.offers.get(offerId);
        if (!offer || offer.tab !== tab) {
            return undefined;
        }
        this.cancelOfferExpiry(offerId);
        return offer;
    }

    public getLiveOffer(offerId: string): TabTransferOffer | undefined {
        const offer = this.offers.get(offerId);
        const tab = offer?.tab as {parent?: {children?: unknown[]}} | undefined;
        if (!offer || !tab?.parent?.children?.includes(tab)) {
            return undefined;
        }
        return offer;
    }

    public takeOffer(offerId: string): TabTransferOffer | undefined {
        const offer = this.offers.get(offerId);
        if (!offer) {
            return undefined;
        }
        this.cancelOfferExpiry(offerId);
        this.offers.delete(offerId);
        return offer;
    }

    public reserveDestination(destination: unknown): TabTransferReservation {
        const reservation = {
            transferId: this.randomId(),
            destination,
            ready: false,
            committed: false,
        };
        this.reservations.set(reservation.transferId, reservation);
        return reservation;
    }

    public bindSourceClaim(transferId: string, offerId: string, tab: unknown): boolean {
        const reservation = this.reservations.get(transferId);
        if (!reservation || reservation.sourceOfferId || !this.claimOffer(offerId, tab)) {
            return false;
        }
        reservation.sourceOfferId = offerId;
        reservation.sourceTab = tab;
        return true;
    }

    public markDestinationReady(transferId: string): boolean {
        const reservation = this.reservations.get(transferId);
        if (!reservation) {
            return false;
        }
        reservation.ready = true;
        return true;
    }

    public markSourceCommitted(transferId: string): boolean {
        const reservation = this.reservations.get(transferId);
        if (!reservation || reservation.committed || !reservation.sourceOfferId) {
            return false;
        }
        reservation.committed = true;
        this.committedHandoffs++;
        return true;
    }

    public materializeDestination(transferId: string, identity: SymemoElementLayoutData): boolean {
        const reservation = this.reservations.get(transferId);
        if (!reservation || !reservation.committed) {
            return false;
        }
        reservation.identity = identity;
        this.reservations.delete(transferId);
        this.committedHandoffs = Math.max(0, this.committedHandoffs - 1);
        return true;
    }

    public cancelTransfer(transferId: string): boolean {
        const reservation = this.reservations.get(transferId);
        if (!reservation || reservation.committed) {
            return false;
        }
        this.reservations.delete(transferId);
        return true;
    }

    public isCommittedHandoffActive(): boolean {
        return this.committedHandoffs > 0;
    }

    private cancelOfferExpiry(offerId: string): void {
        const cancel = this.expiryCancels.get(offerId);
        if (cancel) {
            cancel();
            this.expiryCancels.delete(offerId);
        }
    }
}

const defaultCoordinator = new HostTabTransferCoordinator();

export const createTabTransferOffer = (tab: Tab): string =>
    isModelTransitionGuarded(tab.model) && !isWindowAuthoringBusy() ? defaultCoordinator.createOffer(tab).offerId : "";
export const markTabTransferDragEnd = (offerId: string): void => defaultCoordinator.markDragEnd(offerId);

interface OfferedTransferTab {
    id: string;
    title?: string;
    icon?: string;
    model?: {elementId?: unknown};
    parent: {
        detachTab(tab: unknown, options: {
            reason: "cross-window-transfer";
            operationKey: string;
            commit(): boolean;
        }): Promise<boolean>;
        closeIfEmptyAfterTransfer?(): void;
    };
}

interface TabTransferInvokePayload {
    action: "source-committed" | "materialized" | "materialization-failed" | "cancel" | "claim" | "reserve" | "ready";
    transferId?: string;
    offerId?: string;
    identity?: SymemoElementLayoutData;
    handoff?: boolean;
}

export type DestinationMaterializationResult = boolean | {
    ok: true;
    activate?: () => void;
} | {
    ok: false;
};

type DestinationMaterializer = (identity: SymemoElementLayoutData) => DestinationMaterializationResult;

export const claimLocatedTabTransfer = async (options: {
    coordinator: HostTabTransferCoordinator;
    offerId: string;
    transferId: string;
    invoke(channel: string, payload: TabTransferInvokePayload): Promise<unknown>;
}): Promise<boolean> => {
    const offer = options.coordinator.getLiveOffer(options.offerId);
    if (!offer || !options.coordinator.claimOffer(options.offerId, offer.tab)) {
        return false;
    }
    let claimed: boolean;
    try {
        claimed = Boolean(await options.invoke(TAB_TRANSFER_CHANNEL, {
            action: "claim",
            transferId: options.transferId,
            offerId: options.offerId,
        }));
    } catch (_) {
        options.coordinator.markDragEnd(options.offerId);
        return true;
    }
    if (!claimed) {
        options.coordinator.takeOffer(options.offerId);
        return false;
    }
    return true;
};

export const reserveOfferedTabTransfer = async (options: {
    offerId: string;
    invoke(channel: string, payload: TabTransferInvokePayload): Promise<unknown>;
    registerDestination(transferId: string, materialize: DestinationMaterializer): Promise<boolean>;
    materialize: DestinationMaterializer;
}): Promise<boolean> => {
    const reservation = await options.invoke(TAB_TRANSFER_CHANNEL, {
        action: "reserve",
        offerId: options.offerId,
    }) as {ok?: boolean; transferId?: string} | undefined;
    if (!reservation?.ok || typeof reservation.transferId !== "string" || !reservation.transferId) {
        return false;
    }
    const ready = await options.registerDestination(reservation.transferId, options.materialize);
    if (!ready) {
        await options.invoke(TAB_TRANSFER_CHANNEL, {action: "cancel", transferId: reservation.transferId});
    }
    return ready;
};

export const commitOfferedTabTransfer = async (options: {
    coordinator: HostTabTransferCoordinator;
    offerId: string;
    transferId: string;
    enterHandoff: (afterRelease: () => void) => () => void;
    invoke(channel: string, payload: TabTransferInvokePayload): Promise<unknown>;
}): Promise<{ok: true; release: () => void} | {ok: false}> => {
    const offer = options.coordinator.takeOffer(options.offerId);
    const tab = offer?.tab as OfferedTransferTab | undefined;
    const elementId = tab?.model?.elementId;
    if (!tab || typeof elementId !== "string" || !elementId.trim()) {
        await options.invoke(TAB_TRANSFER_CHANNEL, {action: "cancel", transferId: options.transferId});
        return {ok: false};
    }
    let identity: SymemoElementLayoutData | undefined;
    let release: (() => void) | undefined;
    const removed = await tab.parent.detachTab(tab, {
        reason: "cross-window-transfer",
        operationKey: `symemo-transfer:${options.transferId}`,
        commit: () => {
            identity = serializeSymemoLayoutData({elementId, title: tab.title, icon: tab.icon});
            release = options.enterHandoff(() => tab.parent.closeIfEmptyAfterTransfer?.());
            return true;
        },
    });
    if (!removed) {
        release?.();
        await options.invoke(TAB_TRANSFER_CHANNEL, {action: "cancel", transferId: options.transferId});
        return {ok: false};
    }
    let accepted: unknown;
    try {
        accepted = await options.invoke(TAB_TRANSFER_CHANNEL, {
            action: "source-committed",
            transferId: options.transferId,
            identity,
        });
    } catch (_) {
        return {ok: false};
    }
    if (!accepted) {
        release?.();
        return {ok: false};
    }
    return {ok: true, release: release!};
};

export const materializeReservedDestination = async (options: {
    identity: SymemoElementLayoutData;
    releaseHandoff(): void;
    materialize: DestinationMaterializer;
    report(action: "materialized" | "materialization-failed"): Promise<unknown>;
}): Promise<boolean> => {
    let result: Exclude<DestinationMaterializationResult, boolean> = {ok: false};
    try {
        const materialized = materializeCommittedHandoff(() => options.materialize(options.identity));
        result = typeof materialized === "boolean" ? {ok: materialized} : materialized;
    } catch (error) {
        console.error(error);
    }
    let acknowledged = false;
    try {
        acknowledged = Boolean(await options.report(result.ok ? "materialized" : "materialization-failed"));
    } finally {
        options.releaseHandoff();
    }
    if (!result.ok || !acknowledged) {
        return false;
    }
    try {
        result.activate?.();
    } catch (error) {
        console.error(error);
    }
    return true;
};

type IpcRendererLike = {
    invoke(channel: string, payload: unknown): Promise<unknown>;
    on?(channel: string, listener: (_event: unknown, payload: any) => void): void;
};

const getIpcRenderer = (): IpcRendererLike | undefined => {
    /// #if !BROWSER
    try {
        return require("electron").ipcRenderer;
    } catch (_) {
        return undefined;
    }
    /// #endif
    return undefined;
};

const sourceHandoffs = new Map<string, () => void>();
const destinationMaterializers = new Map<string, DestinationMaterializer>();
const destinationHandoffs = new Map<string, () => void>();
let transferRendererRegistered = false;

export const registerHostTabTransferRenderer = (): void => {
    if (transferRendererRegistered) {
        return;
    }
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer?.on) {
        return;
    }
    transferRendererRegistered = true;
    ipcRenderer.on(TAB_TRANSFER_EVENT_CHANNEL, (_event, payload: {
        action: "locate" | "ready" | "prepare-source" | "materialize" | "complete" | "cancel" | "cancelled";
        transferId: string;
        offerId?: string;
        identity?: unknown;
    }) => {
        if (payload.action === "locate" && payload.offerId) {
            void claimLocatedTabTransfer({
                coordinator: defaultCoordinator,
                offerId: payload.offerId,
                transferId: payload.transferId,
                invoke: (channel, request) => ipcRenderer.invoke(channel, request),
            });
            return;
        }
        if (payload.action === "prepare-source" && payload.offerId) {
            void commitOfferedTabTransfer({
                coordinator: defaultCoordinator,
                offerId: payload.offerId,
                transferId: payload.transferId,
                enterHandoff: (afterRelease) => {
                    const releaseHandoff = enterCommittedHandoff();
                    let released = false;
                    const release = () => {
                        if (released) {
                            return;
                        }
                        released = true;
                        if (sourceHandoffs.get(payload.transferId) === release) {
                            sourceHandoffs.delete(payload.transferId);
                        }
                        releaseHandoff();
                        afterRelease();
                    };
                    sourceHandoffs.set(payload.transferId, release);
                    return release;
                },
                invoke: (channel, request) => ipcRenderer.invoke(channel, request),
            });
            return;
        }
        if (payload.action === "ready") {
            if (destinationHandoffs.has(payload.transferId)) {
                return;
            }
            if (!destinationMaterializers.has(payload.transferId) || isWindowAuthoringBusy()) {
                destinationMaterializers.delete(payload.transferId);
                void ipcRenderer.invoke(TAB_TRANSFER_CHANNEL, {action: "cancel", transferId: payload.transferId});
                return;
            }
            let releaseCommittedHandoff: () => void;
            try {
                releaseCommittedHandoff = enterCommittedHandoff();
            } catch (error) {
                console.error(error);
                destinationMaterializers.delete(payload.transferId);
                void ipcRenderer.invoke(TAB_TRANSFER_CHANNEL, {action: "cancel", transferId: payload.transferId});
                return;
            }
            let released = false;
            const releaseHandoff = () => {
                if (released) {
                    return;
                }
                released = true;
                if (destinationHandoffs.get(payload.transferId) === releaseHandoff) {
                    destinationHandoffs.delete(payload.transferId);
                }
                releaseCommittedHandoff();
            };
            destinationHandoffs.set(payload.transferId, releaseHandoff);
            void ipcRenderer.invoke(TAB_TRANSFER_CHANNEL, {
                action: "ready",
                transferId: payload.transferId,
                handoff: true,
            }).then((ready) => {
                if (!ready) {
                    destinationMaterializers.delete(payload.transferId);
                    releaseHandoff();
                }
            }).catch((error) => {
                console.error(error);
            });
            return;
        }
        if (payload.action === "materialize") {
            const identity = normalizeSymemoLayoutData(payload.identity);
            const materialize = destinationMaterializers.get(payload.transferId);
            const releaseHandoff = destinationHandoffs.get(payload.transferId);
            if (!identity || !materialize || !releaseHandoff) {
                destinationMaterializers.delete(payload.transferId);
                destinationHandoffs.delete(payload.transferId);
                void ipcRenderer.invoke(TAB_TRANSFER_CHANNEL, {
                    action: "materialization-failed",
                    transferId: payload.transferId,
                }).catch((error) => console.error(error)).finally(() => releaseHandoff?.());
                return;
            }
            destinationHandoffs.delete(payload.transferId);
            void materializeReservedDestination({
                identity,
                releaseHandoff,
                materialize,
                report: (action) => ipcRenderer.invoke(TAB_TRANSFER_CHANNEL, {
                    action,
                    transferId: payload.transferId,
                }),
            }).catch((error) => console.error(error)).finally(() => {
                destinationMaterializers.delete(payload.transferId);
            });
            return;
        }
        if (payload.action === "complete" || payload.action === "cancel" || payload.action === "cancelled") {
            sourceHandoffs.get(payload.transferId)?.();
            sourceHandoffs.delete(payload.transferId);
            destinationMaterializers.delete(payload.transferId);
            destinationHandoffs.get(payload.transferId)?.();
            destinationHandoffs.delete(payload.transferId);
        }
    });
};

export const registerTabTransferDestination = async (
    transferId: string,
    materialize: DestinationMaterializer,
): Promise<boolean> => {
    registerHostTabTransferRenderer();
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer || destinationMaterializers.has(transferId)) {
        return false;
    }
    destinationMaterializers.set(transferId, materialize);
    let ready: boolean | undefined;
    try {
        ready = Boolean(await ipcRenderer.invoke(TAB_TRANSFER_CHANNEL, {action: "ready", transferId}));
    } catch (error) {
        console.error(error);
    }
    if (ready === false) {
        destinationMaterializers.delete(transferId);
    }
    return ready !== false;
};

export const transferOfferedTabToCurrentWindow = async (
    offerId: string,
    materialize: DestinationMaterializer,
): Promise<boolean> => {
    if (isWindowAuthoringBusy()) {
        return false;
    }
    registerHostTabTransferRenderer();
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer) {
        return false;
    }
    return reserveOfferedTabTransfer({
        offerId,
        materialize,
        invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
        registerDestination: registerTabTransferDestination,
    });
};

export type TabTransferAttempt = "not-guarded" | "transferred" | "blocked";

export const transferTabToNewWindow = async (tab: Tab, options: {
    position?: {x: number; y: number};
    width?: number;
    height?: number;
    alwaysOnTop?: boolean;
} = {}): Promise<TabTransferAttempt> => {
    if (!isModelTransitionGuarded(tab.model)) {
        return "not-guarded";
    }
    if (isWindowAuthoringBusy()) {
        return "blocked";
    }
    registerHostTabTransferRenderer();
    const ipcRenderer = getIpcRenderer();
    if (!ipcRenderer) {
        return "blocked";
    }
    const offerId = createTabTransferOffer(tab);
    const transferred = Boolean(await ipcRenderer.invoke(TAB_TRANSFER_CHANNEL, {
        action: "open-new-window",
        offerId,
        position: options.position,
        width: options.width,
        height: options.height,
        alwaysOnTop: !!options.alwaysOnTop,
    }));
    return transferred ? "transferred" : "blocked";
};
