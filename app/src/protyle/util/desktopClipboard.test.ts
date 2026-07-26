import * as assert from "node:assert/strict";
import test from "node:test";
import {readDesktopClipboardPayload, type DesktopClipboardInvoke} from "./desktopClipboard";

const createInvoke = (
    formats: unknown,
    values: Record<string, unknown>,
    calls: Array<{cmd: string; format?: string}>,
): DesktopClipboardInvoke => async (_channel, payload) => {
    calls.push(payload);
    return payload.cmd === "clipboardAvailableFormats" ? formats : values[payload.format];
};

test("reads both desktop clipboard text flavors through their exact Electron routes", async () => {
    const calls: Array<{cmd: string; format?: string}> = [];
    const payload = await readDesktopClipboardPayload(createInvoke(
        ["text/plain", "text/html"],
        {"text/plain": "Plain", "text/html": "<p>HTML</p>"},
        calls,
    ), "siyuan-get");

    assert.deepEqual(payload, {hasHTML: true, textHTML: "<p>HTML</p>", textPlain: "Plain"});
    assert.deepEqual(calls, [
        {cmd: "clipboardAvailableFormats"},
        {cmd: "clipboardRead", format: "text/html"},
        {cmd: "clipboardRead", format: "text/plain"},
    ]);
});

test("preserves an explicitly available empty HTML flavor without falling back to plain text", async () => {
    const calls: Array<{cmd: string; format?: string}> = [];
    assert.deepEqual(await readDesktopClipboardPayload(createInvoke(
        ["TEXT/HTML", "text/plain"],
        {"text/html": "", "text/plain": "must not become Markdown"},
        calls,
    ), "siyuan-get"), {
        hasHTML: true,
        textHTML: "",
        textPlain: "must not become Markdown",
    });
});

test("rejects unavailable or malformed desktop clipboard responses", async () => {
    assert.equal(await readDesktopClipboardPayload(async () => ({formats: []}), "siyuan-get"), undefined);
    assert.equal(await readDesktopClipboardPayload(async () => {
        throw new Error("denied");
    }, "siyuan-get"), undefined);
});
