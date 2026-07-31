import type {LearningControlProjection} from "./types";

export type LearningControlIntent =
    | {kind: "learn" | "next" | "showAnswer" | "acceptPending" | "declinePending" | "declineFinalDrill" | "stop" | "retryNext" | "continue" | "resume"}
    | {kind: "grade"; rawGrade: 0 | 1 | 2 | 3 | 4 | 5};

interface LearningControlsOptions {
    container: HTMLElement;
    language?: (key: string) => string;
    onIntent(intent: LearningControlIntent): void;
}

const gradeLabels: ReadonlyArray<{grade: 5 | 4 | 3 | 2 | 1; key: string}> = [
    {grade: 5, key: "symemoGradeGreat"},
    {grade: 4, key: "symemoGradeGood"},
    {grade: 3, key: "symemoGradePass"},
    {grade: 2, key: "symemoGradeFail"},
    {grade: 1, key: "symemoGradeBad"},
];

const primaryLabels: Partial<Record<NonNullable<LearningControlProjection["primaryAction"]>, string>> = {
    learn: "symemoLearn",
    next: "symemoNext",
    showAnswer: "symemoShowAnswer",
    acceptPending: "symemoAcceptPending",
    declineFinalDrill: "symemoEndLearning",
    retryNext: "symemoRetryNext",
    continue: "symemoContinueLearning",
    resume: "symemoResumeLearning",
};

const allowedPrimaryActions: Partial<Record<LearningControlProjection["phase"], ReadonlyArray<
    NonNullable<LearningControlProjection["primaryAction"]>
>>> = {
    idle: ["learn"],
    preview: ["learn"],
    activeTopic: ["next"],
    activeItemQuestion: ["showAnswer"],
    retryableNext: ["retryNext"],
    retryableReview: ["resume"],
    acceptedNotAdvanced: ["continue"],
    acceptedRecovering: ["resume"],
    completed: ["learn"],
    noDue: ["learn"],
    failure: ["resume"],
};

const isEditableTarget = (target: EventTarget | null): boolean => {
    let element = target as HTMLElement | null;
    while (element) {
        const tagName = element.tagName?.toLowerCase();
        if (tagName === "textarea" || tagName === "input" || tagName === "select" || tagName === "button" ||
            element.isContentEditable || element.getAttribute?.("contenteditable") === "true" ||
            element.classList?.contains("protyle-wysiwyg")) {
            return true;
        }
        element = element.parentElement;
    }
    return false;
};

export class LearningControls {
    private projection?: LearningControlProjection;
    private active = true;
    private intentPending = false;
    private disposed = false;
    private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
    private readonly keyboardScope: HTMLElement;

    constructor(private readonly options: LearningControlsOptions) {
        this.options.container.classList.add("symemo-element-tab__learning");
        this.keyboardScope = this.options.container.parentElement || this.options.container;
        this.keyboardScope.addEventListener("keydown", this.onKeyDown);
    }

    public render(projection: LearningControlProjection): void {
        if (this.disposed) return;
        this.projection = projection;
        this.intentPending = false;
        const container = this.options.container;
        container.replaceChildren();
        container.setAttribute("role", "region");
        container.setAttribute("aria-label", this.language("symemoLearn"));
        container.setAttribute("aria-busy", String(projection.busy));

        const status = document.createElement("div");
        status.className = "symemo-element-tab__learning-status symemo-learning-controls__status";
        status.setAttribute("aria-live", "polite");
        const inferredMessage = projection.phase === "finalDrillConfirmation" ? "symemoFinalDrillDeferred" : undefined;
        status.textContent = projection.messageKey || inferredMessage
            ? this.language(projection.messageKey || inferredMessage!)
            : "";
        container.append(status);

        if (projection.phase === "activeItemAnswer") {
            this.renderGrades(container, projection.busy);
            return;
        }
        if (projection.phase === "pendingConfirmation") {
            this.appendButton(container, this.language("symemoAcceptPending"), {kind: "acceptPending"}, projection.busy);
            this.appendButton(container, this.language("symemoDeclinePending"), {kind: "declinePending"}, projection.busy);
            return;
        }
        if (projection.phase === "finalDrillConfirmation") {
            this.appendButton(container, this.language("symemoEndLearning"), {kind: "declineFinalDrill"}, projection.busy);
            return;
        }
        if (projection.primaryAction) {
            const actionAllowed = allowedPrimaryActions[projection.phase]?.includes(projection.primaryAction) === true;
            const labelKey = actionAllowed ? primaryLabels[projection.primaryAction] : undefined;
            if (labelKey) {
                this.appendButton(container, this.language(labelKey), {kind: projection.primaryAction}, projection.busy);
            }
        }
        if (projection.secondaryAction === "stop") {
            this.appendButton(container, this.language("symemoEndLearning"), {kind: "stop"}, projection.busy);
        }
    }

    public setActive(active: boolean): void {
        this.active = active;
    }

    public destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.projection = undefined;
        this.keyboardScope.removeEventListener?.("keydown", this.onKeyDown);
        this.options.container.replaceChildren();
    }

    private renderGrades(container: HTMLElement, busy: boolean): void {
        const group = document.createElement("div");
        group.className = "symemo-learning-controls__grades";
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", this.language("symemoAnswer"));
        for (const item of gradeLabels) {
            const label = this.language(item.key);
            const button = this.appendButton(group, String(item.grade), {kind: "grade", rawGrade: item.grade}, busy);
            button.setAttribute("data-grade", String(item.grade));
            button.setAttribute("aria-label", label);
            button.title = label;
        }
        const nullAssistive = document.createElement("span");
        nullAssistive.className = "symemo-learning-controls__assistive";
        nullAssistive.setAttribute("data-role", "grade-null-assistive");
        nullAssistive.textContent = this.language("symemoGradeNull");
        group.append(nullAssistive);
        container.append(group);
    }

    private appendButton(
        container: HTMLElement,
        label: string,
        intent: LearningControlIntent,
        disabled: boolean,
    ): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "b3-button b3-button--outline";
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener("click", () => this.submit(intent));
        container.append(button);
        return button;
    }

    private submit(intent: LearningControlIntent): void {
        if (!this.active || this.disposed || this.intentPending || this.projection?.busy) return;
        this.intentPending = true;
        this.options.onIntent(intent);
    }

    private handleKeyDown(event: KeyboardEvent): void {
        const projection = this.projection;
        if (!this.active || this.disposed || this.intentPending || !projection || projection.busy ||
            projection.phase !== "activeItemAnswer" ||
            projection.targetElementId !== projection.displayedElementId ||
            event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
            event.repeat || event.isComposing || isEditableTarget(event.target)) {
            return;
        }
        if (!/^[0-5]$/.test(event.key)) return;
        event.preventDefault();
        this.submit({kind: "grade", rawGrade: Number(event.key) as 0 | 1 | 2 | 3 | 4 | 5});
    }

    private language(key: string): string {
        return this.options.language?.(key) || window.siyuan?.languages?.[key] || key;
    }
}
