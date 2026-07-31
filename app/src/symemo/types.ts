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
    revision?: string;
}

export interface ItemDetailView {
    kind: "qa";
    prompt: string;
    revision: string;
}

export interface ElementDetailView {
    elementId: string;
    rootElementId?: string;
    storageKind?: string;
    type: string;
    title: string;
    titleRevision?: string;
    sourceMode: ElementSourceMode;
    supportStatus: ElementSupportStatus;
    topicMaterial?: TopicMaterialView;
    item?: ItemDetailView;
}

export type ElementReadFailureKind = "request" | "response";

export type ElementTreeResult =
    | {ok: true; nodes: ElementTreeNodeView[]}
    | {ok: false; kind: ElementReadFailureKind};

export type ElementDetailResult =
    | {ok: true; element: ElementDetailView}
    | {ok: false; kind: ElementReadFailureKind | "missing"};

export type LearningSessionStatus = "active" | "completed";

export type LearningSessionStage = "outstanding" | "pending" | "finalDrill" | "completed";

export type LearningSessionPhase = "question" | "answer" | "confirmation" | "completed";

export interface ActiveTopicLearningTarget {
    kind: "element.topic";
    elementId: string;
}

export interface ActiveItemLearningTarget {
    kind: "element.item";
    elementId: string;
    prompt: string;
    answer?: string;
}

export type ActiveLearningTargetRef = ActiveTopicLearningTarget | ActiveItemLearningTarget;

export interface LearningSessionProjection {
    sessionId?: string;
    status: LearningSessionStatus;
    stage?: LearningSessionStage;
    phase: LearningSessionPhase;
    current?: ActiveLearningTargetRef;
    remainingElementIds: string[];
    pendingAcceptedEventId?: string;
    confirmation?: {stage: "pending" | "finalDrill"};
}

export interface SessionCallFailure {
    errorCode: string;
    retryable: boolean;
    kind: "request" | "response" | "domain";
    session?: LearningSessionProjection;
}

export type SessionCallResult =
    | {ok: true; session: LearningSessionProjection}
    | {ok: false; failure: SessionCallFailure};

export interface TopicNextCallFailure {
    errorCode: string;
    retryable: boolean;
    acceptance: "notAccepted" | "accepted" | "unknown";
    acceptedEventId?: string;
    session?: LearningSessionProjection;
    kind: "request" | "response" | "domain";
}

export type TopicNextCallResult =
    | {ok: true; eventId: string; reviewAccepted: true; session: LearningSessionProjection}
    | {ok: false; failure: TopicNextCallFailure};

export type TopicNextIntentState =
    | "submitting"
    | "retryable"
    | "acceptedNotAdvanced"
    | "acceptedRecovering"
    | "acceptedAdvanced"
    | "reconciled";

export interface TopicNextIntent {
    eventId: string;
    sessionId?: string;
    elementId: string;
    state: TopicNextIntentState;
    acceptance: "unknown" | "notAccepted" | "accepted";
    errorCode?: string;
    session?: LearningSessionProjection;
}

export type LearningControlPhase =
    | "loading"
    | "idle"
    | "preview"
    | "activeTopic"
    | "activeItemQuestion"
    | "activeItemAnswer"
    | "pendingConfirmation"
    | "finalDrillConfirmation"
    | "busy"
    | "retryableNext"
    | "retryableReview"
    | "acceptedNotAdvanced"
    | "acceptedRecovering"
    | "completed"
    | "noDue"
    | "unsupportedSession"
    | "readOnly"
    | "failure";

export type LearningPrimaryAction =
    | "learn"
    | "next"
    | "showAnswer"
    | "acceptPending"
    | "declineFinalDrill"
    | "retryNext"
    | "continue"
    | "resume";

export interface LearningControlProjection {
    phase: LearningControlPhase;
    primaryAction?: LearningPrimaryAction;
    secondaryAction?: "stop";
    busy: boolean;
    messageKey?: string;
    displayedElementId: string;
    targetElementId?: string;
    session?: LearningSessionProjection;
}

export interface ElementReadClient {
    getElementTree(): Promise<ElementTreeResult>;
    getElement(elementId: string): Promise<ElementDetailResult>;
}

export type ElementAuthoringField = "title" | "material";

export interface CreateHTMLTopicSuccess {
    ok: true;
    elementId: string;
    eventId: string;
    createAccepted: true;
    reviewAccepted: boolean;
    retryable: false;
}

export interface CreateHTMLTopicFailure {
    ok: false;
    failure: {
        errorCode: string;
        retryable: boolean;
        acceptanceUnknown: boolean;
        acceptedElementId?: string;
    };
}

export type CreateHTMLTopicResult = CreateHTMLTopicSuccess | CreateHTMLTopicFailure;

export interface CreatedItemView {
    elementId: string;
    processingState: "processed";
    contentRevision: string;
    sourcePath?: string;
    sortRank?: number;
    lifecycleState: "pending";
}

export interface CreateItemFailure {
    errorCode: string;
    retryable: boolean;
    acceptance: "notAccepted" | "accepted" | "unknown";
    acceptedElementId?: string;
    kind: "request" | "response" | "domain";
}

export type CreateItemResult =
    | {ok: true; item: CreatedItemView}
    | {ok: false; failure: CreateItemFailure};

export interface ItemAuthoringView {
    elementId: string;
    prompt: string;
    answer: string;
    contentRevision: string;
}

export type ItemAuthoringResult =
    | {ok: true; authoring: ItemAuthoringView}
    | {ok: false; failure: {errorCode: string; retryable: boolean; kind: "request" | "response" | "domain"}};

export interface MaterialNodeIdentityAssignment {
    clientNodeKey: string;
    nodeId: string;
}

export interface AcceptedElementChange {
    kind: "RenameElement" | "SaveTopicHTML";
    elementId: string;
    changedField: ElementAuthoringField;
    canonicalValue: string;
    revision: string;
    cleaningPolicyVersion?: string;
    nodeIdentityAssignments?: MaterialNodeIdentityAssignment[];
    changed: boolean;
    changeAccepted: true;
}

export type ElementChangeFailure =
    | {kind: "conflict"; elementId: string; changedField: ElementAuthoringField; currentRevision: string}
    | {kind: "acceptedRecovering"; change: AcceptedElementChange}
    | {kind: "failed"; errorCode: string; retryable: boolean; acceptanceUnknown: boolean};

export type ElementChangeResult =
    | {ok: true; change: AcceptedElementChange}
    | {ok: false; failure: ElementChangeFailure};

export interface CanonicalItemQA {
    prompt: string;
    answer: string;
    contentRevision: string;
}

export interface AcceptedItemQAChange {
    kind: "SaveItemQA";
    elementId: string;
    changedField: "itemQA";
    revision: string;
    itemQA: CanonicalItemQA;
    changed: boolean;
    changeAccepted: true;
}

export type ItemQAChangeFailure =
    | {kind: "conflict"; elementId: string; changedField: "itemQA"; currentRevision: string}
    | {kind: "acceptedRecovering"; change: AcceptedItemQAChange}
    | {kind: "failed"; errorCode: string; retryable: boolean; acceptanceUnknown: boolean};

export type ItemQAChangeResult =
    | {ok: true; change: AcceptedItemQAChange}
    | {ok: false; failure: ItemQAChangeFailure};

export interface FormalReviewCallFailure {
    errorCode: string;
    retryable: boolean;
    acceptance: "notAccepted" | "accepted" | "unknown";
    acceptedEventId?: string;
    session?: LearningSessionProjection;
    kind: "request" | "response" | "domain";
}

export type ItemGradeCallResult =
    | {ok: true; eventId: string; rawGrade: 0 | 1 | 2 | 3 | 4 | 5; reviewAccepted: true; session: LearningSessionProjection}
    | {ok: false; failure: FormalReviewCallFailure};

export type AuthoringFieldState =
    | "clean"
    | "pending"
    | "saving"
    | "failed"
    | "conflict"
    | "acceptedRecovering";

export type AuthoringStatus =
    | "clean"
    | "pending"
    | "saving"
    | "failed"
    | "acceptedRecovering"
    | "conflict";

export type ModelTransitionReason =
    | "target-change"
    | "surface-replacement"
    | "tab-close"
    | "batch-close"
    | "tab-eviction"
    | "tab-detach"
    | "cross-window-transfer"
    | "window-close"
    | "workspace-switch"
    | "application-exit"
    | "update-install";

export type ModelTransitionResult =
    | {allowed: true}
    | {allowed: false; reason: "save-failed" | "conflict" | "unavailable" | "busy"};

export interface AuthoringFieldSlot {
    field: ElementAuthoringField;
    localValue: string;
    canonicalBaseline: string;
    revision: string;
    localGeneration: number;
    acknowledgedGeneration: number;
    dirtySince?: number;
    state: AuthoringFieldState;
    submittedGeneration?: number;
    submittedValue?: string;
    failure?: {errorCode: string; retryable: boolean; acceptanceUnknown: boolean};
    conflictRevision?: string;
}

export interface InFlightElementSave {
    field: ElementAuthoringField;
    elementId: string;
    expectedRevision: string;
    submittedGeneration: number;
    submittedValue: string;
    startedAt: number;
}

export interface TopicClipboardSnapshot {
    textHTML: string;
    textPlain: string;
    hasHTML: boolean;
}

export type TopicPasteCommand = "paste" | "pasteAsPlainText" | "pasteAsHTML";

export type TopicPasteFlavor =
    | {kind: "html"; html: string}
    | {kind: "markdown"; markdown: string}
    | {kind: "plainText"; text: string}
    | {kind: "none"};

export interface TopicPasteAvailability {
    paste: boolean;
    pasteAsPlainText: boolean;
    pasteAsHTML: boolean;
}

export interface SiyuanMarkdownHTMLFragment {
    provenance: "siyuan-md2html";
    html: string;
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
    | {kind: "itemAuthoring"}
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
    | {phase: "itemAuthoring"; detail: ElementDetailView}
    | {phase: "rendererUnavailable"; detail: ElementDetailView; reason: RendererUnavailableReason}
    | {phase: "missing"}
    | {phase: "failure"; errorKind: ElementReadFailureKind};

export type PersistedExpandedElementIds = string[];
