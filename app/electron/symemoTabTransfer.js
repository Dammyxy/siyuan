"use strict";

const createSymemoTabTransferBroker = (options) => {
    const transfers = new Map();
    const createToken = options.createToken || (() => require("crypto").randomBytes(16).toString("hex"));
    const log = options.log || (() => undefined);
    const scheduleExpiry = options.scheduleExpiry || ((callback) => {
        const timer = setTimeout(callback, 60000);
        timer.unref?.();
        return timer;
    });

    const sent = (result) => Boolean(result && result.ok !== false);

    const isIdentityOnlyElement = (identity) => {
        if (!identity || identity.instance !== "SymemoElement" || typeof identity.elementId !== "string" ||
            !identity.elementId.trim()) {
            return false;
        }
        const keys = Object.keys(identity);
        if (keys.some((key) => !["instance", "elementId", "title", "icon"].includes(key))) {
            return false;
        }
        return (identity.title === undefined || typeof identity.title === "string") &&
            (identity.icon === undefined || typeof identity.icon === "string");
    };

    const settle = (transfer, completed) => {
        if (transfer.expiry) {
            clearTimeout(transfer.expiry);
            transfer.expiry = undefined;
        }
        transfers.delete(transfer.transferId);
        transfer.resolve?.(completed);
    };

    const notifyCancelled = async (transfer) => {
        const notifications = [];
        if (transfer.sourceId) {
            notifications.push(Promise.resolve().then(() => options.send(
                transfer.sourceId,
                {action: "cancelled", transferId: transfer.transferId},
            )));
        }
        if (transfer.destinationId) {
            notifications.push(Promise.resolve().then(() => options.send(
                transfer.destinationId,
                {action: "cancelled", transferId: transfer.transferId},
            )));
        }
        const results = await Promise.allSettled(notifications);
        results.forEach((result) => {
            if (result.status === "rejected") {
                log(result.reason);
            }
        });
    };

    const failUncommitted = async (transfer) => {
        if (!transfers.has(transfer.transferId) || transfer.committed || transfer.settling) {
            return;
        }
        transfer.settling = true;
        await notifyCancelled(transfer);
        const destinationId = transfer.destroyOnCancel ? transfer.destinationId : undefined;
        settle(transfer, false);
        if (destinationId) {
            try {
                options.destroyDestination?.(destinationId);
            } catch (error) {
                log(error);
            }
        }
    };

    const failCommitted = async (transfer) => {
        if (!transfers.has(transfer.transferId) || !transfer.committed || transfer.settling) {
            return;
        }
        transfer.settling = true;
        if (transfer.sourceId) {
            try {
                await options.send(transfer.sourceId, {
                    action: "complete",
                    transferId: transfer.transferId,
                    completed: false,
                });
            } catch (error) {
                log(error);
            }
        }
        const destinationId = transfer.destroyOnCancel ? transfer.destinationId : undefined;
        settle(transfer, false);
        if (destinationId) {
            try {
                options.destroyDestination?.(destinationId);
            } catch (error) {
                log(error);
            }
        }
    };

    const expireUncommitted = (transfer) => {
        transfer.expiry = scheduleExpiry(async () => {
            if (!transfers.has(transfer.transferId) || transfer.committed) {
                return;
            }
            await failUncommitted(transfer);
        });
    };

    const resetCommittedExpiry = (transfer) => {
        if (transfer.expiry) {
            clearTimeout(transfer.expiry);
            transfer.expiry = undefined;
        }
        transfer.expiry = scheduleExpiry(() => {
            void failCommitted(transfer).catch(log);
        });
    };

    const prepareSource = async (transfer) => {
        if (!transfer.sourceId || !transfer.destinationHandoffReady || transfer.committed || transfer.sourcePrepared) {
            return Boolean(transfer.sourcePrepared);
        }
        transfer.preparingSource = true;
        let result;
        try {
            result = await options.send(transfer.sourceId, {
                action: "prepare-source",
                transferId: transfer.transferId,
                offerId: transfer.offerId,
            });
        } catch (error) {
            log(error);
            await failUncommitted(transfer);
            return false;
        } finally {
            transfer.preparingSource = false;
        }
        if (!transfers.has(transfer.transferId) || transfer.settling) {
            return false;
        }
        if (!sent(result)) {
            await failUncommitted(transfer);
            return false;
        }
        transfer.sourcePrepared = true;
        transfer.resolveReady?.(true);
        transfer.resolveReady = undefined;
        return true;
    };

    const requestDestinationHandoff = async (transfer) => {
        if (!transfers.has(transfer.transferId) || !transfer.sourceId || !transfer.destinationRegistered ||
            transfer.destinationHandoffRequested || transfer.destinationHandoffReady || transfer.committed || transfer.settling) {
            return false;
        }
        transfer.destinationHandoffRequested = true;
        try {
            const result = await options.send(transfer.destinationId, {
                action: "ready",
                transferId: transfer.transferId,
            });
            if (!sent(result)) {
                await failUncommitted(transfer);
                return false;
            }
        } catch (error) {
            log(error);
            await failUncommitted(transfer);
            return false;
        }
        return transfers.has(transfer.transferId) && !transfer.settling;
    };

    return {
        async openNewWindow(request) {
            const transferId = createToken();
            const completion = new Promise((resolve) => {
                transfers.set(transferId, {
                    transferId,
                    port: request.port,
                    sourceId: request.senderId,
                    offerId: request.offerId,
                    destinationId: undefined,
                    destinationRegistered: false,
                    destinationHandoffRequested: false,
                    destinationHandoffReady: false,
                    committed: false,
                    destroyOnCancel: true,
                    resolve,
                });
            });
            const transfer = transfers.get(transferId);
            try {
                const destinationId = await options.createDestination({
                    transferId,
                    port: request.port,
                    sourceId: request.senderId,
                    options: request.options,
                });
                if (!transfers.has(transferId) || transfer.settling) {
                    if (destinationId) {
                        try {
                            options.destroyDestination?.(destinationId);
                        } catch (error) {
                            log(error);
                        }
                    }
                } else if (!destinationId) {
                    settle(transfer, false);
                } else {
                    transfer.destinationId = destinationId;
                    expireUncommitted(transfer);
                }
            } catch (error) {
                log(error);
                settle(transfer, false);
            }
            return completion;
        },
        async reserve(request) {
            if (!request.offerId || typeof request.offerId !== "string") {
                return {ok: false};
            }
            const transferId = createToken();
            transfers.set(transferId, {
                transferId,
                port: request.port,
                destinationId: request.senderId,
                offerId: request.offerId,
                destinationRegistered: false,
                destinationHandoffRequested: false,
                destinationHandoffReady: false,
                committed: false,
                destroyOnCancel: false,
            });
            expireUncommitted(transfers.get(transferId));
            const candidates = (options.listWindows?.() || []).filter((windowInfo) =>
                windowInfo.kind === "app" && windowInfo.id !== request.senderId &&
                windowInfo.port?.toString() === request.port?.toString());
            const results = await Promise.allSettled(candidates.map((windowInfo) => options.send(windowInfo.id, {
                action: "locate",
                transferId,
                offerId: request.offerId,
            })));
            results.forEach((result) => {
                if (result.status === "rejected") {
                    log(result.reason);
                }
            });
            return {ok: true, transferId};
        },
        async claim(request) {
            const transfer = transfers.get(request.transferId);
            if (!transfer || transfer.committed || transfer.offerId !== request.offerId ||
                transfer.port?.toString() !== request.port?.toString()) {
                return false;
            }
            if (transfer.sourceId) {
                return transfer.sourceId === request.senderId;
            }
            transfer.sourceId = request.senderId;
            if (transfer.destinationRegistered) {
                void requestDestinationHandoff(transfer).catch(log);
            }
            return true;
        },
        async ready(request) {
            const transfer = transfers.get(request.transferId);
            if (!transfer || transfer.destinationId !== request.senderId) {
                return false;
            }
            if (request.handoff === true) {
                if (!transfer.destinationRegistered || !transfer.destinationHandoffRequested || !transfer.sourceId ||
                    transfer.committed || transfer.settling) {
                    return false;
                }
                if (transfer.destinationHandoffReady) {
                    return Boolean(transfer.sourcePrepared);
                }
                transfer.destinationHandoffReady = true;
                return prepareSource(transfer);
            }
            if (transfer.destinationRegistered) {
                return true;
            }
            transfer.destinationRegistered = true;
            if (transfer.sourceId && !await requestDestinationHandoff(transfer)) {
                return false;
            }
            return true;
        },
        async sourceCommitted(request) {
            const transfer = transfers.get(request.transferId);
            if (!transfer || transfer.sourceId !== request.senderId || !transfer.destinationHandoffReady ||
                !transfer.sourcePrepared || transfer.committed ||
                !isIdentityOnlyElement(request.identity)) {
                return false;
            }
            transfer.committed = true;
            transfer.identity = request.identity;
            try {
                const result = await options.send(transfer.destinationId, {
                    action: "materialize",
                    transferId: request.transferId,
                    identity: request.identity,
                });
                if (!sent(result)) {
                    await failCommitted(transfer);
                    return false;
                }
                if (!transfers.has(transfer.transferId) || transfer.settling) {
                    return false;
                }
                resetCommittedExpiry(transfer);
            } catch (error) {
                log(error);
                await failCommitted(transfer);
                return false;
            }
            return true;
        },
        async materialized(request) {
            const transfer = transfers.get(request.transferId);
            if (!transfer || transfer.destinationId !== request.senderId || !transfer.committed ||
                transfer.materializing || transfer.settling) {
                return false;
            }
            transfer.materializing = true;
            try {
                await options.send(transfer.sourceId, {
                    action: "complete",
                    transferId: request.transferId,
                    completed: true,
                });
            } catch (error) {
                log(error);
            }
            if (!transfers.has(transfer.transferId) || transfer.settling) {
                return false;
            }
            transfer.settling = true;
            try {
                options.showDestination?.(transfer.destinationId);
            } catch (error) {
                log(error);
            }
            settle(transfer, true);
            return true;
        },
        async materializationFailed(request) {
            const transfer = transfers.get(request.transferId);
            if (!transfer || transfer.destinationId !== request.senderId || !transfer.committed) {
                return false;
            }
            await failCommitted(transfer);
            return true;
        },
        async cancel(request) {
            const transfer = transfers.get(request.transferId);
            if (!transfer || transfer.committed ||
                (request.senderId !== transfer.sourceId && request.senderId !== transfer.destinationId) ||
                (transfer.preparingSource && request.senderId !== transfer.sourceId)) {
                return false;
            }
            await failUncommitted(transfer);
            return true;
        },
        async unregister(request) {
            const affected = Array.from(transfers.values()).filter((transfer) =>
                transfer.sourceId === request.senderId || transfer.destinationId === request.senderId);
            for (const transfer of affected) {
                if (transfer.committed) {
                    if (transfer.destinationId === request.senderId) {
                        await failCommitted(transfer);
                    }
                } else {
                    await failUncommitted(transfer);
                }
            }
        },
    };
};

module.exports = {createSymemoTabTransferBroker};
