# Keep Remedial Practice SuperMemo-Aligned Across Algorithms

Status: accepted

SiYuanMemo keeps one SuperMemo-aligned practice flow regardless of the selected Item scheduling algorithm. A formal Grade updates the chosen Algorithm Adapter and advances the ordinary Learning Session; FSRS `Again` is an internal rating mapping and does not imply immediate queue re-entry. Same-day automatic return belongs only to the separate, schedule-neutral Final Drill. Anki-style learning and Relearning steps remain a possible future practice policy that must be designed independently from algorithm selection.

## Considered Options

- Let each Algorithm Adapter choose queue behavior. Rejected because changing algorithms would also change Learning Session semantics and would let Adapter implementations own scheduling workflow.
- Add selectable SuperMemo and Anki practice modes now. Deferred because it requires short-delay queue authority, interruption recovery, configuration, and testing beyond Item Alpha.

## Consequences

- Algorithm Adapters remain deterministic candidate calculators and cannot requeue targets.
- Formal grades and Drill Grades remain distinct facts with different scheduling effects.
- A future Relearning policy can be added at the Learning Session practice-policy seam without changing Item content Surfaces or raw grade history.
