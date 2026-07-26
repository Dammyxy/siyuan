const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const {routeClipboardRequest} = require("./clipboard");

describe("electron clipboard request routing", () => {
    it("uses Electron text readers for plain and HTML clipboard flavors", () => {
        const calls = [];
        const clipboard = {
            readText: () => { calls.push("readText"); return "Plain"; },
            readHTML: () => { calls.push("readHTML"); return "<p>HTML</p>"; },
            read: (format) => { calls.push(`read:${format}`); return "raw"; },
            availableFormats: () => { calls.push("formats"); return ["text/plain", "text/html"]; },
        };

        assert.deepEqual(routeClipboardRequest(clipboard, {cmd: "clipboardRead", format: "text/plain"}), {
            handled: true,
            value: "Plain",
        });
        assert.deepEqual(routeClipboardRequest(clipboard, {cmd: "clipboardRead", format: "text/html"}), {
            handled: true,
            value: "<p>HTML</p>",
        });
        assert.deepEqual(calls, ["readText", "readHTML"]);
    });

    it("preserves generic formats and leaves unrelated commands unhandled", () => {
        const clipboard = {
            read: (format) => `raw:${format}`,
            availableFormats: () => ["text/plain", "text/html"],
        };
        assert.deepEqual(routeClipboardRequest(clipboard, {cmd: "clipboardRead", format: "custom/type"}), {
            handled: true,
            value: "raw:custom/type",
        });
        assert.deepEqual(routeClipboardRequest(clipboard, {cmd: "clipboardAvailableFormats"}), {
            handled: true,
            value: ["text/plain", "text/html"],
        });
        assert.deepEqual(routeClipboardRequest(clipboard, {cmd: "other"}), {handled: false});
    });
});
