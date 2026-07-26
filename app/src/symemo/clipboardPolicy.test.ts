import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {
    getTopicPasteAvailability,
    projectClipboardData,
    projectClipboardEvent,
    selectTopicPasteFlavor,
} from "./clipboardPolicy";

describe("Topic clipboard policy", () => {
    it("records an HTML flavor even when the HTML payload is empty", () => {
        const snapshot = projectClipboardData({
            textHTML: "",
            textPlain: "# Plain fallback",
            hasHTML: true,
            siyuanHTML: "<div data-node-id='ignored'></div>",
            files: [{} as File],
        });

        assert.deepEqual(snapshot, {
            textHTML: "",
            textPlain: "# Plain fallback",
            hasHTML: true,
        });
        assert.deepEqual(getTopicPasteAvailability(snapshot), {
            paste: true,
            pasteAsPlainText: true,
            pasteAsHTML: true,
        });
        assert.deepEqual(selectTopicPasteFlavor(snapshot, "paste"), {kind: "html", html: ""});
    });

    it("uses Markdown conversion only for normal paste without an HTML flavor", () => {
        const snapshot = projectClipboardData({textPlain: "## Heading", textHTML: "<p>ignored</p>", hasHTML: false});

        assert.deepEqual(selectTopicPasteFlavor(snapshot, "paste"), {kind: "markdown", markdown: "## Heading"});
        assert.deepEqual(selectTopicPasteFlavor(snapshot, "pasteAsPlainText"), {kind: "plainText", text: "## Heading"});
        assert.deepEqual(selectTopicPasteFlavor(snapshot, "pasteAsHTML"), {kind: "none"});
    });

    it("projects a keyboard ClipboardEvent without rereading the operating-system clipboard", () => {
        const clipboardData = {
            types: ["text/plain"],
            getData(type: string) {
                return type === "text/plain" ? "<literal>" : "";
            },
        };

        assert.deepEqual(projectClipboardEvent({clipboardData} as unknown as ClipboardEvent), {
            textHTML: "",
            textPlain: "<literal>",
            hasHTML: false,
        });
    });
});
