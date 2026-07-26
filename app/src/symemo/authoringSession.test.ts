import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {AuthoringSession} from "./authoringSession";
import type {AcceptedElementChange, ElementChangeResult, ElementDetailResult} from "./types";

const accepted = (
    changedField: "title" | "material",
    canonicalValue: string,
    revision: string,
): ElementChangeResult => ({
    ok: true,
    change: {
        kind: changedField === "title" ? "RenameElement" : "SaveTopicHTML",
        elementId: "topic-id",
        changedField,
        canonicalValue,
        revision,
        changed: true,
        changeAccepted: true,
    },
});

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return {promise, resolve};
};

const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

const writableDetail = (title = "Authority", html = "<p>Authority</p>"): ElementDetailResult => ({
    ok: true,
    element: {
        elementId: "topic-id",
        rootElementId: "topic-id",
        storageKind: "rootDocument",
        type: "topic",
        title,
        titleRevision: "rev-title-authority",
        sourceMode: "html",
        supportStatus: "supported",
        topicMaterial: {
            kind: "html",
            html,
            cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            revision: "rev-material-authority",
        },
    },
});

describe("AuthoringSession", () => {
    it("saves through its own debounce timer without a surface flush", async () => {
        const calls: Array<{field: string; revision: string; value: string}> = [];
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Initial</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 5,
            saveTitle: async (_elementId, revision, title) => {
                calls.push({field: "title", revision, value: title});
                return accepted("title", title, "rev-title-2");
            },
            saveMaterial: async (_elementId, revision, html) => {
                calls.push({field: "material", revision, value: html});
                return accepted("material", html, "rev-material-2");
            },
        });

        session.editMaterial("<p>Debounced final</p>");
        await sleep(30);

        assert.deepEqual(calls, [{
            field: "material",
            revision: "rev-material-1",
            value: "<p>Debounced final</p>",
        }]);
        assert.equal(session.getStatus(), "clean");
    });

    it("serializes title and material saves through one queue and coalesces rapid edits", async () => {
        const calls: Array<{field: string; revision: string; value: string}> = [];
        const first = deferred<ElementChangeResult>();
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Old title",
            html: "<p>Old</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 256,
            saveTitle: async (elementId, revision, title) => {
                calls.push({field: "title", revision, value: title});
                assert.equal(elementId, "topic-id");
                return accepted("title", title, "rev-title-2");
            },
            saveMaterial: (elementId, revision, html) => {
                calls.push({field: "material", revision, value: html});
                assert.equal(elementId, "topic-id");
                return first.promise;
            },
        });

        const previousNow = Date.now;
        let now = 1_000;
        Date.now = () => now++;
        try {
            session.editMaterial("<p>One</p>");
            session.editMaterial("<p>Final</p>");
            session.editTitle("New title");
        } finally {
            Date.now = previousNow;
        }

        const flush = session.flush("tab-close");
        await Promise.resolve();
        assert.deepEqual(calls, [{field: "material", revision: "rev-material-1", value: "<p>Final</p>"}]);

        first.resolve(accepted("material", "<p>Final</p>", "rev-material-2"));
        assert.deepEqual(await flush, {allowed: true});
        assert.deepEqual(calls, [
            {field: "material", revision: "rev-material-1", value: "<p>Final</p>"},
            {field: "title", revision: "rev-title-1", value: "New title"},
        ]);
        assert.equal(session.getStatus(), "clean");
    });

    it("uses the title as the deterministic tie-breaker for equal dirty timestamps", async () => {
        const calls: string[] = [];
        const previousNow = Date.now;
        Date.now = () => 1_000;
        try {
            const session = new AuthoringSession({
                elementId: "topic-id",
                title: "Old title",
                html: "<p>Old</p>",
                titleRevision: "rev-title-1",
                materialRevision: "rev-material-1",
                debounceMs: -1,
                saveTitle: async (_elementId, _revision, title) => {
                    calls.push(`title:${title}`);
                    return accepted("title", title, "rev-title-2");
                },
                saveMaterial: async (_elementId, _revision, html) => {
                    calls.push(`material:${html}`);
                    return accepted("material", html, "rev-material-2");
                },
            });

            session.editMaterial("<p>New</p>");
            session.editTitle("New title");
            assert.deepEqual(await session.flush("tab-close"), {allowed: true});
            assert.deepEqual(calls, ["title:New title", "material:<p>New</p>"]);
        } finally {
            Date.now = previousNow;
        }
    });

    it("acknowledges stale accepted responses without replacing newer local values", async () => {
        const materialResponses = [
            accepted("material", "<p>Server first</p>", "rev-material-2"),
            accepted("material", "<p>Local newer</p>", "rev-material-3"),
        ];
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Old</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => materialResponses.shift()!,
        });

        session.editMaterial("<p>First</p>");
        const flush = session.flush("target-change");
        session.editMaterial("<p>Local newer</p>");

        assert.deepEqual(await flush, {allowed: true});
        assert.deepEqual(session.snapshot().material, {
            localValue: "<p>Local newer</p>",
            canonicalBaseline: "<p>Local newer</p>",
            revision: "rev-material-3",
            state: "clean",
        });
    });

    it("blocks transitions on conflicts while allowing the other field to continue", async () => {
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Old</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => ({
                ok: false,
                failure: {
                    kind: "conflict",
                    elementId: "topic-id",
                    changedField: "material",
                    currentRevision: "rev-material-current",
                },
            }),
        });

        session.editMaterial("<p>Conflict</p>");
        session.editTitle("Safe title");

        assert.deepEqual(await session.flush("application-exit"), {allowed: false, reason: "conflict"});
        assert.equal(session.snapshot().title.revision, "rev-title-2");
        assert.equal(session.snapshot().material.state, "conflict");
        assert.equal(session.getStatus(), "conflict");
    });

    it("latches conflicts so later input cannot ordinary-retry a stale revision", async () => {
        let materialSaves = 0;
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Old</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-stale",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => {
                materialSaves++;
                if (materialSaves > 1) {
                    throw new Error("conflicted material was retried");
                }
                return {
                    ok: false,
                    failure: {
                        kind: "conflict",
                        elementId: "topic-id",
                        changedField: "material",
                        currentRevision: "rev-material-current",
                    },
                };
            },
        });

        session.editMaterial("<p>Conflicted</p>");
        assert.deepEqual(await session.flush("target-change"), {allowed: false, reason: "conflict"});

        session.editMaterial("<p>Still local</p>");
        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "conflict"});
        assert.equal(materialSaves, 1);
        assert.equal(session.snapshot().material.localValue, "<p>Still local</p>");
        assert.equal(session.snapshot().material.conflictRevision, "rev-material-current");
    });

    it("exposes retry metadata and retries only explicit retryable failures", async () => {
        const results: ElementChangeResult[] = [
            {
                ok: false,
                failure: {
                    kind: "failed",
                    errorCode: "request",
                    retryable: true,
                    acceptanceUnknown: true,
                },
            },
            accepted("material", "<p>Retried</p>", "rev-material-2"),
        ];
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Old</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => results.shift()!,
        });

        session.editMaterial("<p>Retried</p>");
        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "save-failed"});
        assert.deepEqual(session.snapshot().material.failure, {
            errorCode: "request",
            retryable: true,
            acceptanceUnknown: true,
        });
        assert.equal(session.snapshot().material.canRetry, true);

        assert.equal(session.retryFailed("material"), true);
        assert.deepEqual(await session.flush("tab-close"), {allowed: true});
        assert.equal(session.snapshot().material.state, "clean");
    });

    it("does not expose Retry for element-write-partial", async () => {
        let calls = 0;
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Old</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => {
                calls++;
                return {
                    ok: false,
                    failure: {
                        kind: "failed" as const,
                        errorCode: "element-write-partial",
                        retryable: false,
                        acceptanceUnknown: true,
                    },
                };
            },
        });

        session.editMaterial("<p>Ambiguous</p>");
        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "save-failed"});
        assert.equal(session.snapshot().material.canRetry, false);
        assert.equal(session.retryFailed("material"), false);
        assert.equal(session.snapshot().material.state, "failed");

        session.editMaterial("<p>Do not blind retry</p>");
        await sleep(5);
        assert.equal(calls, 1);
        assert.equal(session.snapshot().material.state, "failed");
    });

    it("deduplicates repeated flush calls and exposes accepted-recovering as transition-ready only when clean", async () => {
        let saves = 0;
        const acceptedRecoveringChange: AcceptedElementChange = {
            kind: "SaveTopicHTML",
            elementId: "topic-id",
            changedField: "material",
            canonicalValue: "<p>Accepted</p>",
            revision: "rev-material-2",
            changed: true,
            changeAccepted: true,
        };
        const response = deferred<ElementChangeResult>();
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Old</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => {
                saves++;
                return response.promise;
            },
        });

        session.editMaterial("<p>Accepted</p>");
        const first = session.flush("tab-close");
        const second = session.flush("tab-close");
        assert.strictEqual(first, second);
        response.resolve({ok: false, failure: {kind: "acceptedRecovering", change: acceptedRecoveringChange}});

        assert.deepEqual(await first, {allowed: true});
        assert.equal(saves, 1);
        assert.equal(session.getStatus(), "acceptedRecovering");
    });

    it("keeps accepted-recovering transition-blocked when a newer local edit exists", async () => {
        const response = deferred<ElementChangeResult>();
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Old</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => response.promise,
        });

        session.editMaterial("<p>Accepted</p>");
        const flush = session.flush("tab-close");
        session.editMaterial("<p>Newer local</p>");
        response.resolve({
            ok: false,
            failure: {
                kind: "acceptedRecovering",
                change: {
                    kind: "SaveTopicHTML",
                    elementId: "topic-id",
                    changedField: "material",
                    canonicalValue: "<p>Accepted</p>",
                    revision: "rev-material-2",
                    changed: true,
                    changeAccepted: true,
                },
            },
        });

        assert.deepEqual(await flush, {allowed: false, reason: "unavailable"});
        assert.equal(session.getStatus(), "acceptedRecovering");
        assert.equal(session.snapshot().material.localValue, "<p>Newer local</p>");
    });

    it("deduplicates reload recovery and blocks edit generations while reloading authority", async () => {
        const authority = deferred<ElementDetailResult>();
        let queries = 0;
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Local title",
            html: "<p>Local</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => ({
                ok: false,
                failure: {
                    kind: "conflict",
                    elementId: "topic-id",
                    changedField: "material",
                    currentRevision: "rev-material-current",
                },
            }),
            getElement: async () => {
                queries++;
                return authority.promise;
            },
        });

        session.editMaterial("<p>Conflicted</p>");
        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "conflict"});

        const first = session.reloadFromAuthority();
        const second = session.reloadFromAuthority();
        assert.strictEqual(first, second);
        assert.equal(session.snapshot().recovery.interactionBarrierActive, true);
        session.editTitle("ignored while recovering");
        authority.resolve(writableDetail("Authority title", "<p>Authority body</p>"));

        assert.deepEqual(await first, {ok: true, kind: "reloaded"});
        assert.equal(queries, 1);
        assert.equal(session.snapshot().title.localValue, "Authority title");
        assert.equal(session.snapshot().material.localValue, "<p>Authority body</p>");
        assert.equal(session.getStatus(), "clean");
    });

    it("flushes the safe non-conflicting field before Reload queries authority", async () => {
        const calls: string[] = [];
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Local title",
            html: "<p>Local</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: -1,
            saveTitle: async (_elementId, _revision, title) => {
                calls.push(`save-title:${title}`);
                return accepted("title", title, "rev-title-2");
            },
            saveMaterial: async () => ({
                ok: false,
                failure: {
                    kind: "conflict",
                    elementId: "topic-id",
                    changedField: "material",
                    currentRevision: "rev-material-current",
                },
            }),
            getElement: async () => {
                calls.push("get-element");
                return writableDetail("Authority title", "<p>Authority body</p>");
            },
        });

        session.editMaterial("<p>Conflicted</p>");
        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "conflict"});
        session.editTitle("Safe local title");

        assert.deepEqual(await session.reloadFromAuthority(), {ok: true, kind: "reloaded"});
        assert.deepEqual(calls, ["save-title:Safe local title", "get-element"]);
    });

    it("deduplicates save-as-new and preserves the accepted new Element ID", async () => {
        const creations: Array<{title: string; html: string}> = [];
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Original title",
            html: "<p>Original</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => ({
                ok: false,
                failure: {
                    kind: "conflict",
                    elementId: "topic-id",
                    changedField: "material",
                    currentRevision: "rev-material-current",
                },
            }),
            createHTMLTopic: async (title, html) => {
                creations.push({title, html});
                return {
                    ok: true,
                    elementId: "new-topic-id",
                    eventId: "event-id",
                    createAccepted: true,
                    reviewAccepted: true,
                    retryable: false,
                };
            },
        });

        session.editTitle("Complete local title");
        session.editMaterial("<p>Complete local body</p>");
        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "conflict"});

        const first = session.saveAsNew();
        const second = session.saveAsNew();
        assert.strictEqual(first, second);
        session.editTitle("ignored after recovery barrier");

        assert.deepEqual(await first, {ok: true, kind: "preservedAsNew", elementId: "new-topic-id"});
        assert.deepEqual(creations, [{
            title: "Complete local title",
            html: "<p>Complete local body</p>",
        }]);
        assert.equal(session.snapshot().recovery.state, "preservedAsNew");
        assert.equal(session.snapshot().recovery.acceptedElementId, "new-topic-id");
        assert.equal(session.snapshot().recovery.interactionBarrierActive, true);
        session.editTitle("must not mutate the original Topic");
        assert.deepEqual(await session.flush("surface-replacement"), {allowed: true});
        assert.deepEqual(creations, [{
            title: "Complete local title",
            html: "<p>Complete local body</p>",
        }]);
    });

    it("freezes the original session when Save as new reports an accepted creation failure", async () => {
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Local title",
            html: "<p>Local body</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: -1,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async (_elementId, _revision, html) => accepted("material", html, "rev-material-2"),
            createHTMLTopic: async () => ({
                ok: false,
                failure: {
                    errorCode: "review-append-failed",
                    retryable: false,
                    acceptanceUnknown: false,
                    acceptedElementId: "accepted-topic-id",
                },
            }),
        });

        session.editMaterial("<p>Preserved body</p>");
        assert.deepEqual(await session.saveAsNew(), {
            ok: true,
            kind: "preservedAsNew",
            elementId: "accepted-topic-id",
        });
        assert.deepEqual(session.snapshot().recovery, {
            state: "preservedAsNew",
            interactionBarrierActive: true,
            acceptedElementId: "accepted-topic-id",
            errorCode: "review-append-failed",
        });

        session.editMaterial("<p>Must be ignored</p>");
        assert.equal(session.snapshot().material.localValue, "<p>Preserved body</p>");
    });

    it("does not start Reload and Save as new concurrently", async () => {
        const authority = deferred<ElementDetailResult>();
        let creates = 0;
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Local title",
            html: "<p>Local</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: 0,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async () => ({
                ok: false,
                failure: {
                    kind: "conflict",
                    elementId: "topic-id",
                    changedField: "material",
                    currentRevision: "rev-material-current",
                },
            }),
            getElement: async () => authority.promise,
            createHTMLTopic: async () => {
                creates++;
                return {
                    ok: true,
                    elementId: "new-topic-id",
                    eventId: "event-id",
                    createAccepted: true,
                    reviewAccepted: true,
                    retryable: false,
                };
            },
        });

        session.editMaterial("<p>Conflicted</p>");
        await session.flush("tab-close");
        const reload = session.reloadFromAuthority();
        const saveAsNew = await session.saveAsNew();

        assert.deepEqual(saveAsNew, {ok: false, kind: "preserveFailed", errorCode: "busy"});
        assert.equal(creates, 0);
        authority.resolve(writableDetail());
        await reload;
    });

    it("publishes accepted material metadata only after advancing the acknowledged revision", async () => {
        const observations: Array<{revision: string; current: boolean; assignments: unknown}> = [];
        const session = new AuthoringSession({
            elementId: "topic-id",
            title: "Title",
            html: "<p>Old</p>",
            titleRevision: "rev-title-1",
            materialRevision: "rev-material-1",
            debounceMs: -1,
            saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
            saveMaterial: async (_elementId, _revision, html) => ({
                ok: true,
                change: {
                    ...(accepted("material", html, "rev-material-2") as Extract<ElementChangeResult, {ok: true}>).change,
                    nodeIdentityAssignments: [{clientNodeKey: "ck-1", nodeId: "stable-1"}],
                },
            }),
            onAcceptedChange: (change, submittedGenerationIsCurrent) => {
                observations.push({
                    revision: session.snapshot().material.revision,
                    current: submittedGenerationIsCurrent,
                    assignments: change.nodeIdentityAssignments,
                });
            },
        });

        session.editMaterial("<p>New</p>");
        assert.deepEqual(await session.flush("tab-close"), {allowed: true});
        assert.deepEqual(observations, [{
            revision: "rev-material-2",
            current: true,
            assignments: [{clientNodeKey: "ck-1", nodeId: "stable-1"}],
        }]);
    });

    it("settles 100 independent rapid-edit sequences to the final visible material", async () => {
        const trace: string[] = [];
        for (let index = 0; index < 100; index++) {
            const session = new AuthoringSession({
                elementId: `topic-${index}`,
                title: "Title",
                html: "<p>Initial</p>",
                titleRevision: "rev-title-1",
                materialRevision: "rev-material-1",
                debounceMs: 0,
                saveTitle: async (_elementId, _revision, title) => accepted("title", title, "rev-title-2"),
                saveMaterial: async (_elementId, revision, html) => {
                    trace.push(`${index}:${revision}:${html}`);
                    return accepted("material", html, `rev-material-${index}`);
                },
            });
            session.editMaterial(`<p>${index}-draft</p>`);
            session.editMaterial(`<p>${index}-final</p>`);
            assert.deepEqual(await session.flush("target-change"), {allowed: true});
            assert.equal(session.snapshot().material.canonicalBaseline, `<p>${index}-final</p>`);
        }
        assert.equal(trace.length, 100);
    });
});
