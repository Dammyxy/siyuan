# SiYuanMemo Delivery Roadmap

Date: 2026-08-01

## Decision And Authority

This document is the sole authority for delivery sequence, milestone names, and the minimum user-visible gate for each Feature. It answers what SiYuanMemo builds next. It does not replace the product, storage, Scheduler, Learning Engine, or UI architecture in the other design documents.

When documents appear to conflict, use this precedence:

1. This roadmap decides Feature order and whether a capability may block the current milestone.
2. The current Feature's validated `spec.md`, `plan.md`, contracts, and `tasks.md` decide its authorized implementation scope.
3. `0009-confirmed-design-baseline.md`, `0010-deep-module-interface-design.md`, and `0008-element-storage-sync-recovery-design.md` decide confirmed behavior and architecture in their respective domains.
4. Older build-order and MVP lists are complete-product capability inventories, not permission to add those capabilities to the current Feature.

A Feature specification may narrow its milestone but may not pull a deferred capability forward merely because an older design calls it part of the MVP. Pulling work forward requires an explicit roadmap amendment and the smallest dependency slice that closes the milestone gate.

## Delivery Vocabulary

- **Engine Foundation** means Features 001 through 004. These backend tracers establish trustworthy Element, storage, scheduling, daily-learning, and HTML Topic creation authority, but they are not yet a production user workflow.
- **Dogfood Alpha** means Features 005 through 008. It is the shortest sequence that lets one learner use SiYuanMemo inside the native SiYuan desktop shell for Topic capture, Topic learning, and basic Item review.
- **Product v1** means the complete product boundary historically called the MVP in documents `0005`, `0006`, `0007`, and `0009`. It includes broader progressive-reading, Browser, note-integration, lifecycle, and required structural workflows. In those older documents, an unqualified MVP requirement must be read as a Product v1 requirement unless a Feature specification explicitly adopts it.

Dogfood Alpha is a delivery checkpoint, not a replacement product architecture. Product v1 capabilities remain required unless a later confirmed decision removes them.

## Current Delivery Sequence

| Feature | Milestone | Minimum user-visible gate | Status on 2026-08-01 |
|---|---|---|---|
| 001 | Item Learning Core | A prepared Item can complete a durable Start, Show Answer, and Grade loop through the backend. | Complete |
| 002 | Element Storage And Read-Only Tree | Authoritative dual-tree Elements and scheduling history can be read, rebuilt, and recovered without making the disposable index authoritative. | Complete |
| 003 | Daily Learning Loop | Learning Day, Outstanding, Pending, Final Drill, Topic `Next`, and Item grading work through the backend learning session. | Complete |
| 004 | Create HTML Topic Tracer | A caller can create a safe HTML-backed Topic through the versioned cleaning and storage path. | Complete |
| 005 | Native Read Alpha | A learner can activate the native Elements dock, navigate the complete Engine-provided tree, and read a supported HTML Topic in a native Element tab. | Complete |
| 006 | Capture/Edit Alpha | A learner can immediately create an empty HTML Topic, edit it in the real Topic editor, automatically save it, and use normal paste, paste as plain text, and paste as HTML from the editor component context menu. | Complete |
| 007 | Topic Learning Alpha | A learner can start a real Topic learning session in the native UI and advance Topics with `Next`, with accepted scheduling truth surviving restart through the existing Engine. | Complete |
| 008 | Item Alpha | A learner can create a basic manual Q/A Item and complete its prompt, Show Answer, and raw grade `0..5` review in the native UI. | Complete |
| 009 | Native Asset Intake | A learner can paste a screenshot, drop an image, or choose a local image while authoring an HTML Topic or either side of an Item, retain only SiYuan-managed `assets/...` references in `.sme` authority, and keep referenced assets out of native unused-asset cleanup. | Complete |

Features 005 through 008 are complete, including the source-bound Feature 007 and Feature 008 desktop acceptance matrices. Dogfood Alpha is complete. Feature 009 is the first post-Alpha dependency and adds only the shared-asset behavior required for safe local image capture in HTML Topics and Items.

## Hard Scope Gates

### Feature 005: Native Read Alpha

Feature 005 is complete when the production desktop shell can show and restore one native Elements dock and native read-only Element tabs, including supported Topic rendering and recoverable loading, empty, unsupported, missing, and failure states. It contains no creation, editing, paste, learning, Item answer, Browser, search, lifecycle, read-point, note-integration, or structural commands.

### Feature 006: Capture/Edit Alpha

Feature 006 adds the smallest complete Topic authoring loop: immediately create a real unbound top-level Topic together with its initial remembered Topic schedule, edit its SiYuan-style title and rendered HTML material, automatically save both, and use the three editor-owned paste modes. Empty stored title and empty authoritative HTML are valid, the localized `Untitled` label remains presentation only, and leaving an empty Topic never auto-deletes it. Later title or body edits do not reinitialize scheduling. The minimum `RenameElement` capability is pulled into Feature 006 only for the opened Topic title; broader tree rename workflows remain deferred. Title and material use independent conflict revisions, preserve one another during whole-root writes, and create no scheduling event. The paste modes differ only in how clipboard input enters the editor; every non-empty saved HTML result uses the confirmed versioned cleaning and `SaveTopicHTML` path before it becomes Element authority, while canonical empty HTML remains a valid normalized state. HTML Topics use one always-editable TinyMCE surface during browsing, learning, and layout restoration, with no read/edit switch or persisted mode. Normal close paths flush pending saves and remain open on save failure or revision conflict. SuperMemo defines the learning semantics, while current SiYuan code is the implementation authority for title editing, transactions, tabs, menus, close behavior, themes, shortcuts, and error presentation. The Feature introduces no frontend-only draft, standalone paste area, parallel SiYuanMemo editor settings, or temporary HTML recovery store.

### Feature 007: Topic Learning Alpha

Feature 007 connects the existing Learning Session and Topic Scheduler path to the native Topic surface. Its gate is one real, repeatable Topic Learn/Next workflow, including durable accepted actions and recoverable UI failure behavior. It does not require Item review, Element Browser, subset learning, backlinks, block conversion, SendToNote, durable read points, extraction, split, or the complete lifecycle command set.

### Feature 008: Item Alpha

Feature 008 adds the smallest complete Item loop: basic manual Q/A creation, prompt rendering, answer reveal, and grades `0..5` through the existing Item scheduling path. It continues the confirmed storage model rather than copying SiYuan's document AST: one stable Element envelope owns a versioned type-specific Q/A payload in `.sme`, while accepted grades remain immutable `.smr` authority and disposable session/projection state remains outside `.sme`. The Item content Surface and learning controls meet through stable interfaces so later editors can be replaced without changing scheduling or storage semantics. Rich Item forms, advanced creation tools, Browser workflows, block conversion, extraction, and broad lifecycle controls remain Product v1 work unless a separate validated dependency requires a smaller slice.

### Feature 009: Native Asset Intake

Feature 009 adds the smallest safe `AssetStore` slice. Screenshot paste, image drop, and local image selection reuse SiYuan's native asset import, naming, validation, and shared `workspace/data/assets/` storage, then persist only normalized `assets/...` references in Topic HTML and Item question/answer material. Asset resolution rejects traversal and unsupported local schemes. SiYuan's unused-asset discovery and cleanup must count references from authoritative `.sme` payloads before the workflow is accepted, so a native cleanup cannot delete a still-referenced SiYuanMemo asset.

The validated Feature 009 design uses restricted HTML prompt/answer material for Item images, with multiple ordered images at arbitrary text positions. It reuses SiYuan's native upload, validation, naming, deduplication, shared asset storage, and cleanup behavior while retaining the existing `.sme` compare-and-swap guard for whole-payload saves. Feature 009 does not add an asset registry UI, remote-image batch download, broad media support, general Item formatting unrelated to image placement, export rewriting, or complete reference and synchronization integration. Those remain focused Product v1 work.

## Work That Must Not Block Feature 007

The following confirmed Product v1 capabilities remain deferred until after the Topic Learn/Next dogfood gate:

- Element Browser views, filtering, saved subsets, subset learning, row synchronization, and Browser-specific ordering;
- Element backlinks, Inspector, Context dock, SendToNote, and native block-to-Element conversion;
- durable Read Point, selection extraction, split, richer Topic tools, and automatic material processing;
- Remember, Forget, Dismiss, Postpone, Reschedule, Done, and the complete lifecycle command surface;
- broader tree rename, move, promotion, demotion, mixed-tree structural editing, and their multi-source recovery workflows; Feature 006 includes only the current opened Topic's title rename, while drag/drop remains optional beyond Product v1 unless a later decision pulls it forward;
- complete SiYuan synchronization hooks and broader asset/reference integration beyond the authority already required by Features 001 through 004.

No deferred command appears as a disabled placeholder. A later Feature owns both its Engine action and its complete user workflow.

## Post-Alpha Capability Tracks

After Feature 008, subsequent Features proceed through these Product v1 tracks in dependency order rather than copying an older numbered build list:

1. **Native Asset Intake (Feature 009)**: local image import for HTML Topics and both Item sides, plus the minimum `.sme` reference awareness required to keep shared assets safe.
2. **Progressive Reading**: durable Read Point, selection extraction, child Topic split, richer Topic tools, and the processing workflow.
3. **SiYuan Integration**: explicit block-to-Topic/Item commands, SendToNote, Element references and backlinks, plus the remaining asset and synchronization integration.
4. **Browser And Lifecycle**: Element Browser views, Workset/subset learning, Inspector/Context, priority and ordering controls, and complete lifecycle actions.
5. **Structural Editing**: rename, move, mixed sibling ordering, root/internal promotion or demotion, history snapshots, and recovery. Drag/drop remains a later enhancement unless a focused Feature explicitly adopts it.

This track order is provisional after Feature 008. Before starting each track, use current code and user workflow evidence to create a focused Feature specification. Product v1 acceptance remains the complete capability boundary recorded in `0006-element-browser-and-learning-gap-audit.md`, not the acceptance gate for any one Dogfood Alpha Feature.

## Roadmap Maintenance

- Update the status table when a Feature is accepted or a new Feature is specified.
- Give each Feature one independently testable user-visible gate and exclude unrelated complete-product controls.
- Treat a backend tracer, Dogfood Alpha, and Product v1 as different checkpoints in plans, reviews, and handoffs.
- Do not declare a milestone complete because its backend exists; the stated native user workflow must pass.
- Do not expand a Feature to satisfy a broad older MVP list. Record remaining Product v1 work here and assign it to a later focused specification.
