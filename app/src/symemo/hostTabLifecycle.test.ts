import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {isModelTransitionGuarded, normalizeTabOperationKey} from "./authoringRegistry";

describe("host tab lifecycle helpers", () => {
    it("preserves ordinary same-stack removals by treating unguarded models as immediate", () => {
        assert.equal(isModelTransitionGuarded({}), false);
        assert.equal(isModelTransitionGuarded({prepareTransition: async () => ({allowed: true})}), true);
    });

    it("separates exact tab operations by tab, kind, and operation key", () => {
        assert.equal(
            normalizeTabOperationKey({tabId: "a", kind: "close", operationKey: "x"}),
            "a:close:x",
        );
        assert.notEqual(
            normalizeTabOperationKey({tabId: "a", kind: "close", operationKey: "x"}),
            normalizeTabOperationKey({tabId: "a", kind: "evict", operationKey: "x"}),
        );
    });

    it("closes a detached window through its local window-close lease before teardown", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "../window/closeWin.ts"), "utf8");
        const commitIndex = source.indexOf("lease.commit()");
        const pluginUnloadIndex = source.indexOf("app.plugins");

        assert.match(source, /beginWindowElementAuthoringTransition\(\s*"window-close"/);
        assert.doesNotMatch(source, /kind:\s*"application-exit"/);
        assert.ok(commitIndex >= 0 && pluginUnloadIndex >= 0 && commitIndex < pluginUnloadIndex);
    });

    it("keeps guarded Element drag data opaque until the transfer broker authorizes materialization", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "../layout/Tab.ts"), "utf8");
        const offerStart = source.indexOf("const transferOfferId", source.indexOf("dragstart"));
        const guardedStart = source.lastIndexOf("if (isModelTransitionGuarded(this.model))", offerStart);
        const unguardedStart = source.indexOf("} else {", offerStart);
        const payloadEnd = source.indexOf("event.dataTransfer.dropEffect", unguardedStart);
        const guardedBranch = source.slice(guardedStart, unguardedStart);
        const unguardedBranch = source.slice(unguardedStart, payloadEnd);

        assert.match(guardedBranch, /symemoTransferOfferId/);
        assert.doesNotMatch(guardedBranch, /layoutToJSON|text\/html/);
        assert.match(unguardedBranch, /layoutToJSON/);
    });

    it("enters destination handoff only after the broker sends the second-phase ready event", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "hostTabTransfer.ts"), "utf8");
        const registerStart = source.indexOf("export const registerTabTransferDestination");
        const registerEnd = source.indexOf("export const transferOfferedTabToCurrentWindow", registerStart);
        const readyBranchStart = source.indexOf('payload.action === "ready"');
        const readyBranchEnd = source.indexOf('payload.action === "materialize"', readyBranchStart);
        const registerBody = source.slice(registerStart, registerEnd);
        const readyBranch = source.slice(readyBranchStart, readyBranchEnd);

        assert.doesNotMatch(registerBody, /enterCommittedHandoff/);
        assert.match(registerBody, /return ready !== false/);
        assert.match(readyBranch, /isWindowAuthoringBusy\(\)/);
        assert.match(readyBranch, /enterCommittedHandoff/);
        assert.match(readyBranch, /handoff:\s*true/);
    });

    it("reports final-tab detach success and defers detached-window close until transfer release", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "../layout/Wnd.ts"), "utf8");

        assert.match(source, /removeTabAction\s*=\s*\([^)]*closeEmptyDetachedWindow\s*=\s*true/);
        assert.match(source, /detachTab[\s\S]*?removeTabAction\(tab\.id, false, false, false, false\)/);
        assert.match(source, /public closeIfEmptyAfterTransfer\(\)/);
        assert.doesNotMatch(source, /closeWindow\(this\.app\);\s*return;/);
    });
});
