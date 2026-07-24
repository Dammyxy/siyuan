import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {ensureSingleElementsDock, getSymemoElementId, normalizeSymemoLayoutData, serializeSymemoLayoutData} from "./layoutState";
import type {DockLayoutLike} from "./layoutState";

describe("Elements dock layout migration", () => {
    it("inserts one hidden dock after FileTree only when missing", () => {
        const layout: DockLayoutLike = {left: {data: [[{type: "file", show: true, size: {width: 232, height: 0}}], []]}, right: {data: [[], []]}, bottom: {data: [[], []]}};
        const migrated = ensureSingleElementsDock(layout);
        assert.deepEqual(migrated.left.data[0].map((item) => item.type), ["file", "elements"]);
        assert.equal(migrated.left.data[0][1].show, false);
        assert.equal(migrated.left.data[0][0].show, true);
    });

    it("preserves the first existing placement and removes duplicates", () => {
        const first = {type: "elements", show: true, size: {width: 410, height: 8}, custom: "keep"};
        const layout: DockLayoutLike = {left: {data: [[{type: "file"}], []]}, right: {data: [[first], [{type: "elements", show: false}]]}, bottom: {data: [[], []]}};
        const migrated = ensureSingleElementsDock(layout);
        assert.equal(migrated.right.data[0][0], first);
        assert.equal(JSON.stringify(migrated).match(/\"type\":\"elements\"/g)?.length, 1);
    });
});

describe("SymemoElement layout identity", () => {
    it("accepts only nonblank identity and normalizes unsafe icons", () => {
        assert.equal(normalizeSymemoLayoutData({instance: "SymemoElement", elementId: " "}), undefined);
        assert.deepEqual(normalizeSymemoLayoutData({instance: "SymemoElement", elementId: "id", title: "Title", icon: "bad", html: "secret"}), {
            instance: "SymemoElement", elementId: "id", title: "Title", icon: "iconHelp",
        });
    });

    it("serializes ID/title/icon only", () => {
        const value = serializeSymemoLayoutData({elementId: "id", title: "Title", icon: "iconFile"});
        assert.deepEqual(value, {instance: "SymemoElement", elementId: "id", title: "Title", icon: "iconFile"});
        assert.equal(JSON.stringify(value).includes("html"), false);
        assert.equal(JSON.stringify(value).includes("scroll"), false);
    });

    it("matches both live and lazy identity by Element ID", () => {
        assert.equal(getSymemoElementId({elementId: "live"}), "live");
        assert.equal(getSymemoElementId(undefined, JSON.stringify({instance: "SymemoElement", elementId: "lazy"})), "lazy");
        assert.equal(getSymemoElementId(undefined, "bad"), undefined);
    });
});
