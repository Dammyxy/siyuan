import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const source = (relativePath: string) => readFileSync(resolve(__dirname, relativePath), "utf8");

describe("native Elements registration", () => {
    it("places a hidden Elements dock immediately after the active FileTree default", () => {
        const constants = source("../constants.ts");
        assert.match(constants, /type:\s*["']file["'][\s\S]*?show:\s*true[\s\S]*?type:\s*["']elements["'][\s\S]*?show:\s*false/);
    });

    it("registers lazy Elements construction in the built-in dock", () => {
        const dock = source("../layout/dock/index.ts");
        assert.match(dock, /TYPES[^;]*["']elements["']/);
        assert.match(dock, /case\s+["']elements["']/);
        assert.match(dock, /new\s+Elements/);
    });

    it("discovers native Elements and ElementTab models", () => {
        const getAll = source("../layout/getAll.ts");
        assert.match(getAll, /Elements/);
        assert.match(getAll, /ElementTab/);
        assert.match(getAll, /elements:\s*\[\]/);
        assert.match(getAll, /elementTabs:\s*\[\]/);
    });
});

describe("Elements persistence and restoration adapters", () => {
    it("registers the expanded-ID key, array default, and structured parser", () => {
        const constants = source("../constants.ts");
        const compatibility = source("../protyle/util/compatibility.ts");
        assert.match(constants, /LOCAL_SYMEMO_ELEMENTS_EXPANDED\s*=\s*["']local-symemo-elements-expanded["']/);
        assert.match(compatibility, /defaultStorage\[Constants\.LOCAL_SYMEMO_ELEMENTS_EXPANDED\]\s*=\s*\[\]/);
        assert.match(compatibility, /Constants\.LOCAL_SYMEMO_ELEMENTS_EXPANDED\]\.(forEach|map)|Constants\.LOCAL_SYMEMO_ELEMENTS_EXPANDED\].*forEach/s);
    });

    it("wires dock migration and lazy SymemoElement restoration/serialization", () => {
        const layout = source("../layout/util.ts");
        assert.match(layout, /ensureElementsDock\(json\)/);
        assert.match(layout, /json\.instance\s*===\s*["']SymemoElement["']/);
        assert.match(layout, /layout\s+instanceof\s+ElementTab/);
        assert.match(layout, /new\s+ElementTab\(\{app,\s*tab,\s*elementId:/);
        assert.match(layout, /json\.instance\s*===\s*["']SymemoElement["'][\s\S]*?item--unupdate/);
    });
});
