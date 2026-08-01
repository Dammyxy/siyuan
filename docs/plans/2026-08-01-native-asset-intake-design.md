# Native Asset Intake Design

Date: 2026-08-01

Status: Validated design for Feature 009; implementation not started.

## Outcome And Scope

Feature 009 adds local image intake to both supported HTML Topics and both sides of an Item. A learner can paste a screenshot, drop an image, or choose local image files while authoring. Topic and Item editors insert uploaded images at the current caret position. Each side accepts multiple images and preserves their insertion order.

The feature reuses SiYuan's native asset behavior: validation, naming, hash deduplication, upload progress and errors, and shared `workspace/data/assets/` storage. Authoritative `.sme` material stores only normalized `assets/...` references. The feature does not add an asset manager, remote-image batch download, broad media support, image crop/rotate/filter tools, export rewriting, or complete synchronization integration.

HTML Topics continue to use TinyMCE. Item prompt and answer become versioned, restricted HTML material so images can appear between text nodes. Item authoring and review remain separate surfaces. Learning controls and the Learning Session remain unchanged, and answer material is never returned or mounted before reveal.

## Decisions

### Reuse SiYuan's Asset Path

Topic and Item use one narrow `AssetStore` adapter. Paste, drag/drop, and the image toolbar file picker all enter the same native upload path. The adapter delegates file type and size checks, naming, deduplication, and storage to SiYuan; it does not write assets directly or maintain a parallel registry.

Upload is immediate. The editor captures the current selection, uploads the files, and inserts the returned `assets/...` references only after success. Upload failure leaves the HTML unchanged. When multiple files are selected, the adapter maps the response back to the original file order rather than relying on object-key order.

No temporary Base64 or local filesystem path is persisted. No crop, rotate, filter, or image-size editing is introduced. Image deletion is ordinary editor deletion and does not synchronously delete the shared asset.

### Restricted HTML Material

Topic and Item share the existing versioned HTML cleaning policy. The cleaner accepts the established safe structure and image attributes, normalizes asset references, and rejects traversal, absolute paths, `file:` URLs, and final `data:`/Base64 URLs. The same policy runs before a non-empty Topic or Item material value becomes `.sme` authority.

Legacy Item plain text is migrated by escaping text and converting lines to paragraphs, preserving blank lines and visible text semantics. Prompt and answer HTML are independent material values within the Item content payload. Review rendering receives the prompt alone in the question phase and the answer only after the explicit reveal transition.

### Save, Concurrency, And Cleanup

Asset upload and Topic/Item material save remain separate operations, matching SiYuan. A successfully uploaded image may temporarily be unreferenced if the subsequent `.sme` save fails; Feature 009 does not add an upload/save transaction or rollback. The next native unused-asset scan must rescan authoritative `.sy` and `.sme` references before deletion.

SiYuan provides transaction queue serialization, file locking, atomic tree writes, history, and repository-level conflict handling for `.sy`. `.sme` keeps the existing `expectedTitleRevision`, `expectedMaterialRevision`, and `expectedContentRevision` compare-and-swap guards because it stores whole HTML or Q/A payloads rather than Block operations. A stale save is rejected without silent overwrite; the editor retains local content and follows the existing conflict/retry/reload flow. No separate resource concurrency model is added.

## Components And Data Flow

`AssetStore` imports local files and returns ordered normalized references. The Topic editor adapter and Item HTML authoring surface own caret capture, insertion, dirty state, and normal save scheduling. They do not know scheduler, ledger, or learning-session details. The existing Topic and Item save commands remain responsible for cleaning and committing material with their current revision contracts.

The upload path is: capture selection -> validate through native rules -> upload to shared assets -> map successful files to original order -> insert `<img src="assets/...">` at the captured selection -> mark the material dirty -> submit the existing save command. A closed editor follows SiYuan's upload lifecycle; no temporary draft store is introduced.

The cleanup path is: enumerate shared assets -> collect references from `.sy` and authoritative `.sme` payloads -> recheck the reference set immediately before removal -> preserve every referenced asset. Asset cleanup remains a native concern; SiYuanMemo only supplies the `.sme` references through the existing adapter boundary.

## Failure And Recovery

Invalid files and native upload failures leave the editor content unchanged and present the native error. A material save failure keeps the editor open with local HTML and allows the existing retry behavior. A revision conflict prevents silent overwrite, preserves local content, and requires the established conflict resolution path before closing or replacing the surface. No uploaded asset is deleted as an automatic rollback.

If an asset is removed outside the editor before a material save, the saved `assets/...` reference remains authoritative and renders through the normal missing-resource state; Feature 009 does not add a resource repair workflow. If native cleanup runs after upload but before save, the behavior follows SiYuan's separate upload/save boundary; an unreferenced file is eligible for a later scan, while a committed `.sme` reference protects it on the next scan.

## Testing Boundary

Unit tests cover native-rule delegation, upload failure, duplicate assets, multi-file ordering, caret insertion, restricted HTML cleaning, path traversal and forbidden URL schemes, legacy text migration, and answer redaction. Surface tests cover paste, drop, file picker, deletion, repeated edits, close during upload, save failure, and revision conflict for Topic and both Item sides.

Integration tests cover `.sme` persistence, restart rendering, prompt-only question state, answer reveal, and unused-asset discovery across `.sy` and `.sme`. Scope inspection must find no scheduler, ledger, algorithm adapter, runtime, Protyle, generic layout, dependency, lockfile, webpack, kernel/application build, asset manager, remote downloader, or unrelated lifecycle feature changes.

## Alternatives Rejected

An independent attachment list was rejected because it prevents images from appearing at arbitrary positions and would force a later migration to the already-confirmed Item HTML editor architecture. Textual image tokens were rejected because they introduce a new parser and editing format. A full copy of Protyle's Block operation model was rejected because `.sme` stores whole payloads; implementing operation logs and merges would expand Feature 009 into a new editor and synchronization system.
