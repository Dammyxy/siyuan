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
});
