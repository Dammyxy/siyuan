import type {
    ItemGradeCallResult,
    LearningControlProjection,
    LearningSessionProjection,
    ModelTransitionResult,
    SessionCallResult,
    TopicNextCallResult,
} from "./types";
import type {ContentPresentation} from "./ContentSurfaceHost";

interface LearningOperation {
    readonly isCancelled: boolean;
}

interface DisplayedEligibility {
    known: boolean;
    supportedTopic: boolean;
    supportedItem: boolean;
    readOnly: boolean;
    barrierActive: boolean;
    unavailable?: boolean;
}

interface ElementLearningCoordinatorOptions {
    displayedElementId: string;
    getDisplayedEligibility(): DisplayedEligibility;
    prepareTransition(): Promise<ModelTransitionResult>;
    getCurrent(): Promise<SessionCallResult>;
    start(): Promise<SessionCallResult>;
    stop(): Promise<SessionCallResult>;
    showAnswer(elementId: string): Promise<SessionCallResult>;
    gradeItem(elementId: string, eventId: string, rawGrade: number): Promise<ItemGradeCallResult>;
    nextTopic(elementId: string, eventId: string): Promise<TopicNextCallResult>;
    acceptStage(stage: "pending" | "finalDrill"): Promise<SessionCallResult>;
    declineStage(stage: "pending" | "finalDrill"): Promise<SessionCallResult>;
    createEventId(): string;
    followTarget(elementId: string): Promise<boolean>;
    publish(projection: LearningControlProjection): void;
    publishPresentation(presentation: ContentPresentation): void;
    runOperation<T>(name: string, callback: (operation: LearningOperation) => Promise<T>): Promise<{
        started: boolean;
        value?: T;
    }>;
}

interface FormalReviewIntent {
    elementId: string;
    eventId: string;
    rawGrade: 0 | 1 | 2 | 3 | 4 | 5;
    sessionId?: string;
    state: "submitting" | "retryable" | "acceptedNotAdvanced" | "acceptedRecovering" | "acceptedAdvanced";
    acceptance: "unknown" | "notAccepted" | "accepted";
    errorCode?: string;
    session?: LearningSessionProjection;
}

type ProjectionContext = "current" | "start" | "action";

const validGrade = (value: number): value is 0 | 1 | 2 | 3 | 4 | 5 =>
    Number.isInteger(value) && value >= 0 && value <= 5;

export class ElementLearningCoordinator {
    public readonly initialized: Promise<void>;
    private session?: LearningSessionProjection;
    private gradeIntent?: FormalReviewIntent;
    private disposed = false;
    private inFlight = false;
    private generation = 0;

    constructor(private readonly options: ElementLearningCoordinatorOptions) {
        this.initialized = this.refresh();
    }

    public refresh(): Promise<void> {
        return this.execute("symemo-learning-current", async (operation, generation) => {
            const result = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            this.adoptSessionResult(result, "current");
        });
    }

    public reproject(): void {
        if (this.disposed) return;
        if (this.session) this.projectSession(this.session, "current");
    }

    public resume(): Promise<void> {
        if (this.gradeIntent && this.gradeIntent.state !== "submitting") {
            return this.resumeGradeIntent();
        }
        return this.refresh();
    }

    public retryNext(): Promise<void> {
        return this.next();
    }

    public continueNext(): Promise<void> {
        if (this.gradeIntent?.state === "acceptedNotAdvanced") {
            return this.resumeGradeIntent();
        }
        return this.next();
    }

    public learn(): Promise<void> {
        return this.execute("symemo-learning-start", async (operation, generation) => {
            const current = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (current.ok === false) {
                this.publishFailure();
                return;
            }
            if (this.gradeIntent?.state === "acceptedAdvanced") {
                this.gradeIntent = undefined;
            }
            this.session = current.session;
            if (current.session.status === "active") {
                await this.followCurrent(current.session, operation, generation);
                this.projectSession(current.session, "current");
                return;
            }
            const started = await this.options.start();
            if (!this.isActive(operation, generation)) return;
            if (started.ok === false) {
                this.publishFailure();
                return;
            }
            this.session = started.session;
            await this.followCurrent(started.session, operation, generation);
            this.projectSession(started.session, "start");
        });
    }

    public showAnswer(): Promise<void> {
        const eligibility = this.options.getDisplayedEligibility();
        if (eligibility.readOnly || eligibility.barrierActive || !eligibility.supportedItem) return Promise.resolve();
        return this.execute("symemo-item-show-answer", async (operation, generation) => {
            const current = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (current.ok === false || !this.isMatchingItem(current.session, "question")) {
                if (current.ok) this.projectSession(current.session, "current");
                else this.publishFailure();
                return;
            }
            this.session = current.session;
            const result = await this.options.showAnswer(this.options.displayedElementId);
            if (!this.isActive(operation, generation)) return;
            this.adoptSessionResult(result, "action");
        });
    }

    public grade(rawGrade: number): Promise<void> {
        if (!validGrade(rawGrade)) return Promise.resolve();
        const eligibility = this.options.getDisplayedEligibility();
        if (eligibility.readOnly || eligibility.barrierActive || !eligibility.supportedItem) return Promise.resolve();
        if (this.gradeIntent) {
            if (this.gradeIntent.rawGrade !== rawGrade || this.gradeIntent.elementId !== this.options.displayedElementId) {
                this.projectRecovery();
            }
            return Promise.resolve();
        }
        return this.execute("symemo-item-grade", async (operation, generation) => {
            const current = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (current.ok === false || !this.isMatchingItem(current.session, "answer")) {
                if (current.ok) this.projectSession(current.session, "current");
                else this.publishFailure();
                return;
            }
            this.session = current.session;
            const prepared = await this.options.prepareTransition();
            if (!this.isActive(operation, generation) || !prepared.allowed) return;
            const intent = this.gradeIntent || {
                elementId: this.options.displayedElementId,
                eventId: this.options.createEventId(),
                rawGrade,
                sessionId: current.session.sessionId,
                state: "submitting",
                acceptance: "unknown",
            };
            this.gradeIntent = intent;
            await this.submitGradeIntent(intent, operation, generation);
        });
    }

    private resumeGradeIntent(): Promise<void> {
        return this.execute("symemo-item-grade-recovery", async (operation, generation) => {
            const intent = this.gradeIntent;
            if (!intent) return;
            const current = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (current.ok === false) {
                this.publishFailure("symemoItemReviewFailed");
                return;
            }
            this.session = current.session;
            if (intent.state === "acceptedRecovering" || intent.state === "acceptedAdvanced") {
                const stillPending = current.session.status === "active" && current.session.sessionId === intent.sessionId &&
                    current.session.pendingAcceptedEventId === intent.eventId;
                if (intent.state === "acceptedRecovering" && stillPending) {
                    intent.session = current.session;
                    this.projectRecovery();
                    return;
                }
                this.gradeIntent = undefined;
                await this.followCurrent(current.session, operation, generation);
                this.projectSession(current.session, "current");
                return;
            }
            if (!this.isMatchingItem(current.session, "answer") ||
                (intent.sessionId && current.session.sessionId && intent.sessionId !== current.session.sessionId)) {
                this.gradeIntent = undefined;
                this.publishPhase("failure", {messageKey: "symemoLearningStateChanged"});
                return;
            }
            intent.state = "submitting";
            await this.submitGradeIntent(intent, operation, generation);
        });
    }

    private async submitGradeIntent(
        intent: FormalReviewIntent,
        operation: LearningOperation,
        generation: number,
    ): Promise<void> {
        const result = await this.options.gradeItem(intent.elementId, intent.eventId, intent.rawGrade);
        if (!this.isActive(operation, generation)) return;
        if (result.ok === true) {
            intent.state = "acceptedAdvanced";
            intent.acceptance = "accepted";
            intent.session = result.session;
            this.session = result.session;
            const followed = await this.followCurrent(result.session, operation, generation, true);
            if (!this.isActive(operation, generation)) return;
            if (!followed && result.session.current && result.session.current.elementId !== this.options.displayedElementId) {
                this.publishFailure("symemoItemReviewSaved");
                return;
            }
            this.gradeIntent = undefined;
            this.projectSession(result.session, "action");
            return;
        }
        if (result.ok !== false) return;
        if (result.failure.session) {
            this.session = result.failure.session;
            intent.session = result.failure.session;
        }
        intent.errorCode = result.failure.errorCode;
        if (result.failure.acceptance === "accepted" && result.failure.acceptedEventId === intent.eventId) {
            intent.acceptance = "accepted";
            if (result.failure.errorCode === "queue-advance-failed" &&
                (!result.failure.session?.pendingAcceptedEventId || result.failure.session.pendingAcceptedEventId === intent.eventId)) {
                intent.state = "acceptedNotAdvanced";
                this.publishPhase("acceptedNotAdvanced", {
                    primaryAction: "continue",
                    messageKey: "symemoItemReviewSavedNotAdvanced",
                    session: result.failure.session,
                });
            } else {
                intent.state = "acceptedRecovering";
                this.publishPhase("acceptedRecovering", {
                    primaryAction: "resume",
                    messageKey: "symemoItemReviewSavedRecovering",
                    session: result.failure.session,
                });
            }
            return;
        }
        intent.acceptance = result.failure.acceptance;
        if (result.failure.errorCode === "target-mismatch" || result.failure.errorCode === "invalid-session-phase") {
            this.gradeIntent = undefined;
            this.publishPhase("failure", {messageKey: "symemoLearningStateChanged"});
            return;
        }
        intent.state = "retryable";
        this.projectRecovery();
    }

    private projectRecovery(): void {
        const intent = this.gradeIntent;
        if (!intent) return;
        if (intent.state === "acceptedNotAdvanced") {
            this.publishPhase("acceptedNotAdvanced", {
                primaryAction: "continue",
                messageKey: "symemoItemReviewSavedNotAdvanced",
                session: intent.session,
            });
        } else if (intent.state === "acceptedRecovering") {
            this.publishPhase("acceptedRecovering", {
                primaryAction: "resume",
                messageKey: "symemoItemReviewSavedRecovering",
                session: intent.session,
            });
        } else if (intent.state === "retryable") {
            this.publishPhase("retryableReview", {
                primaryAction: "resume",
                messageKey: "symemoItemReviewFailed",
                session: intent.session,
            });
        }
    }

    public next(): Promise<void> {
        if (this.gradeIntent) return Promise.resolve();
        const eligibility = this.options.getDisplayedEligibility();
        if (eligibility.readOnly || eligibility.barrierActive || !eligibility.supportedTopic) return Promise.resolve();
        return this.execute("symemo-topic-next", async (operation, generation) => {
            const current = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (current.ok === false || current.session.phase !== "question" ||
                (current.session.stage !== "outstanding" && current.session.stage !== "pending") ||
                current.session.current?.kind !== "element.topic" ||
                current.session.current.elementId !== this.options.displayedElementId) {
                if (current.ok) this.projectSession(current.session, "current");
                else this.publishFailure();
                return;
            }
            const prepared = await this.options.prepareTransition();
            if (!this.isActive(operation, generation) || !prepared.allowed) return;
            const eventId = this.options.createEventId();
            const result = await this.options.nextTopic(this.options.displayedElementId, eventId);
            if (!this.isActive(operation, generation)) return;
            if (result.ok) {
                this.session = result.session;
                await this.followCurrent(result.session, operation, generation, true);
                this.projectSession(result.session, "action");
            } else {
                this.publishFailure("symemoTopicReviewFailed");
            }
        });
    }

    public acceptPending(): Promise<void> {
        return this.stageAction("pending", true);
    }

    public declinePending(): Promise<void> {
        return this.stageAction("pending", false);
    }

    public declineFinalDrill(): Promise<void> {
        return this.stageAction("finalDrill", false);
    }

    public stop(): Promise<void> {
        return this.execute("symemo-learning-stop", async (operation, generation) => {
            const result = await this.options.stop();
            if (!this.isActive(operation, generation)) return;
            this.gradeIntent = undefined;
            this.adoptSessionResult(result, "action");
        });
    }

    public destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.generation++;
        this.session = undefined;
        this.gradeIntent = undefined;
    }

    private stageAction(stage: "pending" | "finalDrill", accept: boolean): Promise<void> {
        if (accept && this.options.getDisplayedEligibility().readOnly) return Promise.resolve();
        return this.execute(accept ? "symemo-learning-stage-accept" : "symemo-learning-stage-decline", async (
            operation,
            generation,
        ) => {
            const current = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (current.ok === false || current.session.phase !== "confirmation" || current.session.stage !== stage) {
                if (current.ok) this.projectSession(current.session, "current");
                else this.publishFailure();
                return;
            }
            const result = accept ? await this.options.acceptStage(stage) : await this.options.declineStage(stage);
            if (!this.isActive(operation, generation)) return;
            if (result.ok === false) {
                this.adoptSessionResult(result, "action");
                return;
            }
            this.session = result.session;
            await this.followCurrent(result.session, operation, generation);
            this.projectSession(result.session, "action");
        });
    }

    private async followCurrent(
        session: LearningSessionProjection,
        operation: LearningOperation,
        generation: number,
        transitionPrepared = false,
    ): Promise<boolean> {
        const target = session.current;
        if (!target || target.elementId === this.options.displayedElementId) return true;
        if (!transitionPrepared) {
            const prepared = await this.options.prepareTransition();
            if (!this.isActive(operation, generation) || !prepared.allowed) return false;
        }
        return this.options.followTarget(target.elementId);
    }

    private isMatchingItem(session: LearningSessionProjection, phase: "question" | "answer"): boolean {
        return session.status === "active" && session.phase === phase && session.current?.kind === "element.item" &&
            session.current.elementId === this.options.displayedElementId &&
            (session.stage === "outstanding" || session.stage === "pending");
    }

    private adoptSessionResult(result: SessionCallResult, context: ProjectionContext): void {
        if (result.ok === false) {
            if (result.failure.session) this.session = result.failure.session;
            this.publishFailure();
            return;
        }
        this.session = result.session;
        this.projectSession(result.session, context);
    }

    private projectSession(session: LearningSessionProjection, context: ProjectionContext): void {
        const eligibility = this.options.getDisplayedEligibility();
        if (!eligibility.known) {
            this.publishPhase("loading", {messageKey: "symemoLearningLoading"});
            return;
        }
        if (eligibility.barrierActive) {
            this.publishPhase("busy", {busy: true, messageKey: "symemoLearningBusy"});
            return;
        }
        if (eligibility.unavailable) {
            this.options.publishPresentation({kind: "ordinary"});
            this.publishFailure();
            return;
        }
        if (this.gradeIntent && (this.gradeIntent.state === "retryable" ||
            this.gradeIntent.state === "acceptedNotAdvanced" || this.gradeIntent.state === "acceptedRecovering")) {
            this.projectRecovery();
            return;
        }
        if (session.status === "completed") {
            this.options.publishPresentation({kind: "ordinary"});
            this.publishPhase(context === "start" ? "noDue" : context === "action" ? "completed" : "idle", {
                primaryAction: "learn",
                messageKey: context === "start" ? "symemoNoDueElements" :
                    context === "action" ? "symemoLearningComplete" : undefined,
            });
            return;
        }
        if (session.phase === "confirmation") {
            this.options.publishPresentation({kind: "ordinary"});
            if (session.stage === "pending") {
                this.publishPhase("pendingConfirmation", {session, messageKey: "symemoPendingConfirmation"});
            } else if (session.stage === "finalDrill") {
                this.publishPhase("finalDrillConfirmation", {
                    primaryAction: "declineFinalDrill",
                    session,
                    messageKey: "symemoFinalDrillDeferred",
                });
            } else {
                this.publishPhase("unsupportedSession", {messageKey: "symemoUnsupportedLearningStage"});
            }
            return;
        }
        const target = session.current;
        if (!target) {
            this.options.publishPresentation({kind: "ordinary"});
            this.publishPhase("unsupportedSession", {messageKey: "symemoUnsupportedLearningStage"});
            return;
        }
        if (session.stage === "finalDrill") {
            this.options.publishPresentation({kind: "ordinary"});
            this.publishPhase("unsupportedSession", {
                secondaryAction: "stop",
                session,
                messageKey: "symemoFinalDrillDeferred",
            });
            return;
        }
        if (target.elementId !== this.options.displayedElementId) {
            this.options.publishPresentation({kind: "ordinary"});
            this.publishPhase("preview", {primaryAction: "learn", session, messageKey: "symemoLearningTargetPreview"});
            return;
        }
        if (eligibility.readOnly) {
            if (target.kind === "element.item" && eligibility.supportedItem && session.sessionId &&
                (session.phase === "question" || (session.phase === "answer" && Boolean(target.answer)))) {
                this.options.publishPresentation({
                    kind: "activeItemReview",
                    sessionId: session.sessionId,
                    phase: session.phase as "question" | "answer",
                    target,
                });
            } else {
                this.options.publishPresentation({kind: "ordinary"});
            }
            this.publishPhase("readOnly", {secondaryAction: "stop", session, messageKey: "symemoLearningReadOnly"});
            return;
        }
        if (target.kind === "element.topic" && eligibility.supportedTopic && session.phase === "question") {
            this.options.publishPresentation({kind: "ordinary"});
            this.publishPhase("activeTopic", {primaryAction: "next", targetElementId: target.elementId, session});
            return;
        }
        if (target.kind === "element.item" && eligibility.supportedItem && session.sessionId && session.phase === "question") {
            this.options.publishPresentation({
                kind: "activeItemReview",
                sessionId: session.sessionId,
                phase: "question",
                target,
            });
            this.publishPhase("activeItemQuestion", {
                primaryAction: "showAnswer",
                targetElementId: target.elementId,
                session,
            });
            return;
        }
        if (target.kind === "element.item" && eligibility.supportedItem && session.sessionId &&
            session.phase === "answer" && target.answer) {
            this.options.publishPresentation({
                kind: "activeItemReview",
                sessionId: session.sessionId,
                phase: "answer",
                target,
            });
            this.publishPhase("activeItemAnswer", {targetElementId: target.elementId, session});
            return;
        }
        this.options.publishPresentation({kind: "ordinary"});
        this.publishPhase("unsupportedSession", {secondaryAction: "stop", session, messageKey: "symemoUnsupportedLearningStage"});
    }

    private publishFailure(messageKey = "symemoLearningUnavailable"): void {
        this.publishPhase("failure", {primaryAction: "resume", messageKey});
    }

    private publishPhase(
        phase: LearningControlProjection["phase"],
        values: Partial<Omit<LearningControlProjection, "phase" | "displayedElementId" | "busy">> & {busy?: boolean},
    ): void {
        this.options.publish({
            phase,
            displayedElementId: this.options.displayedElementId,
            busy: values.busy ?? false,
            ...values,
        });
    }

    private async execute(
        name: string,
        callback: (operation: LearningOperation, generation: number) => Promise<void>,
    ): Promise<void> {
        if (this.disposed || this.inFlight) return;
        this.inFlight = true;
        const generation = this.generation;
        try {
            await this.options.runOperation(name, (operation) => callback(operation, generation));
        } catch (_) {
            if (!this.disposed && generation === this.generation) this.publishFailure();
        } finally {
            if (!this.disposed && generation === this.generation) this.inFlight = false;
        }
    }

    private isActive(operation: LearningOperation, generation: number): boolean {
        return !this.disposed && !operation.isCancelled && generation === this.generation;
    }
}
