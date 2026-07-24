import {findElementNode} from "./treeState";
import type {ElementReadFailureKind, ElementsDockState, ElementTreeNodeView} from "./types";

export const createInitialDockState = (expandedElementIds: string[]): ElementsDockState => ({
    phase: "uninitialized", nodes: [], hasSuccessfulTree: false, expandedElementIds: [...expandedElementIds],
});

export const beginDockRequest = (state: ElementsDockState): ElementsDockState => ({
    ...state, phase: state.hasSuccessfulTree ? "refreshing" : "initialLoading", errorKind: undefined,
});

export const completeDockSuccess = (state: ElementsDockState, nodes: ElementTreeNodeView[]): ElementsDockState => ({
    ...state,
    phase: nodes.length === 0 ? "empty" : "ready",
    nodes,
    hasSuccessfulTree: true,
    selectedElementId: state.selectedElementId && findElementNode(nodes, state.selectedElementId) ? state.selectedElementId : undefined,
    errorKind: undefined,
});

export const completeDockFailure = (state: ElementsDockState, errorKind: ElementReadFailureKind): ElementsDockState => ({
    ...state, phase: state.hasSuccessfulTree ? "refreshFailure" : "initialFailure", errorKind,
});
