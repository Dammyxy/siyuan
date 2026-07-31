import type {LearningSessionProjection, ModelTransitionReason, ModelTransitionResult} from "./types";

interface ItemReviewSurfaceOptions {
    container: HTMLElement;
    language?: (key: string) => string;
}

const itemTarget = (session: LearningSessionProjection) =>
    session.status === "active" && session.current?.kind === "element.item"
        ? session.current
        : undefined;

export class ItemReviewSurface {
    private disposed = false;
    private session?: LearningSessionProjection;

    constructor(private readonly options: ItemReviewSurfaceOptions) {}

    public mount(session: LearningSessionProjection): void {
        this.disposed = false;
        this.update(session);
    }

    public update(session: LearningSessionProjection): void {
        if (this.disposed) return;
        const target = itemTarget(session);
        if (!target || (session.phase !== "question" && session.phase !== "answer")) {
            this.options.container.replaceChildren();
            this.session = undefined;
            return;
        }
        if (session.phase === "answer" && (typeof target.answer !== "string" || target.answer.trim().length === 0)) {
            this.options.container.replaceChildren();
            this.session = undefined;
            return;
        }

        const shouldFocusAnswer = session.phase === "answer" && this.session?.phase !== "answer";
        this.session = session;
        const article = document.createElement("article");
        article.className = "symemo-item-review";
        article.setAttribute("data-element-id", target.elementId);

        const question = document.createElement("section");
        question.className = "symemo-item-review__question";
        question.setAttribute("data-role", "item-question");
        question.setAttribute("tabindex", "-1");
        question.textContent = target.prompt;
        article.append(question);

        let answer: HTMLElement | undefined;
        if (session.phase === "answer") {
            answer = document.createElement("section");
            answer.className = "symemo-item-review__answer";
            answer.setAttribute("data-role", "item-answer");
            answer.setAttribute("tabindex", "-1");
            answer.textContent = target.answer!;
            article.append(answer);
        }
        this.options.container.replaceChildren(article);
        if (shouldFocusAnswer) answer?.focus();
    }

    public prepareTransition(reason: ModelTransitionReason): ModelTransitionResult {
        void reason;
        return {allowed: true};
    }

    public focus(): void {
        const role = this.session?.phase === "answer" ? "item-answer" : "item-question";
        (this.options.container.querySelector(`[data-role="${role}"]`) as HTMLElement | null)?.focus?.();
    }

    public destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.session = undefined;
        this.options.container.replaceChildren();
    }
}
