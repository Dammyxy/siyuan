import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {reduceOpenGesture} from "./openIntent";
import type {OpenGestureInput} from "./types";

const gesture = (overrides: Partial<OpenGestureInput> = {}): OpenGestureInput => ({
    button: 0,
    altKey: false,
    shiftKey: false,
    primaryModifier: false,
    target: "title",
    hasChildren: false,
    parentDocClickExpand: false,
    docIconClickExpand: false,
    openFilesUseCurrentTab: false,
    ...overrides,
});

describe("Element row gesture policy", () => {
    it("gives disclosure and configured parent expansion precedence", () => {
        assert.deepEqual(reduceOpenGesture(gesture({target: "disclosure", hasChildren: true})), {kind: "toggleExpansion"});
        assert.deepEqual(reduceOpenGesture(gesture({target: "title", hasChildren: true, parentDocClickExpand: true})), {kind: "toggleExpansion"});
        assert.deepEqual(reduceOpenGesture(gesture({target: "typeIcon", hasChildren: true, docIconClickExpand: true})), {kind: "toggleExpansion"});
        assert.deepEqual(reduceOpenGesture(gesture({target: "title", hasChildren: true, parentDocClickExpand: true, primaryModifier: true, shiftKey: true})), {kind: "open", intent: "bottom"});
        assert.deepEqual(reduceOpenGesture(gesture({target: "typeIcon", hasChildren: true, docIconClickExpand: true, altKey: true})), {kind: "open", intent: "right"});
    });

    it("always lets a leaf type icon open", () => {
        assert.deepEqual(reduceOpenGesture(gesture({target: "typeIcon"})), {kind: "open", intent: "ordinary"});
    });

    it("maps current FileTree modifiers to the closed five-intent vocabulary", () => {
        const cases: Array<[Partial<OpenGestureInput>, unknown]> = [
            [{}, {kind: "open", intent: "ordinary"}],
            [{altKey: true}, {kind: "open", intent: "right"}],
            [{primaryModifier: true, shiftKey: true}, {kind: "open", intent: "bottom"}],
            [{altKey: true, primaryModifier: true, openFilesUseCurrentTab: true}, {kind: "open", intent: "new"}],
            [{button: 1, openFilesUseCurrentTab: true}, {kind: "open", intent: "new"}],
            [{primaryModifier: true}, {kind: "selectOnly"}],
            [{button: 1, openFilesUseCurrentTab: false}, {kind: "selectOnly"}],
        ];
        cases.forEach(([input, expected]) => assert.deepEqual(reduceOpenGesture(gesture(input)), expected));
    });
});
