"use strict";

const intentKey = (intent) => {
    if (!intent || typeof intent.kind !== "string" || typeof intent.requester !== "string" || !intent.requester.trim()) {
        return "unknown";
    }
    const requester = intent.requester.trim();
    if (intent.kind === "workspace-open" || intent.kind === "workspace-replace") {
        if (typeof intent.target !== "string" || !intent.target.trim()) {
            return "unknown";
        }
        const normalizedTarget = intent.target.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/")
            .replace(/^([a-z]):/, (_match, drive) => drive.toUpperCase() + ":")
            .replace(/([^:])\/$/, "$1");
        return intent.kind + ":" + requester + ":" + normalizedTarget;
    }
    if (intent.kind !== "application-exit" && intent.kind !== "update-install") {
        return "unknown";
    }
    return intent.kind + ":" + requester;
};

const reasonForIntent = (intent) => {
    if (intent.kind === "update-install") {
        return "update-install";
    }
    if (intent.kind === "application-exit") {
        return "application-exit";
    }
    return "workspace-switch";
};

const createSymemoAuthoringTransitionBroker = (options) => {
    const transitions = new Map();
    const windows = new Map();
    const registrationWaiters = new Map();
    const createToken = options.createToken || (() => require("crypto").randomBytes(16).toString("hex"));
    const log = options.log || (() => undefined);
    const scheduleRegistrationTimeout = options.scheduleRegistrationTimeout || ((callback) => {
        const timer = setTimeout(callback, 30000);
        timer.unref?.();
        return () => clearTimeout(timer);
    });
    const transitionScope = (request) => request.intent.kind === "update-install" ? "app" : "port:" + request.port;
    const matchesScope = (transition, windowInfo) => transition.scope === "app" ||
        windowInfo.port?.toString() === transition.port?.toString();

    const clear = (transition) => {
        if (transitions.get(transition.scope) === transition) {
            transitions.delete(transition.scope);
        }
    };

    const findOwnedTransition = (request) => {
        if (!request || !request.token || request.port === undefined || request.port === null) {
            return undefined;
        }
        for (const transition of transitions.values()) {
            if (transition.token === request.token && transition.senderId === request.senderId &&
                transition.port.toString() === request.port.toString()) {
                return transition;
            }
        }
        return undefined;
    };

    const addTarget = (transition, windowInfo) => {
        if (windowInfo.kind !== "app" || !matchesScope(transition, windowInfo) || transition.targets.has(windowInfo.id)) {
            return;
        }
        transition.targets.set(windowInfo.id, {prepared: false});
    };

    const addWindowToActiveTransitions = (windowInfo) => {
        for (const transition of transitions.values()) {
            if (!transition.committed) {
                addTarget(transition, windowInfo);
            }
        }
    };

    const resolveRegistration = (windowId, registered) => {
        const waiters = registrationWaiters.get(windowId);
        if (!waiters) {
            return;
        }
        registrationWaiters.delete(windowId);
        waiters.forEach((waiter) => {
            waiter.cancelTimeout();
            waiter.resolve(registered);
        });
    };

    const waitForRegistration = (windowId) => {
        const windowInfo = windows.get(windowId);
        if (!windowInfo) {
            return Promise.resolve(false);
        }
        if (windowInfo.state === "registered") {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            const waiters = registrationWaiters.get(windowId) || new Set();
            let waiter;
            const cancelTimeout = scheduleRegistrationTimeout(() => {
                waiters.delete(waiter);
                if (waiters.size === 0) {
                    registrationWaiters.delete(windowId);
                }
                resolve(false);
            });
            waiter = {resolve, cancelTimeout};
            waiters.add(waiter);
            registrationWaiters.set(windowId, waiters);
        });
    };

    const cancelPrepared = async (transition) => {
        const results = await Promise.allSettled([...transition.prepared].map((windowId) =>
            options.send(windowId, {
                action: "cancel",
                token: transition.token,
                requestId: transition.requestId,
            })));
        results.forEach((result) => {
            if (result.status === "rejected") {
                log(result.reason);
            }
        });
    };

    const failPreparation = async (transition, reason) => {
        await cancelPrepared(transition);
        clear(transition);
        return {allowed: false, reason: reason || "unavailable"};
    };

    const prepare = async (transition) => {
        while (true) {
            const next = Array.from(transition.targets.entries()).find(([, target]) => !target.prepared);
            if (!next) {
                transition.result = {allowed: true, token: transition.token};
                return transition.result;
            }
            const [windowId, target] = next;
            const registered = await waitForRegistration(windowId);
            if (!registered) {
                if (!transition.targets.has(windowId)) {
                    continue;
                }
                return failPreparation(transition, "unavailable");
            }
            const result = await options.send(windowId, {
                action: "prepare",
                token: transition.token,
                requestId: transition.requestId,
                reason: transition.reason,
            });
            if (!result || result.allowed === false) {
                return failPreparation(transition, result?.reason || "unavailable");
            }
            target.prepared = true;
            transition.prepared.add(windowId);
        }
    };

    const broker = {
        markPending(windowInfo) {
            if (!windowInfo || !windowInfo.id || !windowInfo.port || windowInfo.kind !== "app") {
                return false;
            }
            for (const transition of transitions.values()) {
                if (matchesScope(transition, windowInfo) && (transition.committed || transition.result?.allowed)) {
                    return false;
                }
            }
            windows.set(windowInfo.id, {...windowInfo, state: "pending"});
            addWindowToActiveTransitions(windowInfo);
            return true;
        },
        register(request) {
            if (!request || !request.senderId || !request.port || request.kind !== "app") {
                return false;
            }
            const windowInfo = {id: request.senderId, port: request.port, kind: request.kind, state: "registered"};
            for (const transition of transitions.values()) {
                if (matchesScope(transition, windowInfo) && (transition.committed ||
                    (transition.result?.allowed && !transition.targets.has(windowInfo.id)))) {
                    return false;
                }
            }
            windows.set(windowInfo.id, windowInfo);
            addWindowToActiveTransitions(windowInfo);
            resolveRegistration(windowInfo.id, true);
            return true;
        },
        unregister(request) {
            if (!request || !request.senderId) {
                return false;
            }
            const existed = windows.delete(request.senderId);
            resolveRegistration(request.senderId, false);
            for (const transition of Array.from(transitions.values())) {
                transition.targets.delete(request.senderId);
                transition.prepared.delete(request.senderId);
                if (transition.committed && transition.targets.size === 0) {
                    clear(transition);
                }
            }
            return existed;
        },
        async begin(request) {
            if (!request || !request.senderId || !request.port || typeof request.requestId !== "string" ||
                !request.requestId || intentKey(request.intent) === "unknown") {
                return {allowed: false, reason: "unavailable"};
            }
            const scope = transitionScope(request);
            const key = intentKey(request.intent);
            if (transitions.has("app") || (scope === "app" && transitions.size > 0)) {
                return {allowed: false, reason: "busy"};
            }
            const active = transitions.get(scope);
            if (active) {
                if (!active.committed && active.senderId === request.senderId && active.requestId === request.requestId &&
                    active.key === key) {
                    return active.result || active.promise;
                }
                return {allowed: false, reason: "busy"};
            }

            for (const windowInfo of options.listWindows(request)) {
                if (!windows.has(windowInfo.id)) {
                    windows.set(windowInfo.id, {...windowInfo, state: "registered"});
                }
            }
            const transition = {
                scope,
                key,
                senderId: request.senderId,
                requestId: request.requestId,
                port: request.port,
                token: createToken(),
                reason: reasonForIntent(request.intent),
                kind: request.intent.kind,
                targets: new Map(),
                prepared: new Set(),
                committed: false,
                consumed: false,
            };
            for (const windowInfo of windows.values()) {
                if (windowInfo.state === "registered") {
                    addTarget(transition, windowInfo);
                }
            }
            for (const windowInfo of windows.values()) {
                if (windowInfo.state !== "registered") {
                    addTarget(transition, windowInfo);
                }
            }
            transition.promise = prepare(transition).catch(async (error) => {
                log(error);
                return failPreparation(transition, "unavailable");
            });
            transitions.set(scope, transition);
            return transition.promise;
        },
        async commit(request) {
            const transition = findOwnedTransition(request);
            if (!transition) {
                return false;
            }
            if (transition.committed) {
                return true;
            }
            const results = await Promise.allSettled([...transition.prepared].map((windowId) =>
                options.send(windowId, {action: "commit", token: transition.token})));
            results.forEach((result) => {
                if (result.status === "rejected" || !result.value || result.value.allowed === false) {
                    log(result.status === "rejected" ? result.reason : "authoring renderer commit ACK unavailable");
                }
            });
            transition.committed = true;
            return true;
        },
        async cancel(request) {
            const transition = findOwnedTransition(request);
            if (!transition || transition.committed) {
                return false;
            }
            await cancelPrepared(transition);
            clear(transition);
            return true;
        },
        consumeCommitted(request) {
            const transition = findOwnedTransition(request);
            if (!transition || !transition.committed || transition.consumed ||
                (Array.isArray(request.allowedKinds) && !request.allowedKinds.includes(transition.kind))) {
                return false;
            }
            transition.consumed = true;
            return true;
        },
        authorizePrepared(request) {
            const transition = findOwnedTransition(request);
            if (!transition || transition.committed || transition.consumed || !transition.result?.allowed) {
                return false;
            }
            return intentKey(request.intent) === transition.key;
        },
    };
    return broker;
};

module.exports = {createSymemoAuthoringTransitionBroker, intentKey};
