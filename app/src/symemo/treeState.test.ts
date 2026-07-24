import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {
    decodeElementTreeData,
    elementTypeIcon,
    findElementNode,
    flattenElementTree,
    getElementDisplayTitle,
    getRevealPlan,
    normalizeExpandedElementIds,
    parseStoredExpandedElementIds,
    shouldPersistExpandedElementIds,
} from "./treeState";
import {buildOrderedMixedTree, buildRawTreeNode, FIXTURE_ELEMENT_IDS} from "./testFixtures";

describe("tree decoding and traversal", () => {
    it("validates the complete recursive tree atomically", () => {
        assert.equal(decodeElementTreeData({nodes: "invalid"}), undefined);
        assert.equal(decodeElementTreeData({nodes: [buildRawTreeNode({children: {}})]}), undefined);
        assert.equal(decodeElementTreeData({nodes: [
            buildRawTreeNode(),
            buildRawTreeNode({title: "Duplicate"}),
        ]}), undefined);
        assert.equal(decodeElementTreeData({nodes: [buildRawTreeNode({elementId: "   "})]}), undefined);
    });

    it("normalizes only absent children and blank titles", () => {
        const raw = buildRawTreeNode({title: "  ", children: undefined});
        delete raw.children;
        const nodes = decodeElementTreeData({nodes: [raw]});

        assert.ok(nodes);
        assert.deepEqual(nodes[0].children, []);
        assert.equal(nodes[0].title, "");
    });

    it("preserves every root and child in exact transport order, including future parents", () => {
        const nodes = decodeElementTreeData(buildOrderedMixedTree());

        assert.ok(nodes);
        assert.deepEqual(nodes.map((node) => node.elementId), [
            FIXTURE_ELEMENT_IDS.rootConcept,
            FIXTURE_ELEMENT_IDS.futureParent,
            FIXTURE_ELEMENT_IDS.unsupportedRead,
        ]);
        assert.deepEqual(nodes[0].children.map((node) => node.elementId), [
            FIXTURE_ELEMENT_IDS.supportedTopic,
            FIXTURE_ELEMENT_IDS.item,
            FIXTURE_ELEMENT_IDS.blockTopic,
        ]);
        assert.equal(nodes[1].type, "future-collection");
        assert.equal(nodes[1].children.length, 1);
        assert.deepEqual(flattenElementTree(nodes).map((node) => node.elementId), [
            FIXTURE_ELEMENT_IDS.rootConcept,
            FIXTURE_ELEMENT_IDS.supportedTopic,
            FIXTURE_ELEMENT_IDS.item,
            FIXTURE_ELEMENT_IDS.blockTopic,
            FIXTURE_ELEMENT_IDS.futureParent,
            FIXTURE_ELEMENT_IDS.futureChild,
            FIXTURE_ELEMENT_IDS.unsupportedRead,
        ]);
    });

    it("finds a nested node without changing the hierarchy", () => {
        const nodes = decodeElementTreeData(buildOrderedMixedTree());
        assert.ok(nodes);
        assert.equal(findElementNode(nodes, FIXTURE_ELEMENT_IDS.blockTopic)?.title, "Block-backed Topic");
        assert.equal(findElementNode(nodes, "missing"), undefined);
    });
});

describe("opened Element reveal", () => {
    it("selects one nested ID and expands only its ancestors", () => {
        const nodes = decodeElementTreeData(buildOrderedMixedTree());
        assert.ok(nodes);
        assert.deepEqual(getRevealPlan(nodes, FIXTURE_ELEMENT_IDS.blockTopic), {
            selectedElementId: FIXTURE_ELEMENT_IDS.blockTopic,
            expandedElementIds: [FIXTURE_ELEMENT_IDS.rootConcept],
        });
    });

    it("is a no-op for a missing ID", () => {
        const nodes = decodeElementTreeData(buildOrderedMixedTree());
        assert.ok(nodes);
        assert.equal(getRevealPlan(nodes, "missing"), undefined);
    });
});

describe("tree presentation policy", () => {
    it("uses the localized fallback only for blank titles", () => {
        assert.equal(getElementDisplayTitle(" Topic ", "Untitled"), " Topic ");
        assert.equal(getElementDisplayTitle(" \n ", "Untitled"), "Untitled");
        assert.equal(getElementDisplayTitle("", "Untitled"), "Untitled");
    });

    it("maps known types to existing litheness icons and future types to neutral help", () => {
        assert.equal(elementTypeIcon("concept"), "iconLight");
        assert.equal(elementTypeIcon("topic"), "iconFile");
        assert.equal(elementTypeIcon("item"), "iconRiffCard");
        assert.equal(elementTypeIcon("future-kind"), "iconHelp");
    });
});

describe("persisted expansion policy", () => {
    it("parses arbitrary storage values and normalizes to unique expandable current IDs in traversal order", () => {
        assert.deepEqual(parseStoredExpandedElementIds('["x","x",4]'), ["x"]);
        assert.deepEqual(parseStoredExpandedElementIds({bad: true}), []);
        const nodes = decodeElementTreeData(buildOrderedMixedTree());
        assert.ok(nodes);
        assert.deepEqual(normalizeExpandedElementIds(nodes, [FIXTURE_ELEMENT_IDS.futureChild, FIXTURE_ELEMENT_IDS.futureParent, FIXTURE_ELEMENT_IDS.rootConcept, FIXTURE_ELEMENT_IDS.rootConcept]), [
            FIXTURE_ELEMENT_IDS.rootConcept, FIXTURE_ELEMENT_IDS.futureParent,
        ]);
    });

    it("persists only when normalized state differs", () => {
        assert.equal(shouldPersistExpandedElementIds(["a"], ["a"]), false);
        assert.equal(shouldPersistExpandedElementIds(["a"], []), true);
    });
});
