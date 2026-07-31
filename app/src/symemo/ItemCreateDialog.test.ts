import {after, before, beforeEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import type {App} from "../index";
import type {CreateItemResult, OpenElementOptions} from "./types";
import {deferred, TestDocument, TestElement} from "./testDom";

interface TestDialogOptions {
    title?: string;
    content: string;
    destroyCallback?: () => void;
}

class TestDialog {
    public readonly element: TestElement;
    public destroyed = false;

    constructor(public readonly options: TestDialogOptions) {
        this.element = testDocument.createElement("div");
        for (const [tag, role] of [
            ["textarea", "prompt"],
            ["textarea", "answer"],
            ["div", "status"],
            ["button", "cancel"],
            ["button", "confirm"],
        ] as const) {
            const element = testDocument.createElement(tag);
            element.setAttribute("data-role", role);
            this.element.append(element);
        }
        dialogInstances.push(this);
    }

    public bindInput(input: TestElement) {
        input.focus();
        input.addEventListener("keydown", (event) => {
            if ((event as KeyboardEvent).key === "Escape") this.destroy();
        });
    }

    public destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.element.isConnected = false;
        this.options.destroyCallback?.();
    }
}

const dialogInstances: TestDialog[] = [];
const createCalls: Array<{elementId: string; prompt: string; answer: string}> = [];
const openCalls: OpenElementOptions[] = [];
let refreshCalls = 0;
let nodeIDCalls = 0;
let createItemImpl: (elementId: string, prompt: string, answer: string) => Promise<CreateItemResult>;
let operationCancelled = false;
let openPrepared = true;
let testDocument: TestDocument;

const stubPaths = [
    require.resolve("../dialog"),
    require.resolve("./api"),
    require.resolve("./authoringRegistry"),
    require.resolve("./openElement"),
];
const originalModules = stubPaths.map((modulePath) => require.cache[modulePath]);
let openItemCreateDialog: typeof import("./ItemCreateDialog").openItemCreateDialog;

before(async () => {
    require.cache[stubPaths[0]] = {exports: {Dialog: TestDialog}} as NodeModule;
    require.cache[stubPaths[1]] = {exports: {
        createItem: async (elementId: string, prompt: string, answer: string) => {
            createCalls.push({elementId, prompt, answer});
            return createItemImpl(elementId, prompt, answer);
        },
    }} as NodeModule;
    require.cache[stubPaths[2]] = {exports: {
        runWindowAuthoringOperation: async (_name: string, callback: (operation: {isCancelled: boolean}) => Promise<void>) => {
            await callback({get isCancelled() { return operationCancelled; }});
            return {started: true};
        },
    }} as NodeModule;
    require.cache[stubPaths[3]] = {exports: {
        prepareNativeElementOpen: async () => openPrepared
            ? {allowed: true, replacementTabId: null as string | null}
            : {allowed: false},
        openElement: (options: OpenElementOptions) => openCalls.push(options),
    }} as NodeModule;
    (globalThis as unknown as {window: Window}).window = {siyuan: {languages: {
        cancel: "Cancel",
        symemoNewItem: "New Item",
        symemoQuestion: "Question",
        symemoAnswer: "Answer",
        symemoCreateItem: "Create Item",
        symemoItemPromptRequired: "Enter a question.",
        symemoItemAnswerRequired: "Enter an answer.",
        symemoCreatingItem: "Creating Item...",
        symemoItemCreateFailed: "Unable to create this Item.",
        symemoItemCreateAcceptedRecovering: "Item created; reconnecting...",
    }}} as unknown as Window;
    (globalThis as unknown as {Lute: {NewNodeID(): string}}).Lute = {
        NewNodeID: () => {
            nodeIDCalls++;
            return "20260731190000-dialog1";
        },
    };
    ({openItemCreateDialog} = await import("./ItemCreateDialog"));
});

beforeEach(() => {
    testDocument = new TestDocument();
    (globalThis as unknown as {document: Document}).document = testDocument as unknown as Document;
    dialogInstances.length = 0;
    createCalls.length = 0;
    openCalls.length = 0;
    refreshCalls = 0;
    nodeIDCalls = 0;
    operationCancelled = false;
    openPrepared = true;
    createItemImpl = async (elementId) => ({ok: true, item: {
        elementId,
        processingState: "processed",
        contentRevision: "rev-v1-created",
        lifecycleState: "pending",
    }});
});

after(() => {
    stubPaths.forEach((modulePath, index) => {
        if (originalModules[index]) require.cache[modulePath] = originalModules[index];
        else delete require.cache[modulePath];
    });
});

const openDialog = () => openItemCreateDialog({
    app: {} as App,
    refreshTree: async () => { refreshCalls++; },
});

const field = (dialog: TestDialog, role: string) => dialog.element.querySelector(`[data-role="${role}"]`) as TestElement;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("ItemCreateDialog native form", () => {
    it("uses localized labels, two multiline fields, and keeps the primary Topic plus outside this dialog", () => {
        openDialog();
        const dialog = dialogInstances[0];

        assert.equal(dialog.options.title, "New Item");
        for (const label of ["Question", "Answer", "Create Item", "Cancel"]) {
            assert.equal(dialog.options.content.includes(label), true);
        }
        assert.equal((dialog.options.content.match(/<textarea/g) || []).length, 2);
        assert.equal(dialog.options.content.includes("data-type=\"add\""), false);
        assert.equal(field(dialog, "prompt").tagName, "TEXTAREA");
        assert.equal(field(dialog, "answer").tagName, "TEXTAREA");
    });

    it("validates whitespace in place and preserves the complete draft", async () => {
        openDialog();
        const dialog = dialogInstances[0];
        field(dialog, "prompt").value = " \t\n";
        field(dialog, "answer").value = "  retained answer  ";

        field(dialog, "confirm").dispatch("click");
        await nextTurn();

        assert.equal(field(dialog, "status").textContent, "Enter a question.");
        assert.equal(field(dialog, "prompt").value, " \t\n");
        assert.equal(field(dialog, "answer").value, "  retained answer  ");
        assert.equal(createCalls.length, 0);
        assert.equal(nodeIDCalls, 0);
    });

    it("cancel, close, and Escape dispose without allocating identity or writing", () => {
        openDialog();
        field(dialogInstances[0], "cancel").dispatch("click");
        openDialog();
        dialogInstances[1].destroy();
        openDialog();
        field(dialogInstances[2], "prompt").dispatch("keydown", {key: "Escape"});

        assert.equal(dialogInstances.every((dialog) => dialog.destroyed), true);
        assert.equal(nodeIDCalls, 0);
        assert.equal(createCalls.length, 0);
    });

    it("keeps exactly one active dialog", () => {
        const first = openDialog();
        const second = openDialog();

        assert.equal(dialogInstances.length, 1);
        assert.equal(second, first);
    });
});

describe("ItemCreateDialog retained intent", () => {
    it("allocates one ID per valid intent, suppresses double submit, refreshes, and opens natively", async () => {
        const pending = deferred<CreateItemResult>();
        createItemImpl = () => pending.promise;
        openDialog();
        const dialog = dialogInstances[0];
        field(dialog, "prompt").value = "  Question\n第二行  ";
        field(dialog, "answer").value = "  Answer\n第二行  ";

        field(dialog, "confirm").dispatch("click");
        field(dialog, "confirm").dispatch("click");
        await nextTurn();

        assert.equal(nodeIDCalls, 1);
        assert.deepEqual(createCalls, [{elementId: "20260731190000-dialog1", prompt: "  Question\n第二行  ", answer: "  Answer\n第二行  "}]);
        assert.equal(field(dialog, "status").textContent, "Creating Item...");

        pending.resolve({ok: true, item: {elementId: "20260731190000-dialog1", processingState: "processed", contentRevision: "rev-v1-created", lifecycleState: "pending"}});
        await nextTurn();
        await nextTurn();

        assert.equal(refreshCalls, 1);
        assert.deepEqual(openCalls.map(({elementId, intent, source, type}) => ({elementId, intent, source, type})), [
            {elementId: "20260731190000-dialog1", intent: "ordinary", source: "other", type: "item"},
        ]);
        assert.equal(dialog.destroyed, true);
    });

    it("retries an unknown lost response with the same ID and submitted pair", async () => {
        let attempt = 0;
        createItemImpl = async (elementId) => {
            attempt++;
            return attempt === 1
                ? {ok: false, failure: {errorCode: "request", retryable: true, acceptance: "unknown", kind: "request"}}
                : {ok: true, item: {elementId, processingState: "processed", contentRevision: "rev-v1-reconciled", lifecycleState: "pending"}};
        };
        openDialog();
        const dialog = dialogInstances[0];
        field(dialog, "prompt").value = "Question";
        field(dialog, "answer").value = "Answer";

        field(dialog, "confirm").dispatch("click");
        await nextTurn();
        assert.equal(field(dialog, "prompt").getAttribute("disabled"), "disabled");
        assert.equal(field(dialog, "answer").getAttribute("disabled"), "disabled");
        field(dialog, "prompt").value = "Changed while uncertain";
        field(dialog, "confirm").dispatch("click");
        await nextTurn();
        await nextTurn();

        assert.equal(nodeIDCalls, 1);
        assert.deepEqual(createCalls, [
            {elementId: "20260731190000-dialog1", prompt: "Question", answer: "Answer"},
            {elementId: "20260731190000-dialog1", prompt: "Question", answer: "Answer"},
        ]);
        assert.equal(refreshCalls, 1);
    });

    it("returns a structured rejection to the editable draft and submits the corrected pair", async () => {
        let attempt = 0;
        createItemImpl = async (elementId) => {
            attempt++;
            return attempt === 1
                ? {ok: false, failure: {errorCode: "invalid-create-command", retryable: false, acceptance: "notAccepted", kind: "domain"}}
                : {ok: true, item: {elementId, processingState: "processed", contentRevision: "rev-v1-corrected", lifecycleState: "pending"}};
        };
        openDialog();
        const dialog = dialogInstances[0];
        field(dialog, "prompt").value = "Original question";
        field(dialog, "answer").value = "Original answer";

        field(dialog, "confirm").dispatch("click");
        await nextTurn();
        assert.equal(field(dialog, "status").textContent, "Unable to create this Item.");

        field(dialog, "prompt").value = "Corrected question";
        field(dialog, "answer").value = "Corrected answer";
        field(dialog, "confirm").dispatch("click");
        await nextTurn();
        await nextTurn();

        assert.deepEqual(createCalls, [
            {elementId: "20260731190000-dialog1", prompt: "Original question", answer: "Original answer"},
            {elementId: "20260731190000-dialog1", prompt: "Corrected question", answer: "Corrected answer"},
        ]);
        assert.equal(nodeIDCalls, 2);
        assert.equal(refreshCalls, 1);
        assert.equal(dialog.destroyed, true);
    });

    it("shows accepted recovery without creating a replacement identity", async () => {
        createItemImpl = async (elementId) => ({ok: false, failure: {
            errorCode: "projection-refresh-failed",
            retryable: true,
            acceptance: "accepted",
            acceptedElementId: elementId,
            kind: "domain",
        }});
        openDialog();
        const dialog = dialogInstances[0];
        field(dialog, "prompt").value = "Question";
        field(dialog, "answer").value = "Answer";

        field(dialog, "confirm").dispatch("click");
        await nextTurn();

        assert.equal(field(dialog, "status").textContent, "Item created; reconnecting...");
        assert.equal(field(dialog, "prompt").getAttribute("disabled"), "disabled");
        assert.equal(field(dialog, "answer").getAttribute("disabled"), "disabled");
        assert.equal(field(dialog, "confirm").getAttribute("disabled"), "disabled");
        field(dialog, "prompt").value = "Ignored edit";
        field(dialog, "confirm").dispatch("click");
        await nextTurn();
        assert.equal(nodeIDCalls, 1);
        assert.equal(createCalls.length, 1);
        assert.equal(openCalls.length, 0);
    });

    it("ignores a successful late response after dialog disposal or operation cancellation", async () => {
        const pending = deferred<CreateItemResult>();
        createItemImpl = () => pending.promise;
        openDialog();
        const dialog = dialogInstances[0];
        field(dialog, "prompt").value = "Question";
        field(dialog, "answer").value = "Answer";
        field(dialog, "confirm").dispatch("click");
        await nextTurn();
        operationCancelled = true;
        dialog.destroy();

        pending.resolve({ok: true, item: {elementId: "20260731190000-dialog1", processingState: "processed", contentRevision: "rev-v1-created", lifecycleState: "pending"}});
        await nextTurn();
        await nextTurn();

        assert.equal(refreshCalls, 0);
        assert.equal(openCalls.length, 0);
    });

    it("does not create when the reusable native target cannot transition", async () => {
        openPrepared = false;
        openDialog();
        const dialog = dialogInstances[0];
        field(dialog, "prompt").value = "Question";
        field(dialog, "answer").value = "Answer";

        field(dialog, "confirm").dispatch("click");
        await nextTurn();

        assert.equal(createCalls.length, 0);
        assert.equal(nodeIDCalls, 0);
    });
});
