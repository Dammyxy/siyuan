import type {LearningControlProjection, LearningPrimaryAction} from "./types";

export type TopicLearningControlIntent = LearningPrimaryAction | "stop";

export interface TopicLearningControlsOptions {
    container: HTMLElement;
    onIntent(intent: TopicLearningControlIntent): void;
}

const primaryLanguageKey: Record<LearningPrimaryAction, string> = {
    learn: "symemoLearn",
    next: "symemoNext",
    retryNext: "symemoRetryNext",
    continue: "symemoContinueLearning",
    resume: "symemoResumeLearning",
    showAnswer: "symemoShowAnswer",
    acceptPending: "symemoAcceptPending",
    declineFinalDrill: "symemoEndLearning",
};

const language = (key: string): string => window.siyuan?.languages?.[key] || "";

export class TopicLearningControls {
    private projection?: LearningControlProjection;
    private disposed = false;

    constructor(private readonly options: TopicLearningControlsOptions) {
        options.container.classList.add("symemo-element-tab__learning");
        options.container.setAttribute("role", "region");
        options.container.setAttribute("aria-label", language("symemoLearn"));
    }

    public render(projection: LearningControlProjection): void {
        if (this.disposed) return;
        this.projection = projection;
        const container = this.options.container;
        container.replaceChildren();
        container.setAttribute("aria-busy", projection.busy ? "true" : "false");

        const status = document.createElement("div");
        status.className = "symemo-element-tab__learning-status b3-label__text";
        status.setAttribute("aria-live", "polite");
        status.textContent = projection.messageKey ? language(projection.messageKey) : "";

        const actions = document.createElement("div");
        actions.className = "symemo-element-tab__learning-actions";
        if (projection.primaryAction) {
            actions.append(this.createButton(
                language(primaryLanguageKey[projection.primaryAction]),
                projection.primaryAction,
                projection.busy,
            ));
        }
        if (projection.secondaryAction === "stop") {
            actions.append(this.createButton(language("symemoEndLearning"), "stop", projection.busy));
        }
        container.append(status, actions);
    }

    public destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.projection = undefined;
        this.options.container.replaceChildren();
    }

    private createButton(label: string, intent: TopicLearningControlIntent, disabled: boolean): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("type", "button");
        button.className = "b3-button b3-button--text";
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener("click", () => {
            if (this.disposed || this.projection?.busy) return;
            this.options.onIntent(intent);
        });
        return button;
    }
}
