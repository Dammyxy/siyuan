import type {App} from "../index";

export type ElementSourceMode = "html" | "block" | "opaque" | "unknown" | (string & {});

export type ElementSupportStatus = "supported" | "unsupportedReadOnly" | (string & {});

export interface ElementTreeNodeView {
    elementId: string;
    type: string;
    title: string;
    sourceMode: ElementSourceMode;
    supportStatus: ElementSupportStatus;
    children: ElementTreeNodeView[];
}

export interface TopicMaterialView {
    kind: string;
    html?: string;
    cleaningPolicyVersion?: string;
}

export interface ElementDetailView {
    elementId: string;
    type: string;
    title: string;
    sourceMode: ElementSourceMode;
    supportStatus: ElementSupportStatus;
    topicMaterial?: TopicMaterialView;
}

export type ElementReadFailureKind = "request" | "response";

export type ElementTreeResult =
    | {ok: true; nodes: ElementTreeNodeView[]}
    | {ok: false; kind: ElementReadFailureKind};

export type ElementDetailResult =
    | {ok: true; element: ElementDetailView}
    | {ok: false; kind: ElementReadFailureKind | "missing"};

export interface ElementReadClient {
    getElementTree(): Promise<ElementTreeResult>;
    getElement(elementId: string): Promise<ElementDetailResult>;
}

export type RendererUnavailableReason =
    | "unsupportedRead"
    | "unsupportedElementType"
    | "blockBackedTopic"
    | "unsupportedTopicMaterial"
    | "emptyTopicHTML"
    | "unsupportedCleaningPolicy";

export type RenderDecision =
    | {kind: "renderedTopic"; html: string}
    | {kind: "rendererUnavailable"; reason: RendererUnavailableReason};

export type ElementsDockPhase =
    | "uninitialized"
    | "initialLoading"
    | "ready"
    | "empty"
    | "refreshing"
    | "initialFailure"
    | "refreshFailure";

export interface ElementsDockState {
    phase: ElementsDockPhase;
    nodes: ElementTreeNodeView[];
    hasSuccessfulTree: boolean;
    selectedElementId?: string;
    expandedElementIds: string[];
    errorKind?: ElementReadFailureKind;
}

export type ElementOpenIntent = "ordinary" | "current" | "new" | "right" | "bottom";

export type ElementGestureTarget = "disclosure" | "typeIcon" | "title" | "row";

export interface OpenGestureInput {
    button: 0 | 1;
    altKey: boolean;
    shiftKey: boolean;
    primaryModifier: boolean;
    target: ElementGestureTarget;
    hasChildren: boolean;
    parentDocClickExpand: boolean;
    docIconClickExpand: boolean;
    openFilesUseCurrentTab: boolean;
}

export type ElementOpenAction =
    | {kind: "toggleExpansion"}
    | {kind: "selectOnly"}
    | {kind: "open"; intent: ElementOpenIntent};

export interface OpenElementOptions {
    app: App;
    elementId: string;
    title?: string;
    type?: string;
    intent: ElementOpenIntent;
    source?: "tree" | "menu" | "other";
}

export interface SymemoElementLayoutData {
    instance: "SymemoElement";
    elementId: string;
    title?: string;
    icon?: string;
}

export type SymemoElement = SymemoElementLayoutData;

export type ElementTabState =
    | {phase: "loading"}
    | {phase: "renderedTopic"; detail: ElementDetailView; html: string}
    | {phase: "rendererUnavailable"; detail: ElementDetailView; reason: RendererUnavailableReason}
    | {phase: "missing"}
    | {phase: "failure"; errorKind: ElementReadFailureKind};

export type PersistedExpandedElementIds = string[];
