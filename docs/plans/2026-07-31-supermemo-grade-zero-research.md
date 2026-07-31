# SuperMemo Grade 0 Research

Date: 2026-07-31

## Decision Summary

For SiyuanMemo Item Alpha, the SuperMemo-compatible grading surface should expose five grades in descending order:

```text
5  4  3  2  1
```

Grade `0` remains a real schedulable grade, but is omitted from the standard visible grade panel and issued with the `0` keyboard shortcut. It is not a separate "restart" or "reset item" command.

SuperMemo's standard learning flow also does not have Anki's mandatory immediate `Again` loop. A failed scheduled repetition updates the persistent post-lapse schedule, normally to an interval measured in days. The built-in automatic same-day return path is the separate, optional **Final Drill** stage. Final Drill is broader than Anki relearning: it takes every Item graded below Good (`0..3`), including a difficult but successful Pass (`3`), and its drill grades do not change the persistent schedule.

The intended semantics are:

| Grade | SuperMemo name | Meaning | Recall class |
| --- | --- | --- | --- |
| `5` | Great / Bright | Excellent response | Remembered |
| `4` | Good | Correct, with some hesitation | Remembered |
| `3` | Pass | Recalled with difficulty; possibly slightly incorrect | Remembered |
| `2` | Fail | Incorrect, but evokes "I knew it" | Forgotten |
| `1` | Bad | Incorrect; correct answer still feels familiar | Forgotten |
| `0` | Null | Complete blackout; no recollection of ever knowing it | Forgotten |

Sources: the current first-party SuperMemo help page defines the six grades and the `3/2` remembering-forgetting boundary; it also states that `0` is rarely needed, is not displayed on the standard grade panel, and must be issued from the keyboard [1]. The official glossary likewise defines grade as `0..5` and says Null can be issued from the keyboard after a dismal response [2].

## Answers To The Research Questions

### 1. Is grade 0 "start over"?

No. Grade `0` is **Null**, the strongest expression of failed recall: "complete blackout; you do not even recall ever knowing the answer" [1]. It is a grade attached to an actual repetition, not an administrative command that deletes history, makes an element Pending, or restarts learning from scratch.

In an ordinary scheduled repetition, all grades below `3` are failures. Official SuperMemo help says an Item graded below Pass is considered forgotten and its next interval drops to a few days [3]. Algorithm SM-17 describes this as a memory lapse: a failing grade moves the Item to post-lapse scheduling, whose first post-lapse interval is derived from `PLS[Lapses,R]`; typical post-lapse intervals are about 1-4 days at a 10% forgetting index [4].

Therefore, `0` means "the recall failure was total," not "show this card again immediately." In the standard Learn workflow, automatic same-day repetition, when enabled, belongs to Final Drill rather than to the long-term scheduling meaning of grade `0`. SuperMemo also has manual review and forced-repetition commands, but those are user-invoked review tools, not an automatic `Again` state transition.

### 2. How is grade 0 issued, and is it hidden?

The current first-party help is explicit:

- The standard visible grade panel omits Null `0`.
- The user issues Null by pressing the `0` key.
- The rationale given by SuperMemo is that a correctly maintained learning process should rarely or never require Null [1].

The source does not describe a pointer-accessible overflow menu for `0`. The evidence supports a keyboard-only Alpha implementation, while the internal grade command and persisted event must still accept raw grade `0`.

### 3. Is the visible order 5, 4, 3, 2, 1?

The current first-party help enumerates grades from best to worst (`5` through `0`) and explicitly removes only `0` from the standard panel [1]. This yields the five visible grades `5, 4, 3, 2, 1`, matching the user's SuperMemo observation.

Evidence for the **visible set** is strong. Evidence for the exact current left-to-right pixel order is medium: the accessible first-party page contains the rule and descending enumeration but no current screenshot of the grade panel. A historical SuperMemo screenshot independently shows the buttons ordered best-to-worst (`Bright, Good, Pass, Fail, Bad, Null`), but it is a secondary tutorial capture and is only corroborative [7]. SiyuanMemo can therefore freeze `5 4 3 2 1` as an intentional SuperMemo-compatible design without claiming a pixel-perfect copy of a specific current release.

### 4. How does grade 0 relate to failure, scheduling, and Final Drill?

#### Main learning and scheduling

- Grades `3..5` mean remembered; grades `0..2` mean forgotten [1][5].
- A failing grade records a lapse and selects a post-lapse interval instead of continuing the successful stability-increase path [4].
- Grade `0` is therefore in the same scheduling class as `1` and `2` for the pass/fail boundary, while still retaining its raw value as the strongest failure signal.
- This is not an immediate in-session "Again" learning step in the Anki sense. SuperMemo's long-term next interval after a lapse is normally measured in days, not minutes [4].

#### Final Drill membership

- Every Item scoring below Good (`0..3`) enters Final Drill [2][5].
- The Item remains in Final Drill until it scores Good (`4`) or Great/Bright (`5`) [5].
- Consequently, a `0` in Final Drill keeps the Item in the drill queue, just like `1`, `2`, or `3`.

#### Final Drill scheduling neutrality

The first-party SuperMemo learning FAQ explicitly states that grades issued during Final Drill do not affect the learning process and are used only to eliminate Items from the drill queue [6]. In combination with the current definition of Final Drill as a same-day queue [2][5], the supported interpretation is:

- the ordinary repetition grade drives the persistent lapse/schedule update;
- Final Drill grades only determine whether the Item remains in or exits that drill;
- a Final Drill `0` must not create another long-term scheduling mutation.

This distinction matters for SiyuanMemo: Final Drill, when implemented in a later feature, should use drill-local grade handling rather than call the ordinary persistent `GradeItem` path again.

## Does SuperMemo Have Anki-Style Again/Relearning?

### Short answer

No, not in the standard automatic learning path.

SuperMemo separates two jobs that Anki commonly combines after `Again`:

1. the ordinary repetition grade updates long-term memory state and selects the next persistent interval;
2. Final Drill optionally gives the learner extra same-day practice without applying another scheduling mutation.

Calling Final Drill "SuperMemo's Again" is useful as a rough UI analogy, but it is not an exact domain equivalence. Final Drill is optional, delayed until the last stage of the learning day, includes grade `3` as well as failures, and can be deleted without undoing the already-recorded scheduled repetition [2][6][8].

### Workflow distinctions

| Workflow | What happens after a difficult or failed response | Persistent scheduler effect | Automatic same-session return |
| --- | --- | --- | --- |
| Memorizing a new Item | When a Pending Item is introduced through the new-material stage, it is presented once. The grade issued while memorizing only decides Final Drill membership. The algorithmic "first grade" is the grade at the first later repetition [2][6]. SuperMemo 2002 and later can also memorize newly added Items automatically, bypassing the Pending introduction stage [6]. | The memorizing grade itself does not determine the long-term schedule. The first scheduled repetition normally arrives after the startup interval; the basic help describes first repetitions as usually 3-5 days after adding material [1]. | Only through Final Drill if the memorizing grade is below Good and Final Drill is enabled [2][8]. |
| Ordinary scheduled repetition | The user gives one grade and proceeds to the next repetition. A grade below Pass is a lapse [1][2]. | A failure selects post-lapse scheduling. Algorithm SM-17 describes the first post-lapse interval as `PLS[Lapses,R]`, normally around 1-4 days at a 10% forgetting index [4]. | The Item is also added to Final Drill when its grade is below Good (`0..3`), if that queue is enabled [2][8]. It is not immediately inserted into the ordinary outstanding queue again. |
| Final Drill execution | Items below Good are repeated until they receive Good or Great/Bright (`4..5`) [2][8]. | None. Final Drill grades are only used to remove Items from the drill queue [6]. | Yes. An Item graded `0..3` remains in the drill and may return repeatedly; `4..5` removes it [2][6]. |
| Manual forced or subset review | `Execute repetition`, `Review all`, `Add to outstanding`, and related review tools can make an Item appear outside its ordinary due date [9]. | These are explicit user operations. A forced/mid-interval repetition can be recorded and interpreted by modern SuperMemo algorithms; it is not the automatic consequence of a failed grade [4][9]. | Possible only because the user explicitly requested another review. Normal review suppresses duplicate processing on the same day unless the user overrides it with `Add to outstanding` [9]. |

### Why Final Drill is not a relearning state

- **Entry threshold differs:** persistent forgetting is `0..2`, while Final Drill entry is `0..3`. A Pass is remembered for scheduling but still considered worth drilling [1][2].
- **Exit threshold differs:** Final Drill requires Good or better (`4..5`), not merely crossing the persistent pass/fail boundary at `3` [2][6].
- **Timing differs:** Final Drill is the third and last learning stage, after outstanding repetitions and optional new-material memorizing. It is not necessarily an immediate repeat after the failed Item [1][8].
- **Persistence differs:** the ordinary grade already changed the next interval; grades inside Final Drill do not change learning data [4][6].
- **Obligation differs:** Final Drill can be disabled, cut, or left unfinished. The help explicitly calls it optional and lower priority than outstanding repetitions [2][8].

The most accurate product language is therefore:

```text
failed scheduled repetition -> record lapse and compute post-lapse due date
grade below Good             -> optionally add Final Drill membership
Final Drill grade below Good -> keep in drill only
Final Drill grade 4 or 5     -> remove from drill only
```

### Comparison with Anki and FSRS

Anki's standard scheduler has explicit learning and relearning steps. For a new/learning card, `Again` returns the card to its first learning step. For an established review card, `Again` is a lapse and the card goes through configured relearning steps before becoming a review card again [10]. This commonly produces a minutes-later same-session repeat.

That behavior should not be attributed to the FSRS algorithm alone. In current Anki, learning/relearning steps are a scheduler layer around FSRS. Anki's official manual recommends keeping such steps short and few, and now allows the fields to be left empty so experimental FSRS short-term scheduling can choose the interval itself. In that configuration, an `Again` interval may be one day or longer [10]. Thus:

| Concept | SuperMemo | Anki with configured steps | Anki/FSRS with empty steps |
| --- | --- | --- | --- |
| Failure command | Raw grade `0..2` | `Again` | `Again` |
| Persistent post-failure schedule | Post-lapse interval, normally days | Computed review interval after relearning | FSRS directly selects the interval |
| Automatic remedial practice | Optional Final Drill, separate from scheduling | Relearning steps, commonly minutes | No fixed relearning steps; an interval may be sub-day, one day, or longer |
| Does remedial grade mutate long-term scheduling? | Final Drill grade: no | Relearning answers participate in Anki's card-state progression | FSRS/Anki review outcome schedules the card |

For SiyuanMemo, mapping SuperMemo grades `0..2` to FSRS's internal `Again` rating is an adapter decision, not permission to expose an Anki-style `Again` command or to recycle the Item immediately in the main learning queue.

## Implications For Feature 008

1. Replace the proposed six visible numeric controls with five visible controls ordered `5 4 3 2 1`.
2. Keep raw grade `0` valid in command validation, retry identity, immutable `.smr` events, and scheduler adapters.
3. Bind the `0` keyboard shortcut only in the Item answer phase. It must not work while the question alone is visible.
4. Do not label grade `0` as "Again", "Restart", or "Relearn". The canonical meaning is `Null / complete blackout`.
5. Treat `0..2` as lapse/failure and `3..5` as successful recall for persistent scheduling.
6. Treat `0..3` as Final Drill membership and `4..5` as Final Drill completion.
7. Feature 008 may create Final Drill membership as already scoped, but must not simulate an immediate in-session Again queue or implement Final Drill execution early.
8. The hidden grade should still be discoverable through the normal keyboard behavior and accessibility metadata; no permanent sixth visible button is required.

There is one further SuperMemo-fidelity decision for planning. The official glossary says the grade issued while memorizing new material does not affect the learning process except for deciding Final Drill membership; it distinguishes this from the algorithmic "first grade" at the first later repetition [2]. Feature 008's current model, in which the first accepted grade both introduces a Pending Item and schedules it through FSRS, is therefore not an exact copy of SuperMemo's memorizing stage. Planning should either record that as an intentional Alpha simplification or separate introduction scheduling from the initial memorizing grade.

The user's proposed rationale, making the most extreme self-assessment require a deliberate action, is compatible with the SuperMemo interaction. The official text gives a narrower first-party rationale: Null should be rare when learning is managed correctly [1]. The product rationale should be recorded as a SiyuanMemo design choice rather than attributed verbatim to SuperMemo.

## Evidence Strength And Limits

| Claim | Strength | Notes |
| --- | --- | --- |
| `0` means Null / complete blackout | High | Current first-party help and glossary agree [1][2]. |
| `0` is a failing grade, not a reset command | High | Current help, Item behavior, and algorithm documentation agree [1][3][4]. |
| `0` is hidden and issued from the keyboard | High | Stated explicitly by current first-party help [1]. |
| Visible grade set is `5..1` | High | Six-grade definition plus explicit omission of only `0` [1]. |
| Exact current left-to-right order is `5,4,3,2,1` | Medium | First-party text enumerates descending; accessible current page lacks a grade-panel screenshot. Historical UI corroborates it [7]. |
| Final Drill includes `0..3`, exits on `4..5` | High | Current glossary/help and local SuperMemopedia clipping agree [2][5]. |
| Final Drill grades are schedule-neutral | High | Explicit in the first-party learning FAQ [6]. |
| Standard SuperMemo has no mandatory Anki-style immediate relearning step | High | The first-party workflow has three stages; a lapse creates a days-scale post-lapse interval, while same-day repetition is handled by optional Final Drill [1][2][4][6][8]. |
| Final Drill is the only automatic same-day return path in the standard Learn workflow | High for the documented classical/SM17 workflow | Manual forced review, subset review, and newer neural review exist, but they are explicit review modes rather than a grade-triggered `Again` transition [8][9]. |
| Persistent scheduling differentiates `0`, `1`, and `2` beyond the common lapse branch | Not established | Official material confirms the common failure/post-lapse branch, but the inspected sources do not establish a distinct next-interval rule for each failing raw grade. Preserve the raw grade without inventing separate Alpha behavior. |

## Version And Terminology Caveats

- The static first-party SuperMemo help mirror used here was last modified in 2018 and primarily documents the SuperMemo 17/classical Learn workflow. Several FAQ answers are historically dated, but the current help pages and glossary still present them as the product model.
- The local SuperMemopedia clipping records a SuperMemo 19 Final Drill queue-order change tested between October 2024 and March 2025: the old first-come-first-served drill was replaced by dynamic shuffling. It does not change the entry threshold, exit threshold, optional status, or schedule-neutral role described above [5].
- SuperMemo has used both **Great** and **Bright** for grade `5` across versions. This naming difference does not affect the thresholds.
- "Relearning" in SuperMemo algorithm prose may describe rebuilding memory after a lapse. It is not evidence of an Anki-like `Relearning` card state or mandatory minute-scale step queue.
- A local SM-18 reconstruction resets its internal repetition-sequence counter on the failure path while also assigning a post-lapse interval [11]. That internal sequence reset can look like "start learning again" in algorithm data, but it is not an instruction to display the Item again immediately. This is corroborative reverse-engineering evidence, not a first-party behavioral specification.
- The Anki comparison is based on the official Anki manual in the local first-party source checkout at commit `f13c15aef0c94f73f6101a030f1b69772f7f3e8c` (2026-07-15). Anki behavior depends on deck configuration and version, especially whether (re)learning steps are populated.

## Sources

1. SuperMemo, **Learn**, current first-party help mirror: <https://www.super-memory.com/help/learn.htm>. Accessed 2026-07-31. Relevant sections: "Repetition cycle" and "Grades". This page links itself as the editable Wiki version and states that Null is hidden from the standard grade panel and issued by keyboard.
2. SuperMemo, **Glossary: Grade, Final drill, Post-lapse stability**, current first-party help mirror: <https://www.super-memory.com/help/g.htm>. Accessed 2026-07-31. The dedicated official Wiki page <https://help.supermemo.org/wiki/Glossary:Final_drill> was also recovered from the 2023-11-29 Common Crawl snapshot; it is Wiki revision `9917`, last edited 2019-03-03, and gives the same optional below-Good repeat-until-Good rule.
3. SuperMemo, **Items, topics, concepts, and tasks**, first-party help mirror: <https://www.super-memory.com/help/eltypes.htm>. Accessed 2026-07-31. Local clipping: `H:/project-siyuanmemo/references/supermemo/Items, topics, concepts, and tasks - SuperMemo Help.md`.
4. SuperMemo, **SuperMemo Algorithm**, current first-party help mirror: <https://super-memory.com/help/smalg.htm>. Accessed 2026-07-31. Relevant sections: "Post-lapse stability" and "Interval".
5. SuperMemopedia, **Final drill**, local clipping: `H:/project-siyuanmemo/references/supermemo/finaldrill.md`. It states that grades below Good enter the drill and only Good/Bright remove an Item.
6. SuperMemo, **FAQ: Learning with SuperMemo**, first-party help mirror: <https://www.super-memory.com/help/faq/learn.htm#Gradesinfinaldrill>. Accessed 2026-07-31. Relevant statement: Final Drill grades do not affect learning and are used only to eliminate Items from the drill queue.
7. Antimoon, **Memorizing and reviewing knowledge in SuperMemo**, historical secondary tutorial screenshot: <https://www.antimoon.com/how/usingsm-reps.htm>. Used only to corroborate the historical best-to-worst button order, not as authority for grade semantics.
8. SuperMemo, **Learn menu**, first-party help mirror: <https://www.super-memory.com/help/learnmenu.htm>. Accessed 2026-07-31. It defines the three standard learning stages, the below-Good Final Drill threshold, and the ability to skip or cut drills.
9. SuperMemo, **Subset review**, first-party help mirror: <https://www.super-memory.com/help/review.htm>. Accessed 2026-07-31. It distinguishes due learning from forced mid-interval review, suppresses ordinary duplicate same-day review, and documents explicit overrides such as `Add to outstanding`.
10. Anki, **Deck Options**, official manual: <https://docs.ankiweb.net/deck-options.html>. Local first-party source: `H:/project-siyuanmemo/references/anki/docs-site/manual/deck-options.mdx`, commit `f13c15aef0c94f73f6101a030f1b69772f7f3e8c` (2026-07-15). Relevant sections: "Learning Steps", "Lapses / Relearning Steps", and "FSRS / Learning and Relearning Steps".
11. Local reverse-engineering reconstruction, `H:/project-siyuanmemo/references/sm18-re/sm18_exact_algorithm.py`, failure path around lines 1040-1055. It increments lapses, assigns a days-scale post-lapse interval, and resets the reconstruction's `repetition` counter. Used only to explain internal terminology, not as the primary behavioral authority.
