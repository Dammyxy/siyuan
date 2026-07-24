import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {beginDockRequest, completeDockFailure, completeDockSuccess, createInitialDockState} from "./dockState";
import {decodeElementTreeData} from "./treeState";
import {buildOrderedMixedTree, FIXTURE_ELEMENT_IDS} from "./testFixtures";

describe("Elements dock state", () => {
    it("distinguishes initial loading, ready, empty, and initial failure", () => {
        const initial = createInitialDockState([]);
        assert.equal(initial.phase, "uninitialized");
        const loading = beginDockRequest(initial);
        assert.equal(loading.phase, "initialLoading");
        const nodes = decodeElementTreeData(buildOrderedMixedTree());
        assert.ok(nodes);
        assert.equal(completeDockSuccess(loading, nodes).phase, "ready");
        assert.equal(completeDockSuccess(loading, []).phase, "empty");
        assert.equal(completeDockFailure(loading, "request").phase, "initialFailure");
    });

    it("retains the last successful tree during refresh and refresh failure", () => {
        const nodes = decodeElementTreeData(buildOrderedMixedTree());
        assert.ok(nodes);
        const ready = completeDockSuccess(beginDockRequest(createInitialDockState([])), nodes);
        const refreshing = beginDockRequest(ready);
        assert.equal(refreshing.phase, "refreshing");
        assert.equal(refreshing.nodes, nodes);
        const failed = completeDockFailure(refreshing, "response");
        assert.equal(failed.phase, "refreshFailure");
        assert.equal(failed.nodes, nodes);
    });

    it("atomically replaces success and reconciles selection", () => {
        const nodes = decodeElementTreeData(buildOrderedMixedTree());
        assert.ok(nodes);
        const ready = {...completeDockSuccess(beginDockRequest(createInitialDockState([])), nodes), selectedElementId: FIXTURE_ELEMENT_IDS.supportedTopic};
        assert.equal(completeDockSuccess(beginDockRequest(ready), nodes).selectedElementId, FIXTURE_ELEMENT_IDS.supportedTopic);
        assert.equal(completeDockSuccess(beginDockRequest(ready), []).selectedElementId, undefined);
    });
});
