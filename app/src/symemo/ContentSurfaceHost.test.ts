import {afterEach, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {TestDocument} from "./testDom";
import type {ElementContentSurface} from "./ContentSurfaceHost";
import type {ElementDetailView, ModelTransitionReason, ModelTransitionResult, RendererUnavailableReason} from "./types";
import {ContentSurfaceHost, getContentSurfaceDecision} from "./ContentSurfaceHost";

const supportedDetail = (overrides: Partial<ElementDetailView> = {}): ElementDetailView => ({
    elementId: "topic-id",
    rootElementId: "topic-id",
    storageKind: "rootDocument",
    type: "topic",
    title: "Topic",
    titleRevision: "rev-title",
    sourceMode: "html",
    supportStatus: "supported",
    topicMaterial: {
        kind: "html",
        html: "",
        cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
        revision: "rev-material",
    },
    ...overrides,
});

class FakeSurface implements ElementContentSurface {
    public mounted: ElementDetailView[] = [];
    public destroyed = false;
    public focused = false;
    public barriers: boolean[] = [];
    public transitions: ModelTransitionReason[] = [];

    public async mount(detail: ElementDetailView): Promise<void> {
        this.mounted.push(detail);
    }

    public async prepareTransition(reason: ModelTransitionReason): Promise<ModelTransitionResult> {
        this.transitions.push(reason);
        return {allowed: true};
    }

    public focus(): void {
        this.focused = true;
    }

    public setWindowBarrier(active: boolean): void {
        this.barriers.push(active);
    }

    public destroy(): void {
        this.destroyed = true;
    }
}

describe("content surface selection", () => {
    const globalWithWindow = globalThis as unknown as {window?: Window};
    const previousWindow = globalWithWindow.window;

    afterEach(() => {
        if (previousWindow === undefined) {
            delete globalWithWindow.window;
        } else {
            globalWithWindow.window = previousWindow;
        }
    });

    it("selects writable, read-only, and unavailable surfaces by frozen HTML Topic predicates", () => {
        assert.deepEqual(getContentSurfaceDecision(supportedDetail()), {kind: "writableTopic"});
        assert.deepEqual(getContentSurfaceDecision(supportedDetail({
            titleRevision: undefined,
            topicMaterial: {
                kind: "html",
                html: "<p>Read only</p>",
                cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            },
        })), {kind: "readOnlyTopic", html: "<p>Read only</p>"});
        assert.deepEqual(getContentSurfaceDecision(supportedDetail({
            supportStatus: "unsupportedReadOnly",
            topicMaterial: {
                kind: "html",
                html: "<p>Read only</p>",
                cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            },
        })), {kind: "readOnlyTopic", html: "<p>Read only</p>"});
        assert.deepEqual(getContentSurfaceDecision(supportedDetail({
            sourceMode: "block",
            topicMaterial: {kind: "block"},
        })), {kind: "unavailable", reason: "blockBackedTopic"});
        assert.deepEqual(getContentSurfaceDecision(supportedDetail({
            titleRevision: undefined,
            topicMaterial: {
                kind: "html",
                html: "",
                cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            },
        })), {kind: "unavailable", reason: "emptyTopicHTML"});
    });

    it("renders supported non-empty HTML Topics read-only in global read-only mode", () => {
        globalWithWindow.window = {
            siyuan: {config: {readonly: true}},
        } as unknown as Window;

        assert.deepEqual(getContentSurfaceDecision(supportedDetail({
            topicMaterial: {
                kind: "html",
                html: "<p>Read only from global mode</p>",
                cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
                revision: "rev-material",
            },
        })), {kind: "readOnlyTopic", html: "<p>Read only from global mode</p>"});
    });

    it("never mounts an empty writable Topic while the host is globally read-only", () => {
        globalWithWindow.window = {
            siyuan: {config: {readonly: true}},
        } as unknown as Window;

        assert.deepEqual(getContentSurfaceDecision(supportedDetail()), {
            kind: "unavailable",
            reason: "emptyTopicHTML",
        });
    });

    it("mounts exactly one selected surface and delegates lifecycle operations", async () => {
        const document = new TestDocument();
        const container = document.createElement("div") as unknown as HTMLElement;
        const surfaces: FakeSurface[] = [];
        const readOnly: string[] = [];
        const unavailable: RendererUnavailableReason[] = [];
        const host = new ContentSurfaceHost({
            container,
            createWritableSurface: () => {
                const surface = new FakeSurface();
                surfaces.push(surface);
                return surface;
            },
            renderReadOnly: (_container, html) => readOnly.push(html),
            renderUnavailable: (_container, _detail, reason) => unavailable.push(reason),
        });

        await host.mount(supportedDetail());
        assert.equal(surfaces.length, 1);
        assert.equal(surfaces[0].mounted[0].elementId, "topic-id");

        host.focus();
        assert.equal(surfaces[0].focused, true);
        host.setWindowBarrier(true);
        host.setWindowBarrier(false);
        assert.deepEqual(surfaces[0].barriers, [true, false]);
        assert.deepEqual(await host.prepareTransition("tab-close"), {allowed: true});
        assert.deepEqual(surfaces[0].transitions, ["tab-close"]);

        await host.mount(supportedDetail({
            titleRevision: undefined,
            topicMaterial: {
                kind: "html",
                html: "<p>Read only</p>",
                cleaningPolicyVersion: "siyuanmemo-topic-html-v1",
            },
        }));
        assert.equal(surfaces[0].destroyed, true);
        assert.deepEqual(readOnly, ["<p>Read only</p>"]);

        await host.mount(supportedDetail({sourceMode: "opaque", topicMaterial: undefined}));
        assert.deepEqual(unavailable, ["unsupportedTopicMaterial"]);
    });

    it("destroys and forgets a writable surface whose mount rejects", async () => {
        const document = new TestDocument();
        const container = document.createElement("div") as unknown as HTMLElement;
        const surface = new FakeSurface();
        surface.mount = async () => {
            throw new Error("mount failed");
        };
        const host = new ContentSurfaceHost({
            container,
            createWritableSurface: () => surface,
            renderReadOnly: () => undefined,
            renderUnavailable: () => undefined,
        });

        await assert.rejects(host.mount(supportedDetail()), /mount failed/);

        assert.equal(surface.destroyed, true);
        assert.deepEqual(await host.prepareTransition("tab-close"), {allowed: true});
    });

    it("selects and mounts an ordinary supported Q/A Item Surface while future Items fail closed", async () => {
        const itemDetail: ElementDetailView = {
            elementId: "item-id",
            rootElementId: "item-id",
            storageKind: "rootDocument",
            type: "item",
            title: "Derived question",
            sourceMode: "unknown",
            supportStatus: "supported",
            item: {kind: "qa", prompt: "Derived question", revision: "rev-v1-item"},
        };
        assert.deepEqual(getContentSurfaceDecision(itemDetail), {kind: "itemAuthoring"});
        assert.deepEqual(getContentSurfaceDecision({...itemDetail, supportStatus: "unsupportedReadOnly"}), {
            kind: "unavailable",
            reason: "unsupportedRead",
        });
        assert.deepEqual(getContentSurfaceDecision({...itemDetail, item: undefined}), {
            kind: "unavailable",
            reason: "unsupportedRead",
        });

        const document = new TestDocument();
        const container = document.createElement("div") as unknown as HTMLElement;
        const itemSurface = new FakeSurface();
        const topicSurface = new FakeSurface();
        const unavailable: RendererUnavailableReason[] = [];
        const host = new ContentSurfaceHost({
            container,
            createWritableSurface: () => topicSurface,
            createItemAuthoringSurface: () => itemSurface,
            renderReadOnly: () => undefined,
            renderUnavailable: (_container, _detail, reason) => unavailable.push(reason),
        } as ConstructorParameters<typeof ContentSurfaceHost>[0]);

        await host.mount(itemDetail);
        assert.deepEqual(itemSurface.mounted, [itemDetail]);
        assert.equal(topicSurface.mounted.length, 0);
        assert.deepEqual(await host.prepareTransition("workspace-switch"), {allowed: true});
        assert.deepEqual(itemSurface.transitions, ["workspace-switch"]);

        await host.mount({...itemDetail, supportStatus: "unsupportedReadOnly"});
        assert.equal(itemSurface.destroyed, true);
        assert.deepEqual(unavailable, ["unsupportedRead"]);
    });

    it("selects an Item review Adapter from presentation and restores ordinary authoring exactly once", async () => {
        const document = new TestDocument();
        const container = document.createElement("div") as unknown as HTMLElement;
        const authoring = new FakeSurface();
        const reviewTrace: string[] = [];
        const review = {
            mount: (session: {phase: string}) => reviewTrace.push(`mount:${session.phase}`),
            update: (session: {phase: string}) => reviewTrace.push(`update:${session.phase}`),
            prepareTransition: () => ({allowed: true as const}),
            focus: () => reviewTrace.push("focus"),
            destroy: () => reviewTrace.push("destroy"),
        };
        const host = new ContentSurfaceHost({
            container,
            createWritableSurface: () => new FakeSurface(),
            createItemAuthoringSurface: () => authoring,
            createItemReviewSurface: () => review,
            renderReadOnly: () => undefined,
            renderUnavailable: () => undefined,
        } as ConstructorParameters<typeof ContentSurfaceHost>[0]);
        const itemDetail: ElementDetailView = {
            elementId: "item-id", type: "item", title: "Question", sourceMode: "unknown", supportStatus: "supported",
            item: {kind: "qa", prompt: "Question", revision: "rev-v1-item"},
        };
        const question = {
            kind: "activeItemReview" as const,
            sessionId: "mixed-session",
            phase: "question" as const,
            target: {kind: "element.item" as const, elementId: "item-id", prompt: "Question"},
        };
        const answer = {
            ...question,
            phase: "answer" as const,
            target: {...question.target, answer: "Answer"},
        };

        await host.mount(itemDetail, question);
        assert.equal(authoring.mounted.length, 0);
        await host.mount(itemDetail, answer);
        assert.deepEqual(reviewTrace, ["mount:question", "update:answer"]);

        await host.mount(itemDetail, {kind: "ordinary"});
        assert.equal(authoring.mounted.length, 1);
        assert.deepEqual(reviewTrace, ["mount:question", "update:answer", "destroy"]);
    });

    it("keeps one writable Topic Adapter mounted across ordinary and current presentation", async () => {
        const document = new TestDocument();
        const container = document.createElement("div") as unknown as HTMLElement;
        const topics: FakeSurface[] = [];
        const host = new ContentSurfaceHost({
            container,
            createWritableSurface: () => {
                const surface = new FakeSurface();
                topics.push(surface);
                return surface;
            },
            renderReadOnly: () => undefined,
            renderUnavailable: () => undefined,
        });

        await host.mount(supportedDetail(), {kind: "ordinary"});
        await host.mount(supportedDetail(), {kind: "ordinary"});

        assert.equal(topics.length, 1);
        assert.equal(topics[0].destroyed, false);
        assert.equal(topics[0].mounted.length, 1);
    });

    it("fails closed when active Item presentation targets another identity", async () => {
        const document = new TestDocument();
        const container = document.createElement("div") as unknown as HTMLElement;
        const authoring = new FakeSurface();
        let reviewCreates = 0;
        const unavailable: RendererUnavailableReason[] = [];
        const host = new ContentSurfaceHost({
            container,
            createWritableSurface: () => new FakeSurface(),
            createItemAuthoringSurface: () => authoring,
            createItemReviewSurface: () => {
                reviewCreates++;
                return {
                    mount: () => undefined,
                    update: () => undefined,
                    prepareTransition: () => ({allowed: true as const}),
                    focus: () => undefined,
                    destroy: () => undefined,
                };
            },
            renderReadOnly: () => undefined,
            renderUnavailable: (_container, _detail, reason) => unavailable.push(reason),
        } as ConstructorParameters<typeof ContentSurfaceHost>[0]);
        const itemDetail: ElementDetailView = {
            elementId: "item-id", type: "item", title: "Question", sourceMode: "unknown", supportStatus: "supported",
            item: {kind: "qa", prompt: "Question", revision: "rev-v1-item"},
        };

        await host.mount(itemDetail, {
            kind: "activeItemReview",
            sessionId: "mixed-session",
            phase: "question",
            target: {kind: "element.item", elementId: "other-item", prompt: "Other"},
        });

        assert.equal(authoring.mounted.length, 0);
        assert.equal(reviewCreates, 0);
        assert.deepEqual(unavailable, ["unsupportedRead"]);
    });
});
