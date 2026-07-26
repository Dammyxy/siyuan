# Topic Learning Alpha Design

Date: 2026-07-26

## Outcome And Scope

Feature 007 connects the already implemented default Learning Session and Topic Scheduler path to the native Element tab. The learner starts Learn from an opened supported HTML Topic, the current reusable Element tab follows the session's Active Learning Target, and `Next` accepts one real Topic Repetition before the tab advances. The accepted schedule remains authoritative after restart because the existing Learning Engine commits it to monthly review authority before session advancement.

The current dogfood collection contains Topics and no Items. Feature 007 therefore validates a Topic-only population without adding Item prompt, answer, grade, or Final Drill presentation. The existing mixed-target backend remains unchanged. If unexpected non-Topic or confirmation state is encountered, the Alpha fails closed, reveals no Item material, and allows the learner to end the local session. It does not add a Topic-only Scheduler branch, Browser Workset, skip action, or subset semantics.

Feature 007 also preserves the Feature 006 editor decision. HTML-backed Topics remain in the same always-editable TinyMCE Surface during browsing and learning. Future Block-backed Topics will use the native SiYuan editor through a different content Surface, while the learning controls and Learning Session remain stable around either editor.

## Approaches Considered

### Chosen: Session Coordination Outside The Content Surface

The native Element tab owns a stable learning-control region outside the content Surface. A small frontend learning Module decodes the existing session transport, starts or refreshes the one workspace Learning Session, submits `Next` with a stable action identity, and projects the returned session state into the tab. `ContentSurfaceHost`, `TopicHtmlSurface`, and `TinyMceTopicEditorAdapter` keep their existing responsibilities and do not learn about queues, schedules, event identities, or target advancement.

This approach has the deepest useful interface. The caller asks to start, return to, advance, or stop Topic learning; the Module hides transport decoding, duplicate-safe retry, accepted-action recovery, target matching, and tab navigation. The interface is also the test surface.

### Rejected: Put Learn And Next Inside TopicHtmlSurface

This would be locally convenient because the Surface already renders Topic controls, but it would make TinyMCE-adjacent code understand Learning Session phases and scheduling results. Replacing TinyMCE or mounting a future Block-backed Topic Surface would then require learning workflow changes. The deletion test shows that the coupling would spread across every future content Surface.

### Rejected: Add A Topic-Only Backend Session

Filtering the existing default Learning Session to Topics would introduce a new plan or Workset policy solely to avoid future Item targets. That would duplicate existing session behavior and pull subset-like semantics into Feature 007. The current collection has no Items, so this complexity closes no present user-visible gap.

## Modules, Interfaces, And Seams

The Learning Engine remains the deep kernel Module. Existing named routes are transport Adapters over `RunLearningAction(Start)`, `RunLearningAction(NextTopic)`, `RunLearningAction(Stop)`, and `Query(GetCurrentLearningSession)`. `LearningSession` remains concrete and owns the Active Learning Target, phase, target advancement, and local cursor. Scheduler continues to own Topic eligibility and `topic-afactor-v1` application. `SchedulingLedger` remains the only owner of durable event acceptance, causal adoption, and projection publication.

The frontend gains one learning Module with a small behavior-oriented interface. Its implementation may use named transport methods, but callers do not assemble session actions or interpret raw envelopes. The frontend transport Adapter validates the complete session/result shape and preserves typed failure facts such as whether a Topic Repetition was accepted and which action identity must be reused.

`ElementTab` becomes a stable shell with separate content and learning-control regions. `ContentSurfaceHost` mounts only into the content region, so content replacement cannot erase the controls. The existing `ElementContentSurface` interface stays unchanged. The editor Adapter keeps only editing operations; no learning method is added to it. This is a real seam because HTML Topic, future Block-backed Topic, Item, and future media Surfaces vary while learning controls remain common.

Native tab replacement continues through `openElement` and the existing guarded host lifecycle. Feature 007 does not invent an in-place mutable Element identity or a separate review tab.

## Workflow And Data Flow

When an Element tab becomes active, the learning Module reads the current Learning Session. If there is no active matching target, the tab shows `Learn`. Starting Learn first prepares the current Surface for a possible target change. A blocked save or unresolved revision conflict prevents session navigation. The Module then starts or returns the existing workspace session. If it returns an Active Learning Target, the current reusable tab opens that Element through native tab rules. If the displayed Topic is already that target, the control changes to `Next` without remounting a different editor.

`Next` is available only when the displayed supported Topic is the session's Active Learning Target in the question phase. Before submitting it, the tab flushes pending title and material saves. The Module creates one stable action identity for that user intent and retains it until the outcome is reconciled. The kernel accepts the Topic Repetition through the existing `NextTopic` path, publishes the updated scheduling projection, advances the Learning Session, and returns the new session state.

Only after acceptance does the frontend follow the returned target. If the session has another Topic, the current reusable tab opens it. If the session completes, the current Topic remains visible and the control returns to `Learn` with completion feedback. Manually opening another Topic during an active session creates a Previewed Element; it shows `Learn`, and activating it returns to the session's Active Learning Target without scheduling the preview.

## Failure And Recovery

A pre-acceptance save failure or authoring conflict prevents Start or Next and leaves the complete editor state available. A pre-acceptance learning failure leaves the same Active Learning Target visible and retains the action identity for a safe retry. Repeated clicks are serialized so one user intent cannot create multiple Topic Repetitions.

If the kernel reports that the Repetition was accepted but projection refresh failed, the UI states that the review was saved, submits no new action identity, and waits for host-owned Runtime recovery. If event acceptance succeeded but queue advancement failed, retry uses the same action identity so the existing event advances exactly once without duplication. If the kernel accepted and advanced but the next Element tab could not be presented, the session remains authoritative; the learner can use Learn to re-read the current session and return to its Active Learning Target.

Session state is disposable and local. Restart does not restore a synchronized cursor. Instead, the next Start rebuilds the default due population from `.sme`, complete `.smr`, and scheduler configuration. A Topic successfully processed on the current Learning Day is excluded after restart, and its next due Learning Day remains derived from the accepted Topic event.

## Domain Model

The design adds three glossary terms to `CONTEXT.md`: Learning Session, Active Learning Target, and Previewed Element. These terms separate learning authority from ordinary navigation. An opened Topic is not automatically an Active Learning Target, and a Previewed Element cannot receive `Next`.

No ADR is needed. The hard-to-reverse editor and Engine seams were already confirmed in the design baseline; Feature 007 applies them without choosing a new durable architecture.

## Testing Boundary

Acceptance uses a collection containing supported HTML Topics and no Items. Tests cover idle, active matching Topic, active preview, completed, no-due, blocked authoring, pre-acceptance failure, accepted projection failure, accepted queue-advance failure, response loss, repeated click, restart, same-day exclusion, and native current-tab presentation failure. Every accepted `Next` must create exactly one authoritative Topic event and preserve Topic material, title, tree placement, processing state, and editor replaceability.

Scope inspection must find no Item answer or grade UI, Final Drill execution, Browser, Workset, extraction, split, Read Point, lifecycle command, schedule chip, new queue policy, new Engine family, new public route, or editor-specific learning dependency.
