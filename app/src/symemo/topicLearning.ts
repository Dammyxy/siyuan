import {runWindowAuthoringOperation, WindowAuthoringOperation} from "./authoringRegistry";
import type {
    LearningControlProjection,
    LearningSessionProjection,
    ModelTransitionResult,
    SessionCallResult,
    TopicNextCallResult,
    TopicNextIntent,
} from "./types";

export interface DisplayedTopicEligibility {
    known: boolean;
    supportedTopic: boolean;
    readOnly: boolean;
    barrierActive: boolean;
    unavailable?: boolean;
}

export interface TopicLearningOperation {
    readonly isCancelled: boolean;
}

export type TopicLearningRunOperation = <T>(
    name: string,
    callback: (operation: TopicLearningOperation) => Promise<T> | T,
) => Promise<{started: true; value: T} | {started: false}>;

export interface TopicLearningCoordinatorOptions {
    displayedElementId: string;
    getDisplayedEligibility(): DisplayedTopicEligibility;
    prepareTransition(): Promise<ModelTransitionResult>;
    getCurrent(): Promise<SessionCallResult>;
    start(): Promise<SessionCallResult>;
    stop(): Promise<SessionCallResult>;
    next(elementId: string, eventId: string): Promise<TopicNextCallResult>;
    createEventId(): string;
    followTarget(elementId: string): Promise<boolean>;
    publish(state: LearningControlProjection): void;
    runOperation?: TopicLearningRunOperation;
}

type ProjectionContext = "current" | "start" | "stop" | "next";

const defaultRunOperation: TopicLearningRunOperation = (name, callback) =>
    runWindowAuthoringOperation(name, (operation: WindowAuthoringOperation) => callback(operation));

const isSupportedTopicSession = (session: LearningSessionProjection): boolean =>
    session.status === "active" && session.phase === "question" &&
    (session.stage === "outstanding" || session.stage === "pending") &&
    session.current?.kind === "element.topic";

export class TopicLearningCoordinator {
    public readonly initialized: Promise<void>;
    private readonly runOperation: TopicLearningRunOperation;
    private state: LearningControlProjection;
    private session?: LearningSessionProjection;
    private generation = 0;
    private inFlight = false;
    private reprojectPending = false;
    private disposed = false;
    private nextIntent?: TopicNextIntent;

    constructor(private readonly options: TopicLearningCoordinatorOptions) {
        this.runOperation = options.runOperation || defaultRunOperation;
        this.state = this.createProjection("loading", {
            busy: false,
            messageKey: "symemoLearningLoading",
        });
        this.publish(this.state);
        this.initialized = this.refresh();
    }

    public refresh(): Promise<void> {
        return this.execute("symemo-topic-current", async (operation, generation) => {
            const result = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            this.adoptSessionResult(result, "current");
        });
    }

    public learn(): Promise<void> {
        if (this.hasHistoryRepairIntent()) {
            this.publishRecoveryUnavailable();
            return Promise.resolve();
        }
        return this.execute("symemo-topic-learn", async (operation, generation) => {
            const current = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (current.ok === false) {
                this.adoptFailure(current);
                return;
            }
            this.reconcileIntentForResume(current.session);
            this.session = current.session;

            if (isSupportedTopicSession(current.session) &&
                current.session.current?.elementId === this.options.displayedElementId) {
                this.projectSession(current.session, "current");
                return;
            }
            if (isSupportedTopicSession(current.session) && current.session.current) {
                if (!await this.prepare(operation, generation)) return;
                if (await this.follow(current.session.current.elementId, operation, generation)) {
                    this.projectSession(current.session, "current");
                }
                return;
            }
            if (current.session.status !== "completed") {
                this.projectSession(current.session, "current");
                return;
            }
            if (!await this.prepare(operation, generation)) return;
            const started = await this.options.start();
            if (!this.isActive(operation, generation)) return;
            if (started.ok === false) {
                this.adoptFailure(started);
                return;
            }
            this.session = started.session;
            if (isSupportedTopicSession(started.session) && started.session.current &&
                started.session.current.elementId !== this.options.displayedElementId) {
                if (await this.follow(started.session.current.elementId, operation, generation)) {
                    this.projectSession(started.session, "start");
                }
                return;
            }
            this.projectSession(started.session, "start");
        });
    }

    public stop(): Promise<void> {
        return this.execute("symemo-topic-stop", async (operation, generation) => {
            const current = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (current.ok === false) {
                this.adoptFailure(current);
                return;
            }
            this.session = current.session;
            if (current.session.status !== "active") {
                this.reconcileNextIntent();
                this.projectSession(current.session, "current");
                return;
            }
            const stopped = await this.options.stop();
            if (!this.isActive(operation, generation)) return;
            if (stopped.ok) this.reconcileNextIntent();
            this.adoptSessionResult(stopped, "stop");
        });
    }

    public next(): Promise<void> {
        if (this.nextIntent && this.nextIntent.state !== "reconciled") return Promise.resolve();
        return this.submitNext("ordinary");
    }

    public retryNext(): Promise<void> {
        if (this.hasHistoryRepairIntent()) {
            this.publishRecoveryUnavailable();
            return Promise.resolve();
        }
        if (this.nextIntent?.state !== "retryable") return Promise.resolve();
        return this.submitNext("retry");
    }

    public continueNext(): Promise<void> {
        const intent = this.nextIntent;
        if (!intent || intent.state !== "acceptedNotAdvanced") return Promise.resolve();
        return this.execute("symemo-topic-next-continue", async (operation, generation) => {
            const eligibility = this.options.getDisplayedEligibility();
            if (!eligibility.known || !eligibility.supportedTopic || eligibility.readOnly || eligibility.barrierActive) {
                this.projectSession(intent.session || this.session || {
                    status: "completed", phase: "completed", remainingElementIds: [],
                }, "current");
                return;
            }
            intent.state = "submitting";
            const result = await this.options.next(intent.elementId, intent.eventId);
            if (!this.isActive(operation, generation)) return;
            await this.handleNextResult(result, intent, operation, generation);
        });
    }

    public resume(): Promise<void> {
        if (this.hasHistoryRepairIntent()) {
            this.publishRecoveryUnavailable();
            return Promise.resolve();
        }
        return this.learn();
    }

    private submitNext(mode: "ordinary" | "retry"): Promise<void> {
        return this.execute(mode === "ordinary" ? "symemo-topic-next" : "symemo-topic-next-retry", async (
            operation,
            generation,
        ) => {
            const current = await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (current.ok === false) {
                this.adoptFailure(current);
                return;
            }
            this.session = current.session;
            const retained = mode === "retry" ? this.nextIntent : undefined;
            if (retained && this.hasSessionChanged(retained, current.session)) {
                this.reconcileNextIntent();
                this.publishFailure("symemoLearningStateChanged");
                return;
            }
            if (!isSupportedTopicSession(current.session) ||
                current.session.current?.elementId !== this.options.displayedElementId) {
                if (retained) this.reconcileNextIntent();
                if (isSupportedTopicSession(current.session) && current.session.current) {
                    if (!await this.prepare(operation, generation)) return;
                    if (await this.follow(current.session.current.elementId, operation, generation)) {
                        this.projectSession(current.session, "current");
                    }
                } else {
                    this.projectSession(current.session, "current");
                }
                return;
            }

            const eligibility = this.options.getDisplayedEligibility();
            if (!eligibility.known || !eligibility.supportedTopic || eligibility.readOnly || eligibility.barrierActive) {
                this.projectSession(current.session, "current");
                return;
            }
            if (!await this.prepare(operation, generation)) return;
            const rechecked = this.options.getDisplayedEligibility();
            if (!rechecked.known || !rechecked.supportedTopic || rechecked.readOnly || rechecked.barrierActive) {
                this.projectSession(current.session, "current");
                return;
            }

            const eventId = retained?.eventId || this.options.createEventId();
            const intent: TopicNextIntent = retained || {
                eventId,
                sessionId: current.session.sessionId,
                elementId: this.options.displayedElementId,
                state: "submitting",
                acceptance: "unknown",
            };
            intent.state = "submitting";
            intent.errorCode = undefined;
            this.nextIntent = intent;
            const result = await this.options.next(intent.elementId, intent.eventId);
            if (!this.isActive(operation, generation)) return;
            await this.handleNextResult(result, intent, operation, generation);
        });
    }

    private async handleNextResult(
        result: TopicNextCallResult,
        intent: TopicNextIntent,
        operation: TopicLearningOperation,
        generation: number,
    ): Promise<void> {
        if (result.ok) {
            if (result.eventId !== intent.eventId) {
                intent.state = "retryable";
                intent.acceptance = "unknown";
                intent.errorCode = "response";
                this.publishRetryableNext();
                return;
            }
            intent.state = "acceptedAdvanced";
            intent.acceptance = "accepted";
            intent.session = result.session;
            intent.errorCode = undefined;
            this.session = result.session;
            this.reconcileNextIntent();
            if (isSupportedTopicSession(result.session) && result.session.current &&
                result.session.current.elementId !== this.options.displayedElementId) {
                if (await this.follow(result.session.current.elementId, operation, generation)) {
                    this.projectSession(result.session, "next");
                }
                return;
            }
            this.projectSession(result.session, "next");
            return;
        }

        if (!("failure" in result)) return;
        const failure = result.failure;
        const acceptanceWasKnown = intent.acceptance === "accepted";
        intent.acceptance = acceptanceWasKnown ? "accepted" : failure.acceptance;
        intent.errorCode = failure.errorCode;
        intent.session = failure.session;
        if (failure.session) this.session = failure.session;
        const eligibility = this.options.getDisplayedEligibility();

        if (failure.acceptance === "accepted") {
            const matchingIdentity = failure.acceptedEventId === intent.eventId;
            const matchingPending = !failure.session?.pendingAcceptedEventId ||
                failure.session.pendingAcceptedEventId === intent.eventId;
            if (failure.errorCode === "queue-advance-failed" && matchingIdentity && matchingPending) {
                intent.state = "acceptedNotAdvanced";
                if (eligibility.readOnly) {
                    this.projectSession(failure.session || this.session || {
                        status: "completed", phase: "completed", remainingElementIds: [],
                    }, "current");
                } else {
                    this.publishAcceptedNotAdvanced();
                }
                return;
            }
            intent.state = "acceptedRecovering";
            if (eligibility.readOnly) {
                this.projectSession(failure.session || this.session || {
                    status: "completed", phase: "completed", remainingElementIds: [],
                }, "current");
            } else {
                this.publishAcceptedRecovering(
                    matchingIdentity ? "symemoTopicReviewSavedRecovering" : "symemoLearningUnavailable",
                );
            }
            return;
        }

        if (acceptanceWasKnown) {
            if (failure.errorCode === "history-requires-repair") {
                intent.state = "retryable";
                this.publishRecoveryUnavailable();
                return;
            }
            intent.state = "acceptedNotAdvanced";
            if (eligibility.readOnly) {
                this.projectSession(failure.session || this.session || {
                    status: "completed", phase: "completed", remainingElementIds: [],
                }, "current");
            } else {
                this.publishAcceptedNotAdvanced();
            }
            return;
        }

        if (failure.errorCode === "target-mismatch" || failure.errorCode === "invalid-session-phase") {
            const refreshed = failure.session ? {ok: true as const, session: failure.session} : await this.options.getCurrent();
            if (!this.isActive(operation, generation)) return;
            if (refreshed.ok === false) {
                intent.state = "retryable";
                this.publishRetryableNext();
                return;
            }
            this.reconcileNextIntent();
            this.session = refreshed.session;
            if (isSupportedTopicSession(refreshed.session) && refreshed.session.current &&
                refreshed.session.current.elementId !== this.options.displayedElementId) {
                if (await this.follow(refreshed.session.current.elementId, operation, generation)) {
                    this.projectSession(refreshed.session, "current");
                }
            } else {
                this.projectSession(refreshed.session, "current");
            }
            return;
        }

        intent.state = "retryable";
        if (failure.errorCode === "history-requires-repair") {
            this.publishRecoveryUnavailable();
        } else if (failure.errorCode === "readonly" || eligibility.readOnly) {
            this.projectSession(failure.session || this.session || {
                status: "completed", phase: "completed", remainingElementIds: [],
            }, "current");
        } else {
            this.publishRetryableNext();
        }
    }

    private hasSessionChanged(intent: TopicNextIntent, session: LearningSessionProjection): boolean {
        return Boolean(intent.sessionId && session.sessionId && intent.sessionId !== session.sessionId);
    }

    private reconcileIntentForResume(session: LearningSessionProjection): void {
        const intent = this.nextIntent;
        if (!intent) return;
        if (intent.errorCode === "history-requires-repair") return;
        if (intent.state === "acceptedAdvanced") {
            this.reconcileNextIntent();
            return;
        }
        if (intent.state !== "acceptedRecovering" && intent.errorCode !== "history-requires-repair") return;
        const stillPending = session.status === "active" && session.sessionId === intent.sessionId &&
            session.current?.elementId === intent.elementId && session.pendingAcceptedEventId === intent.eventId;
        if (!stillPending) this.reconcileNextIntent();
    }

    private reconcileNextIntent(): void {
        if (!this.nextIntent) return;
        this.nextIntent.state = "reconciled";
        this.nextIntent = undefined;
    }

    private publishRetryableNext(): void {
        this.publish(this.createProjection("retryableNext", {
            primaryAction: "retryNext",
            busy: false,
            messageKey: "symemoTopicReviewFailed",
        }));
    }

    private publishAcceptedNotAdvanced(): void {
        this.publish(this.createProjection("acceptedNotAdvanced", {
            primaryAction: "continue",
            busy: false,
            messageKey: "symemoTopicReviewSavedNotAdvanced",
        }));
    }

    private publishAcceptedRecovering(messageKey = "symemoTopicReviewSavedRecovering"): void {
        this.publish(this.createProjection("acceptedRecovering", {
            primaryAction: "resume",
            busy: false,
            messageKey,
        }));
    }

    public reproject(): void {
        if (this.disposed) return;
        if (this.inFlight) {
            this.reprojectPending = true;
            return;
        }
        this.reprojectPending = false;
        if (this.options.getDisplayedEligibility().barrierActive) {
            this.publish(this.createProjection("busy", {
                busy: true,
                messageKey: "symemoLearningBusy",
            }));
            return;
        }
        if (!this.session) {
            if (this.state.phase === "failure") {
                this.publish(this.state);
            } else {
                this.publish(this.createProjection("loading", {
                    busy: false,
                    messageKey: "symemoLearningLoading",
                }));
            }
            return;
        }
        this.projectSession(this.session, "current");
    }

    public destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.generation++;
        this.inFlight = false;
        this.session = undefined;
        this.nextIntent = undefined;
    }

    private async execute(
        name: string,
        callback: (operation: TopicLearningOperation, generation: number) => Promise<void>,
    ): Promise<void> {
        if (this.disposed || this.inFlight) return;
        this.inFlight = true;
        const generation = this.generation;
        this.publish(this.createProjection("busy", {
            busy: true,
            messageKey: "symemoLearningBusy",
        }));
        try {
            const result = await this.runOperation(name, (operation) => callback(operation, generation));
            if (!this.disposed && generation === this.generation && result.started === false) {
                this.publishFailure();
            }
        } catch (_) {
            if (!this.disposed && generation === this.generation) this.publishFailure();
        } finally {
            if (!this.disposed && generation === this.generation) {
                this.inFlight = false;
                if (this.reprojectPending) this.reproject();
            }
        }
    }

    private async prepare(operation: TopicLearningOperation, generation: number): Promise<boolean> {
        const eligibility = this.options.getDisplayedEligibility();
        if (!eligibility.known || !eligibility.supportedTopic || eligibility.barrierActive) {
            this.publishFailure();
            return false;
        }
        const result = await this.options.prepareTransition();
        if (!this.isActive(operation, generation)) return false;
        if (result.allowed === false) {
            this.publishFailure();
            return false;
        }
        return true;
    }

    private async follow(
        elementId: string,
        operation: TopicLearningOperation,
        generation: number,
    ): Promise<boolean> {
        const followed = await this.options.followTarget(elementId);
        if (!this.isActive(operation, generation)) return false;
        if (!followed) {
            this.publishFailure();
            return false;
        }
        return true;
    }

    private adoptSessionResult(result: SessionCallResult, context: ProjectionContext): void {
        if (result.ok === false) {
            this.adoptFailure(result);
            return;
        }
        this.session = result.session;
        this.projectSession(result.session, context);
    }

    private adoptFailure(result: Extract<SessionCallResult, {ok: false}>): void {
        if (result.failure.session) {
            this.session = result.failure.session;
        }
        this.publishFailure();
    }

    private projectSession(session: LearningSessionProjection, context: ProjectionContext): void {
        const eligibility = this.options.getDisplayedEligibility();
        if (!eligibility.known) {
            this.publish(this.createProjection("loading", {
                busy: false,
                messageKey: "symemoLearningLoading",
            }));
            return;
        }
        if (eligibility.barrierActive) {
            this.publish(this.createProjection("busy", {
                busy: true,
                messageKey: "symemoLearningBusy",
            }));
            return;
        }
        if (eligibility.unavailable) {
            this.publishRecoveryUnavailable();
            return;
        }
        if (session.status === "active" && session.current?.elementId === this.options.displayedElementId &&
            eligibility.readOnly) {
            this.publish(this.createProjection("readOnly", {
                secondaryAction: "stop",
                busy: false,
                messageKey: "symemoLearningReadOnly",
            }));
            return;
        }
        if (this.nextIntent?.state === "retryable") {
            if (this.nextIntent.errorCode === "history-requires-repair") {
                this.publishRecoveryUnavailable();
            } else {
                this.publishRetryableNext();
            }
            return;
        }
        if (this.nextIntent?.state === "acceptedNotAdvanced") {
            this.publishAcceptedNotAdvanced();
            return;
        }
        if (this.nextIntent?.state === "acceptedRecovering") {
            this.publishAcceptedRecovering();
            return;
        }
        if (session.status === "completed") {
            const noDue = context === "start";
            const completed = context === "next";
            this.publish(this.createProjection(completed ? "completed" : noDue ? "noDue" : "idle", {
                primaryAction: "learn",
                busy: false,
                messageKey: completed ? "symemoLearningComplete" : noDue ? "symemoNoDueTopics" : undefined,
            }));
            return;
        }
        if (!isSupportedTopicSession(session) || !session.current || !eligibility.supportedTopic) {
            this.publish(this.createProjection("unsupportedSession", {
                secondaryAction: "stop",
                busy: false,
                messageKey: "symemoUnsupportedLearningStage",
            }));
            return;
        }
        if (session.current.elementId !== this.options.displayedElementId) {
            this.publish(this.createProjection("preview", {
                primaryAction: "learn",
                busy: false,
                messageKey: "symemoLearningPreview",
            }));
            return;
        }
        this.publish(this.createProjection("activeTopic", {
            primaryAction: "next",
            busy: false,
            messageKey: context === "next" ? "symemoTopicReviewSaved" : undefined,
        }));
    }

    private publishFailure(messageKey = "symemoLearningUnavailable"): void {
        this.publish(this.createProjection("failure", {
            primaryAction: "resume",
            busy: false,
            messageKey,
        }));
    }

    private publishRecoveryUnavailable(): void {
        this.publish(this.createProjection("failure", {
            busy: false,
            messageKey: "symemoLearningUnavailable",
        }));
    }

    private hasHistoryRepairIntent(): boolean {
        return this.nextIntent?.errorCode === "history-requires-repair";
    }

    private createProjection(
        phase: LearningControlProjection["phase"],
        values: Omit<LearningControlProjection, "phase" | "displayedElementId">,
    ): LearningControlProjection {
        return {
            phase,
            displayedElementId: this.options.displayedElementId,
            ...values,
        };
    }

    private publish(state: LearningControlProjection): void {
        if (this.disposed) return;
        this.state = state;
        this.options.publish(state);
    }

    private isActive(operation: TopicLearningOperation, generation: number): boolean {
        return !this.disposed && !operation.isCancelled && generation === this.generation;
    }
}
