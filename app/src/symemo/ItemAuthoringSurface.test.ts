import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import type {ElementDetailView, ItemAuthoringResult, ItemQAChangeResult, ModelTransitionReason} from "./types";
import {deferred, TestDocument, TestElement} from "./testDom";

const stubPaths = [require.resolve("./api")];
const originalModules = stubPaths.map((modulePath) => require.cache[modulePath]);
let ItemAuthoringSurface: typeof import("./ItemAuthoringSurface").ItemAuthoringSurface;
let getAuthoringImpl: (elementId: string) => Promise<ItemAuthoringResult>;
let saveItemImpl: (elementId: string, revision: string, prompt: string, answer: string) => Promise<ItemQAChangeResult>;
let loadCalls: string[];
let saveCalls: Array<{elementId: string; revision: string; prompt: string; answer: string}>;
let testDocument: TestDocument;

before(async () => {
    require.cache[stubPaths[0]] = {exports: {
        getItemAuthoring: (elementId: string) => {
            loadCalls.push(elementId);
            return getAuthoringImpl(elementId);
        },
        saveItemQA: (elementId: string, revision: string, prompt: string, answer: string) => {
            saveCalls.push({elementId, revision, prompt, answer});
            return saveItemImpl(elementId, revision, prompt, answer);
        },
    }} as NodeModule;
    (globalThis as unknown as {window: Window}).window = {siyuan: {config: {readonly: false}, languages: {}}} as unknown as Window;
    ({ItemAuthoringSurface} = await import("./ItemAuthoringSurface"));
});

beforeEach(() => {
    testDocument = new TestDocument();
    (globalThis as unknown as {document: Document}).document = testDocument as unknown as Document;
    window.siyuan.config.readonly = false;
    loadCalls = [];
    saveCalls = [];
    getAuthoringImpl = async (elementId) => ({ok: true, authoring: {
        elementId,
        prompt: "Question\n第二行",
        answer: "Answer\n第二行",
        contentRevision: "rev-v1-loaded",
    }});
    saveItemImpl = async (elementId, _revision, prompt, answer) => ({ok: true, change: {
        kind: "SaveItemQA",
        elementId,
        changedField: "itemQA",
        revision: "rev-v1-saved",
        itemQA: {prompt, answer, contentRevision: "rev-v1-saved"},
        changed: true,
        changeAccepted: true,
    }});
});

after(() => {
    stubPaths.forEach((modulePath, index) => {
        if (originalModules[index]) require.cache[modulePath] = originalModules[index];
        else delete require.cache[modulePath];
    });
});

const detail = (): ElementDetailView => ({
    elementId: "item-id",
    rootElementId: "item-id",
    storageKind: "rootDocument",
    type: "item",
    title: "Question",
    sourceMode: "unknown",
    supportStatus: "supported",
    item: {kind: "qa", prompt: "Question", revision: "rev-v1-summary"},
});

const language = (key: string) => ({
    symemoQuestion: "Question",
    symemoAnswer: "Answer",
    symemoItemAuthoringLoading: "Loading Item...",
    symemoItemAuthoringUnavailable: "This Item cannot be edited right now.",
    symemoItemReadOnly: "This Item is read-only.",
    symemoItemQAInvalid: "Question and answer are required.",
    symemoReloadItem: "Reload Item",
    symemoSavePending: "Pending",
    symemoSaving: "Saving",
    symemoSaved: "Saved",
    symemoSaveFailed: "Save failed",
    symemoAcceptedRecovering: "Saved; reconnecting...",
    symemoRevisionConflict: "Changed elsewhere",
    retry: "Retry",
}[key] || "");

const makeSurface = (overrides: Record<string, unknown> = {}) => {
    const container = testDocument.createElement("div");
    const surface = new ItemAuthoringSurface({container: container as unknown as HTMLElement, language, debounceMs: -1, ...overrides});
    return {container, surface};
};

const input = (container: TestElement, role: "prompt" | "answer") =>
    container.querySelector(`textarea[data-role="${role}"]`) as TestElement;

describe("ItemAuthoringSurface", () => {
    it("loads explicit authoring and renders two programmatically associated writable textareas", async () => {
        const {container, surface} = makeSurface();
        await surface.mount(detail());

        assert.deepEqual(loadCalls, ["item-id"]);
        const prompt = input(container, "prompt");
        const answer = input(container, "answer");
        assert.equal(prompt.value, "Question\n第二行");
        assert.equal(answer.value, "Answer\n第二行");
        assert.equal(prompt.getAttribute("id"), "symemo-item-prompt-item-id");
        assert.equal(answer.getAttribute("id"), "symemo-item-answer-item-id");
        assert.equal(container.querySelector('[data-role="prompt-label"]')?.getAttribute("for"), prompt.getAttribute("id"));
        assert.equal(container.querySelector('[data-role="answer-label"]')?.getAttribute("for"), answer.getAttribute("id"));
        assert.equal(container.querySelector('[data-role="status"]')?.getAttribute("aria-live"), "polite");
        assert.equal(container.querySelector('[data-role="status"]')?.textContent, "Saved");
    });

    it("renders semantic read-only Question and Answer sections with no editable controls or save", async () => {
        window.siyuan.config.readonly = true;
        const {container, surface} = makeSurface();
        await surface.mount(detail());

        assert.deepEqual(loadCalls, ["item-id"]);
        assert.equal(container.querySelector("textarea"), null);
        assert.equal(container.querySelector('[data-role="prompt-readonly"]')?.textContent, "Question\n第二行");
        assert.equal(container.querySelector('[data-role="answer-readonly"]')?.textContent, "Answer\n第二行");
        assert.equal(container.querySelector('[data-role="status"]')?.textContent, "This Item is read-only.");
        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: true});
        assert.equal(saveCalls.length, 0);
    });

    it("offers an explicit retry after the initial authoring load fails", async () => {
        let attempts = 0;
        getAuthoringImpl = async (elementId) => {
            attempts++;
            return attempts === 1
                ? {ok: false, failure: {errorCode: "request", retryable: true, kind: "request"}}
                : {ok: true, authoring: {
                    elementId,
                    prompt: "Recovered question",
                    answer: "Recovered answer",
                    contentRevision: "rev-v1-recovered",
                }};
        };
        const readiness: boolean[] = [];
        const {container, surface} = makeSurface({onTransitionReadyChange: (ready: boolean) => readiness.push(ready)});

        await surface.mount(detail());
        const retry = container.querySelector('[data-action="retry"]') as TestElement;
        assert.ok(retry);
        assert.equal(container.querySelector('[data-role="status"]')?.textContent, "This Item cannot be edited right now.");
        assert.equal(readiness.at(-1), false);

        retry.dispatch("click");
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.deepEqual(loadCalls, ["item-id", "item-id"]);
        assert.equal(input(container, "prompt").value, "Recovered question");
        assert.equal(input(container, "answer").value, "Recovered answer");
        assert.equal(readiness.at(-1), true);
    });

    it("autosaves and flushes the complete aggregate pair", async () => {
        const {container, surface} = makeSurface({debounceMs: 5});
        await surface.mount(detail());
        input(container, "prompt").value = "New prompt";
        input(container, "prompt").dispatch("input");
        input(container, "answer").value = "New answer";
        input(container, "answer").dispatch("input");

        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(saveCalls, [{elementId: "item-id", revision: "rev-v1-loaded", prompt: "New prompt", answer: "New answer"}]);
        assert.equal(container.querySelector('[data-role="status"]')?.textContent, "Saved");

        input(container, "prompt").value = "Flush prompt";
        input(container, "prompt").dispatch("input");
        assert.deepEqual(await surface.prepareTransition("target-change"), {allowed: true});
        assert.equal(saveCalls.at(-1)?.prompt, "Flush prompt");
        assert.equal(saveCalls.at(-1)?.answer, "New answer");
    });

    it("preserves invalid fields and blocks transitions", async () => {
        const {container, surface} = makeSurface();
        await surface.mount(detail());
        input(container, "prompt").value = " \t\n";
        input(container, "prompt").dispatch("input");

        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: false, reason: "save-failed"});
        assert.equal(input(container, "prompt").value, " \t\n");
        assert.equal(input(container, "answer").value, "Answer\n第二行");
        assert.equal(container.querySelector('[data-role="status"]')?.textContent, "Question and answer are required.");
        assert.equal(saveCalls.length, 0);
    });

    it("shows retry, reload/compare, and accepted-recovery states without losing the draft", async () => {
        const responses: ItemQAChangeResult[] = [
            {ok: false, failure: {kind: "failed", errorCode: "request", retryable: true, acceptanceUnknown: true}},
            {ok: false, failure: {kind: "conflict", elementId: "item-id", changedField: "itemQA", currentRevision: "rev-v1-current"}},
            {ok: false, failure: {kind: "acceptedRecovering", change: {
                kind: "SaveItemQA", elementId: "item-id", changedField: "itemQA", revision: "rev-v1-accepted",
                itemQA: {prompt: "Local prompt", answer: "Local answer", contentRevision: "rev-v1-accepted"},
                changed: true, changeAccepted: true,
            }}},
        ];
        saveItemImpl = async () => responses.shift()!;
        const {container, surface} = makeSurface();
        await surface.mount(detail());
        input(container, "prompt").value = "Local prompt";
        input(container, "prompt").dispatch("input");
        input(container, "answer").value = "Local answer";
        input(container, "answer").dispatch("input");

        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: false, reason: "unavailable"});
        assert.ok(container.querySelector('[data-action="retry"]'));
        assert.equal(input(container, "prompt").getAttribute("disabled"), "disabled");
        assert.equal(input(container, "answer").getAttribute("disabled"), "disabled");
        (container.querySelector('[data-action="retry"]') as TestElement).dispatch("click");
        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: false, reason: "conflict"});
        assert.ok(container.querySelector('[data-action="reload"]'));
        assert.ok(container.querySelector('[data-role="compare"]'));
        assert.equal(input(container, "prompt").value, "Local prompt");
        assert.equal(input(container, "answer").value, "Local answer");

        (container.querySelector('[data-action="reload"]') as TestElement).dispatch("click");
        await Promise.resolve();
        assert.equal(input(container, "prompt").value, "Question\n第二行");

        input(container, "prompt").value = "Local prompt";
        input(container, "prompt").dispatch("input");
        input(container, "answer").value = "Local answer";
        input(container, "answer").dispatch("input");
        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: false, reason: "unavailable"});
        assert.equal(container.querySelector('[data-role="status"]')?.textContent, "Saved; reconnecting...");
    });

    it("honors every existing transition reason through one aggregate flush", async () => {
        const reasons: ModelTransitionReason[] = [
            "target-change", "surface-replacement", "tab-close", "batch-close", "tab-eviction", "tab-detach",
            "cross-window-transfer", "window-close", "workspace-switch", "application-exit", "update-install",
        ];
        for (const reason of reasons) {
            const {container, surface} = makeSurface();
            await surface.mount(detail());
            input(container, "prompt").value = `Prompt ${reason}`;
            input(container, "prompt").dispatch("input");
            assert.deepEqual(await surface.prepareTransition(reason), {allowed: true}, reason);
            surface.destroy();
        }
        assert.equal(saveCalls.length, reasons.length);
    });

    it("focuses the prompt, blocks interaction behind a window barrier, and cleans up idempotently", async () => {
        const {container, surface} = makeSurface();
        await surface.mount(detail());
        surface.focus();
        assert.equal(input(container, "prompt").focused, true);
        surface.setWindowBarrier(true);
        assert.equal(input(container, "prompt").getAttribute("disabled"), "disabled");
        surface.destroy();
        surface.destroy();
        assert.equal(container.children.length, 0);
        assert.deepEqual(await surface.prepareTransition("tab-close"), {allowed: false, reason: "unavailable"});
    });

    it("ignores an explicit authoring response after cleanup", async () => {
        const pending = deferred<ItemAuthoringResult>();
        getAuthoringImpl = () => pending.promise;
        const {container, surface} = makeSurface();
        const mounting = surface.mount(detail());
        surface.destroy();
        pending.resolve({ok: true, authoring: {elementId: "item-id", prompt: "Late prompt", answer: "Late answer", contentRevision: "rev-v1-late"}});
        await mounting;

        assert.equal(container.children.length, 0);
        assert.equal(saveCalls.length, 0);
    });

    it("exposes no learning, answer-reveal, grade, event, or navigation method", () => {
        const {surface} = makeSurface();
        for (const forbidden of ["start", "current", "showAnswer", "grade", "next", "stop", "eventId", "runLearningAction"]) {
            assert.equal(forbidden in surface, false, forbidden);
        }
    });
});
