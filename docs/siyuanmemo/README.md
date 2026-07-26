# SiYuanMemo Design Documents

Date: 2026-07-19
Updated: 2026-07-24

## Reading Order

1. `0013-delivery-roadmap.md`: authoritative Feature order, delivery vocabulary, current status, and milestone gates.
2. `0009-confirmed-design-baseline.md`: compact inventory of confirmed decisions and unresolved items.
3. `0010-deep-module-interface-design.md`: authoritative Learning Engine, Scheduler, Session, Ledger, query, transport, and Adapter Interface design.
4. `0008-element-storage-sync-recovery-design.md`: authoritative storage, dual-tree, sync, conflict, history, and recovery design.
5. `0002-learning-engine-design.md`: Element domain and Learning Engine workflows.
6. `0003-spaced-repetition-scheduler-core.md`: queues, ReviewTarget, algorithm adapters, FSRS, and arena.
7. `0004-topic-reader-html-editor-design.md`: always-editable HTML Topic surface, TinyMCE adapter, selection, read point, and context menu.
8. `0005-topic-ui-integration-design.md`: SiYuan shell integration, docks, tabs, Browser, learning controls, references, and backlinks.
9. `0006-element-browser-and-learning-gap-audit.md`: complete Product v1 capability coverage and deferred command inventory, not the next-Feature acceptance list.
10. `0007-mvp-implementation-decisions.md`: first implementation defaults and placement.
11. `0011-browser-order-and-learning-plan-design.md`: working Browser and learning-order proposal, not an implementation authority.
12. `0012-deferred-arena-and-checkpoint-research.md`: deferred algorithm and checkpoint research.
13. `0001-fork-strategy.md`: fork and upstream strategy.

## Precedence

Later confirmed decisions supersede older drafts. In particular, `0013` alone decides delivery sequence and milestone gates, `0008` replaces every older one-Element/multi-file storage example, `0009` records the current cross-document baseline, and `0010` replaces older method-per-action internal Interface inventories. `0013` does not supersede those documents' behavioral or architectural decisions. Older MVP and build-order lists describe the complete Product v1 boundary unless the current Feature specification explicitly adopts a narrower part.

HTML prototypes under local references are interaction previews, not architecture authorities. When a prototype conflicts with `0008` or `0009`, the design documents win and the prototype remains stale until it is explicitly updated.

Private research inventories, local reference paths, and source-specific investigation notes must not be added to this public directory. They belong only in ignored local directories.
