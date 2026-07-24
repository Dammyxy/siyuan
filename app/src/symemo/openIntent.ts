import type {ElementOpenAction, OpenGestureInput} from "./types";

export const reduceOpenGesture = (input: OpenGestureInput): ElementOpenAction => {
    if (input.target === "disclosure" && input.button === 0) return {kind: "toggleExpansion"};
    if (input.button === 0 && !input.altKey && !input.shiftKey && !input.primaryModifier && input.hasChildren &&
        ((input.target === "title" && input.parentDocClickExpand) ||
            (input.target === "typeIcon" && input.docIconClickExpand))) {
        return {kind: "toggleExpansion"};
    }
    if (input.button === 1) {
        return input.openFilesUseCurrentTab ? {kind: "open", intent: "new"} : {kind: "selectOnly"};
    }
    if (input.button !== 0) return {kind: "selectOnly"};
    if (input.altKey && !input.primaryModifier && !input.shiftKey) return {kind: "open", intent: "right"};
    if (!input.altKey && input.primaryModifier && input.shiftKey) return {kind: "open", intent: "bottom"};
    if (input.openFilesUseCurrentTab && input.altKey && input.primaryModifier && !input.shiftKey) {
        return {kind: "open", intent: "new"};
    }
    if (!input.altKey && !input.primaryModifier && !input.shiftKey) return {kind: "open", intent: "ordinary"};
    return {kind: "selectOnly"};
};
