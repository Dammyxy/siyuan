import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {ItemAuthoringSession} from "./itemAuthoring";
import type {AcceptedItemQAChange, ItemAuthoringResult, ItemQAChangeResult} from "./types";

const accepted = (
    prompt: string,
    answer: string,
    revision: string,
    changed = true,
): ItemQAChangeResult => ({
    ok: true,
    change: {
        kind: "SaveItemQA",
        elementId: "item-id",
        changedField: "itemQA",
        revision,
        itemQA: {prompt, answer, contentRevision: revision},
        changed,
        changeAccepted: true,
    },
});

const loaded = (prompt = "Prompt", answer = "Answer", revision = "rev-v1-1"): ItemAuthoringResult => ({
    ok: true,
    authoring: {elementId: "item-id", prompt, answer, contentRevision: revision},
});

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    return {promise, resolve};
};

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("ItemAuthoringSession aggregate draft", () => {
    it("loads the complete explicit authoring pair as one clean baseline", async () => {
        const session = new ItemAuthoringSession({
            elementId: "item-id",
            getItemAuthoring: async () => loaded("Question\n第二行", "Answer\n第二行", "rev-v1-loaded"),
            saveItemQA: async () => { throw new Error("must not save"); },
        });

        assert.equal(session.snapshot().state, "loading");
        assert.deepEqual(await session.load(), {ok: true});
        assert.deepEqual(session.snapshot(), {
            state: "clean",
            localPrompt: "Question\n第二行",
            localAnswer: "Answer\n第二行",
            baselinePrompt: "Question\n第二行",
            baselineAnswer: "Answer\n第二行",
            revision: "rev-v1-loaded",
            localGeneration: 0,
            acknowledgedGeneration: 0,
        });
    });

    it("coalesces prompt and answer edits into one debounced aggregate save", async () => {
        const calls: Array<{revision: string; prompt: string; answer: string}> = [];
        const session = new ItemAuthoringSession({
            elementId: "item-id",
            getItemAuthoring: async () => loaded(),
            saveItemQA: async (_id, revision, prompt, answer) => {
                calls.push({revision, prompt, answer});
                return accepted(prompt, answer, "rev-v1-2");
            },
            debounceMs: 5,
        });
        await session.load();

        session.editPrompt("Question one");
        session.editAnswer("Answer one");
        session.editPrompt("Question final");
        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.deepEqual(calls, [{revision: "rev-v1-1", prompt: "Question final", answer: "Answer one"}]);
        assert.equal(session.snapshot().state, "clean");
        assert.equal(session.snapshot().localGeneration, 3);
        assert.equal(session.snapshot().acknowledgedGeneration, 3);
    });

    it("blocks flush for an invalid pair without discarding either local field", async () => {
        let saves = 0;
        const session = new ItemAuthoringSession({
            elementId: "item-id",
            getItemAuthoring: async () => loaded(),
            saveItemQA: async () => { saves++; return accepted("", "", "rev-v1-bad"); },
            debounceMs: -1,
        });
        await session.load();
        session.editPrompt(" \t\n");
        session.editAnswer("  retained answer  ");

        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "save-failed"});
        assert.equal(session.snapshot().state, "invalid");
        assert.equal(session.snapshot().localPrompt, " \t\n");
        assert.equal(session.snapshot().localAnswer, "  retained answer  ");
        assert.equal(saves, 0);
    });

    it("adopts changed and no-op canonical pairs without inventing field revisions", async () => {
        const responses = [
            accepted("Canonical prompt", "Canonical answer", "rev-v1-2", true),
            accepted("Canonical prompt", "Canonical answer", "rev-v1-2", false),
        ];
        const session = new ItemAuthoringSession({
            elementId: "item-id",
            getItemAuthoring: async () => loaded(),
            saveItemQA: async () => responses.shift()!,
            debounceMs: -1,
        });
        await session.load();
        session.editPrompt("Submitted prompt");
        session.editAnswer("Submitted answer");
        assert.deepEqual(await session.flush("target-change"), {allowed: true});
        assert.equal(session.snapshot().revision, "rev-v1-2");
        assert.equal(session.snapshot().baselinePrompt, "Canonical prompt");
        assert.equal(session.snapshot().baselineAnswer, "Canonical answer");

        session.editPrompt("Canonical prompt");
        assert.deepEqual(await session.flush("surface-replacement"), {allowed: true});
        assert.equal(session.snapshot().state, "clean");
        assert.equal(session.snapshot().revision, "rev-v1-2");
    });

    it("retains the complete local pair and current revision on stale conflict", async () => {
        const session = new ItemAuthoringSession({
            elementId: "item-id",
            getItemAuthoring: async () => loaded(),
            saveItemQA: async () => ({ok: false, failure: {
                kind: "conflict",
                elementId: "item-id",
                changedField: "itemQA",
                currentRevision: "rev-v1-current",
            }}),
            debounceMs: -1,
        });
        await session.load();
        session.editPrompt("Local prompt");
        session.editAnswer("Local answer");

        assert.deepEqual(await session.flush("application-exit"), {allowed: false, reason: "conflict"});
        assert.equal(session.snapshot().state, "conflict");
        assert.equal(session.snapshot().localPrompt, "Local prompt");
        assert.equal(session.snapshot().localAnswer, "Local answer");
        assert.equal(session.snapshot().conflictRevision, "rev-v1-current");
    });

    it("distinguishes pre-acceptance failure from accepted recovery and preserves drafts", async () => {
        const acceptedChange: AcceptedItemQAChange = (accepted("Saved prompt", "Saved answer", "rev-v1-2") as Extract<ItemQAChangeResult, {ok: true}>).change;
        const responses: ItemQAChangeResult[] = [
            {ok: false, failure: {kind: "failed", errorCode: "request", retryable: true, acceptanceUnknown: true}},
            {ok: false, failure: {kind: "acceptedRecovering", change: acceptedChange}},
        ];
        const session = new ItemAuthoringSession({
            elementId: "item-id",
            getItemAuthoring: async () => loaded(),
            saveItemQA: async () => responses.shift()!,
            debounceMs: -1,
        });
        await session.load();
        session.editPrompt("Saved prompt");
        session.editAnswer("Saved answer");

        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "unavailable"});
        assert.equal(session.snapshot().state, "acceptanceUnknown");
        assert.equal(session.retry(), true);
        assert.deepEqual(await session.flush("tab-close"), {allowed: false, reason: "unavailable"});
        assert.equal(session.snapshot().state, "acceptedRecovering");
        assert.equal(session.snapshot().revision, "rev-v1-2");
        assert.equal(session.snapshot().localPrompt, "Saved prompt");
        assert.equal(session.snapshot().localAnswer, "Saved answer");
    });

    it("locks an acceptance-unknown submitted pair and retries only those exact facts", async () => {
        const calls: Array<{revision: string; prompt: string; answer: string}> = [];
        const session = new ItemAuthoringSession({
            elementId: "item-id",
            getItemAuthoring: async () => loaded(),
            saveItemQA: async (_elementId, revision, prompt, answer) => {
                calls.push({revision, prompt, answer});
                return calls.length === 1
                    ? {ok: false, failure: {kind: "failed", errorCode: "request", retryable: true, acceptanceUnknown: true}}
                    : accepted(prompt, answer, "rev-v1-reconciled");
            },
            debounceMs: -1,
        });
        await session.load();
        session.editPrompt("Submitted prompt");
        session.editAnswer("Submitted answer");

        assert.deepEqual(await session.flush("target-change"), {allowed: false, reason: "unavailable"});
        assert.equal(session.snapshot().state, "acceptanceUnknown");
        session.editPrompt("Different prompt");
        session.editAnswer("Different answer");
        assert.equal(session.snapshot().localPrompt, "Submitted prompt");
        assert.equal(session.snapshot().localAnswer, "Submitted answer");
        assert.equal(session.retry(), true);
        assert.deepEqual(await session.flush("target-change"), {allowed: true});
        assert.deepEqual(calls, [
            {revision: "rev-v1-1", prompt: "Submitted prompt", answer: "Submitted answer"},
            {revision: "rev-v1-1", prompt: "Submitted prompt", answer: "Submitted answer"},
        ]);
    });

    it("keeps newer edits during an in-flight save and submits the latest complete pair next", async () => {
        const first = deferred<ItemQAChangeResult>();
        const calls: Array<{revision: string; prompt: string; answer: string}> = [];
        const session = new ItemAuthoringSession({
            elementId: "item-id",
            getItemAuthoring: async () => loaded(),
            saveItemQA: async (_id, revision, prompt, answer) => {
                calls.push({revision, prompt, answer});
                return calls.length === 1 ? first.promise : accepted(prompt, answer, "rev-v1-3");
            },
            debounceMs: -1,
        });
        await session.load();
        session.editPrompt("First prompt");
        session.editAnswer("First answer");
        const flush = session.flush("tab-close");
        await nextTurn();
        session.editPrompt("Newer prompt");
        session.editAnswer("Newer answer");
        first.resolve(accepted("First prompt", "First answer", "rev-v1-2"));

        assert.deepEqual(await flush, {allowed: true});
        assert.deepEqual(calls, [
            {revision: "rev-v1-1", prompt: "First prompt", answer: "First answer"},
            {revision: "rev-v1-2", prompt: "Newer prompt", answer: "Newer answer"},
        ]);
        assert.equal(session.snapshot().localPrompt, "Newer prompt");
        assert.equal(session.snapshot().localAnswer, "Newer answer");
        assert.equal(session.snapshot().revision, "rev-v1-3");
    });

    it("reloads accepted recovery from explicit authority and destroy cancels later debounce", async () => {
        let loads = 0;
        let saves = 0;
        const session = new ItemAuthoringSession({
            elementId: "item-id",
            getItemAuthoring: async () => {
                loads++;
                return loads === 1 ? loaded() : loaded("Recovered prompt", "Recovered answer", "rev-v1-recovered");
            },
            saveItemQA: async () => { saves++; return accepted("Edited", "Answer", "rev-v1-2"); },
            debounceMs: 5,
        });
        await session.load();
        session.editPrompt("Edited");
        assert.deepEqual(await session.reload(), {ok: true});
        assert.equal(session.snapshot().localPrompt, "Recovered prompt");
        assert.equal(session.snapshot().localAnswer, "Recovered answer");
        session.editPrompt("Never saved");
        session.destroy();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(saves, 1);
    });
});
