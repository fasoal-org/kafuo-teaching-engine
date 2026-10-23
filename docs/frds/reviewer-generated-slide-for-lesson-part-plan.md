# Reviewer-Generated Slide for an Uncovered Lesson Part — Plan (v3.2, as implemented)

| Attribute | Value |
|---|---|
| Revision | v3.2, 2026-10-23. It resolves the v3.1 re-review findings V3.1-1 and V3.1-2 (top of `reviewer-generated-slide-for-lesson-part-plan-review.md`) and records the as-built deltas of the implementation. v3.1 finalized v3 for V3-1/V3-2; v3 amended v2 for V2-1..V2-3; v2 replaced v1 (2026-10-20) for R1–R9. All earlier corrections are kept |
| Branch | Implemented on `codex/reviewer-generated-slide-for-lesson-part`, branched from `origin/staging` at `eae05f4c` (the owner authorized a feature branch for this task). v1 was written at `269cc52a` |
| Repos | OpenMAIC only. No backend, admin or mobile contract change (§3.9) |
| Status | **Implemented W0–W5; focused tests pass; not runtime-verified.** The disposable-PostgreSQL race suite and every acceptance check A-1..A-28 are pending (§21, §25). The implementation report is `reviewer-generated-slide-for-lesson-part-implementation-report.md` |
| Evidence | Source at `eae05f4c` plus the implementation commits on the branch |
| Builds on | `single-slide-regeneration-plan.md` (v3) and `scene-narration-audio-regeneration-plan.md` |

**Markers:**
- **[V-code]** — verified by reading the cited code at `eae05f4c`.
- **[UNVERIFIED]** — not established by source reading. The named check (§18/§20) must prove it.
- **[DECIDED]** — closed with the recommended option; the owner can object (§4).
- **[BEHAVIOUR]** — changes an existing feature's behaviour; needs the owner's explicit yes (§4.1).

## What changed from v3.1 (v3.2 — resolutions and as-built deltas)

| Finding / delta | Change | Sections |
|---|---|---|
| V3.1-1 (Major) — server-deleted Scenes in the local-wins merge | The merge runs over the **union** of local and server Scene ids, classified with the baseline's id set (§5.1 step 9, merge table). A locally **dirty** Scene absent from the server is **kept**, with its pending entry and its **old** expected revision, so the next save meets the existing `409` and its notice; its binding is never removed (no silent re-creation). A **clean** Scene absent from the server is removed, and its binding with it. Structure dirt keeps the local list; a Scene deleted here stays deleted, one created elsewhere is not adopted. Merge bindings are always per Scene (`setSceneRev`), never `bindStageSceneRevs` | §5.1 API 9, step 9, recovery invariants, A-27, A-28 |
| V3.1-1 (as built) — how "only the insertion touched it" is decided | **Revision lineage instead of byte comparison.** T2 records, for every Scene its write rewrote, `{ before, after }` revisions (`scene_rev_transitions`); the client binds a dirty Scene's new revision only when its bound revision at the baseline equals `before` and the fetched revision equals `after`. Storage may legitimately normalize stored bytes (lineage carry-forward, PBL stripping, migration), so a content comparison against the local copy could fail spuriously and turn a local edit into a needless `409` that replaces it | §5.1 API 9, §11.1, §11.4, §15 |
| V3.1-2 (Minor) — navigation departure writes | **Policy chosen: the no-write invariant is scoped to the insertion handle while it is current.** `setStage` claims a new load token **before** its departing-Stage `persistDirtySnapshot`, so by the time a departure write starts the handle is already not current and its late result is discarded as `'stale'`. The departure write keeps its existing semantics (attempted, retried once, a revision conflict logged and dropped — navigation is not a durability barrier); T2's sandwich and fence (before the commit) and the revision preconditions (after it) guard what it touches. The same scoping covers the other writers outside the scheduler and `saveToStorage` (media-reference persistence, stage rename, delete/restore) | §5.1 invariants, F61, §25, A-27 |
| F61 count | Three `saveToStorage` callers are fire-and-forget (`setGenerationComplete`, the `loadFromStorage` self-heal, server-restore hydration); `app/generation-preview/page.tsx` awaits. The four callers are **not** claimed to be every document writer | F61, §25 |
| As built — API | The POST body is `{ insertion: Status, replayed }`; the two status GETs return `Status` itself, where `Status = { insertionId, status, errorCode, newSceneId, resultSceneRev, scene, revTransitions, requestedAt, completedAt, leaseRemainingMs }`. The content-units read also returns `positions` (one per gap, with `allowedStages`) and `stages` (labels), and per-unit `suggestedPosition`; `lineageStatus` uses the persistence values (`own_attempt` / `predecessor_attempt` / `unavailable`) | §8.3, §15 |
| As built — client run deadline (reviews 3–4) | *Superseded by the network-hold fix below.* POST retries and polling shared one wall-clock deadline, extended to the server-reported lease plus grace | §5.1 step 8 |
| Network-hold fix (post-implementation review, Findings 1–2) | A server-enforced admission deadline (`admitBy` from the gate's `serverNow`, checked in T1 after the Stage lock with a post-lock clock; service clamp arrival + 5 min; new `409 INSERTION_ADMISSION_CLOSED`); the by-key read under `stage_meta FOR SHARE` with `serverNow` on its 404; T2's lease re-checked in `'after'`; the client's retry budget separated from its safe release (window + longest lease + grace, monotonic); bodies read and validated inside each attempt. After the independent review: a 30 s clock margin on "no row", one last read past the release bound, READ COMMITTED pinned in the key read, `admitBy` required | §5.1 step 8, §11.3, §11.4, §15, §16 |
| As built — modules | Shared Stage-mutex helpers live in `stage-generation-mutex.ts` (so neither store's T1 imports the other's); §10.8 lives in `insertion-skill-validation.ts`; `INSERTION_PERSISTENCE_FAILED` (503) is added for a commit that could not be recorded | §16, §17 |

## What changed from v3 (v3.1)

| Finding | Change | Sections |
|---|---|---|
| V3-1 (Major) — result applied after an async read without re-checking dirt | On success the client **fetches first** (`loadStageData`, the last `await`). One **synchronous** `applyInsertionResult` then runs: it re-checks Stage and operation identity, re-reads local state, **recomputes** document dirt at that moment, and does a clean apply or a local-wins merge with revision binding. Nothing awaits in between. Stale responses are discarded. The insertion client no longer calls `resyncStageScenesFromServer`, which stays unchanged | F62, D-21, §5 step 4, §5.1 (API 6–9, step 9), §17, §18, A-22..A-25 |
| V3-2 (Minor) — direct document saves outside the durability check | **Track and drain** direct aggregate saves. `saveToStorage` registers its promise synchronously in a Stage-keyed registry; `drainStageDocumentWrites` awaits them along with the scheduler flush; `isStageDocumentDurable` also requires the registry to be empty for the Stage. While an insertion holds the Stage, a new `saveToStorage` call is **deferred** into full-aggregate dirt instead of writing, so no document write can start between the re-prove and `release()` | F61, D-21, §5.1 (API 2–5, steps 3–6, 10), §17, §19, §18, A-26 |

## What changed from v2 (v3)

| Finding | Change | Sections |
|---|---|---|
| V2-1 (Major) — Skills validated against outline history | Two separate validation inputs. Scene-policy checks keep the §9.4 outline projection. **Whole-stage Skill validation now runs on the live persisted scenes**, each with its current `teachingSkills`, plus the new scene's selection carrier. Historical outline assignments never stand in for scene assignments. The same rule applies in planning, the corrective re-ask and T2. A per-scene pre-check runs before any paid call | F51–F53, D-12, §10.8, §10.1, §10.7, §11.4, §18, A-15..A-17 |
| V2-2 (Major) — durability proven for one scene only | A Stage-wide client protocol: lock editing, drain, then **prove** with a new `isStageDocumentDurable` that no document dirt and no write in flight remain across the Stage (a resolved flush is not proof). Then hold, re-prove, POST, resync only when clean, and otherwise merge with local edits winning. Refusal keeps local edits. New store APIs are added; `lib/store/stage.ts` and the edit surfaces leave the "untouched" list. *(Its result-application step and its durability definition were superseded in v3.1 by V3-1 and V3-2.)* | F54–F58, D-21, §5.1, §17, §19, §18, A-18..A-21 |
| V2-3 (Minor) — verdict store construction | Use the verified factory `getVerdictStore()`, which builds `PgVerdictStore(pool)` or `MemoryVerdictStore`. Call only `.get()`, and describe its lazy idempotent schema ensure. Never screen. The call budget is corrected to 3 canvas + 2 assistance calls; JSON repair is a local parser (no model call), resolved by reading the code | F48, F59–F60, D-10, §10.4, §14.1, §25 |

## What changed from v1 (v2)

| Finding | Change | Sections |
|---|---|---|
| R1 (Blocker) — snapshot not bound to its revision | T2 builds from a revision → document → revision sandwich. The write fence takes `stage_meta FOR UPDATE` itself, then compares the stage revision on the same queryable, and keeps the lock through save, completion and events. Lock order, rebuild and retry limits are spelled out | §3.10 (F34–F37), §11.2, §11.4 |
| R2 — insertion and regeneration starts race | Both T1 paths take `stage_meta FOR UPDATE` as a shared mutex covering lease reclaim, replay, both running checks and row creation. Expired leases are reclaimed in both directions | §11.3, §11.7, §4.1 B-2/B-3 |
| R3 — F24 wrong; outline could be clobbered | F24 corrected. **The insertion no longer changes the outline record** (no entry, no shift). The storage write rewrites the row byte-for-byte as loaded, under the revision fence. The new scene carries a fresh `outlineId` that resolves to nothing. Stale tabs are forced through the existing whole-document precondition | §3.5 (F24), D-6, §11.8, A-7 |
| R4 — planner contract incomplete | Conditional `assistancePlan` and `visualPlan` are added to the prompt, JSON contract, validation and re-ask. Content is generated from the normalized outline. The hidden-assistance boundary is kept | §10.1–§10.3 |
| R5 — exact flow not validated | `validateExactTeachingFlow` runs on the real post-insertion scenes and outline: before T1 on a placeholder projection, and again on the exact T2 snapshot. Diagnostics get stable identities. Pre-existing policy drift is tolerated; exact-flow violations never are | §9.3–§9.5, §11.4 |
| R6 — replay unreachable | Idempotency lookup runs right after grant, structural validation and digest, before any new-run check. T1 repeats it authoritatively. Key conflicts are told apart from running-index conflicts | §6, §11.6 |
| R7 — regeneration side effects undocumented | D-13 also changes agent `generate_actions`. Whole-document writes invalidate an earlier regeneration's Restore. The limits of the order fallback are documented. No guard is weakened | §4.1 B-1, §22 |
| R8 — schema evolutions implicit | E-2 and E-3 SQL are written out with new guard predicates, superset CHECKs, fresh-DDL updates and `DOUBLE PRECISION` ms timestamps. Old-schema checks are added | §12, §18 |
| R9 — call counts and attribution | A full call budget, including assistance, visual correction, leak regeneration, re-asks, register retries and provider fallback. A new insertion route adapter attributes every provider call | §14 |
| Also | Normalize/migrate before baseline stamping; a non-null baseline is required. Approved-verdict lookup is read-only and scoped. Facts F2, F6, F7, F10, F18, F21, F22, F24, F30, F31, F32 and F33 are corrected. Stage-revision access and non-streaming routing are resolved. "Ready for implementation" is removed | §3, §10.4–§10.5, §25 |

---

## 0. Summary

Today a reviewer can **replace** one existing slide with AI. They cannot **add** an AI slide for a part of the lesson (a Content Unit) that no slide covers; the editor's "+" adds only a blank slide.

This plan adds one action. The reviewer:
1. picks one to three uncovered Content Units;
2. accepts or changes a position;
3. optionally writes an instruction;
4. writes a reason.

The Teaching Engine then generates **one new slide**, grounded in those units' retained text, and inserts it atomically at that position, or nothing changes. On governed versions the slide is born with its teaching stage, classification, Skills, alignment baseline and unit ids.

---

## 1. Requirement

The user is a reviewer with a **write** Editor grant on an **editable** (`draft` / `rejected`) Teaching Package version:
1. They see which instructional Content Units of the lesson have **no slide**.
2. They ask for **one new slide** for 1–3 of those units, at a valid position.
3. The slide they get is grounded in the units' text and follows the Teaching Model Flow position it lands in. It passes the submit checks the insertion is responsible for (§9, §10); narration audio on voiced packages is repaired separately (§10.6).
4. They see the result only when it equals what the database holds.

The reviewer submits:
- `instruction` — **optional**, 0–2000 characters. It sets a focus for the model.
- `reason` — **required**, 5–1000 characters. It is audit text and never enters any prompt or re-ask (the regeneration rule, [V-code] `scene-regeneration.ts:9-11`, `regenerate-one-scene.ts:14-16`).

An insertion cannot repair a package that is already broken. If the version already fails the exact flow, the insertion is refused (§9.3).

---

## 2. Scope

**In scope (v1):**
- Slide scenes only.
- Units that are instructional (role not `REFERENCE` / `UNCLASSIFIED`), have retained text, and are cited by **no live slide** (§8.2).
- Versions with a Teaching Model Flow: governed (Skills contract) and tier B (flow, no Skills contract).
- One insertion per request, and one running insertion per Stage. An insertion never overlaps any regeneration on the same Stage. Regenerations of different scenes still run in parallel, as they do today.

**Out of scope (v1):**
- Quiz, interactive, PBL and game scenes.
- A second slide for an already-covered unit (F-1).
- Legacy v1 versions (no flow), and legacy successors, which refuse any added scene ([V-code] `lifecycle.ts:350-360`; `successor-model.ts:154-158`).
- New AI image generation, a compliance screening call, or re-acquiring the source ZIP.
- TTS inside the run (§10.6).
- A dedicated undo button (D-9, F-3).
- Any change to `@openmaic/generation` or `@openmaic/storage`; no package version bump.
- Any change to the outline record (`document_outlines`) by the insertion (D-6). The storage write rewrites the row with exactly the content it loaded, under the revision fence.
- Any change to the persistence route, or to the behaviour of the existing client save path. The client store gains **additive** APIs: the Stage durability check, the direct-save registry and drain, the editing lock and the synchronous result application. It also gets one scoped change: `saveToStorage` registers itself and defers only while an insertion holds the Stage (§5.1, D-21).

---

## 3. Verified facts

### 3.1 Content Units
- **F1** A unit is `{ id, orderIndex, role, subtype?, title?, normalizedText?, blocks[] }`. Its non-instructional roles are `REFERENCE` and `UNCLASSIFIED`. [V-code] `normalized-content-resource.ts:31-39`; `content-units.ts:35-38`.
- **F2** The generate request carries a presigned ZIP URL, which is a transient credential. The runner does not store it. A resumed run is handed a new URL, but nothing kept is available for this feature to re-acquire the ZIP. [V-code] `lib/types/teaching-package.ts:618-630`; `generation-runner.ts:343-353,373-375`.
- **F3** After acquisition the runner writes every unit that has text to `teaching_package_content_units` (`attempt_id, tenant_id, unit_id, order_index, role, subtype, title, normalized_text, text_length, …`, PK `(attempt_id, unit_id)`). Textless units get no row. [V-code] `lib/persistence/teaching-package.ts:447-467`; `generation-runner.ts:398-409`; `content-units.ts:68-93` (the skip is at `:80`).
- **F4** Retention exists since commit `4ef08434` (2026-09-22) and only for Kafuo-normalized sources. [V-code] `git log -- lib/server/teaching-package/content-units.ts`. Whether the target staging versions have rows is [UNVERIFIED → A-1].
- **F5** `readContentUnitsForAttempt` returns the retained units in order, tenant-scoped. `readContentUnitsForVersion` walks `current_attempt_id` / `predecessor_version_id` and **stops at the first version that has a producing attempt**. That attempt must be `kafuo_normalized` and have retained rows, or the result is `unavailable`. It never falls through to an older attempt, and it returns only the requested ids. [V-code] `teaching-package.ts:2073-2085,2125-2179` (stop rule at `:2151-2166`).
- **F6** No Stage/version unit-list endpoint exists under `app/api`. The correction route lists choices from the paused-attempt checkpoint (`outline-correction.ts:555-573,639-651`); `generation-correction.ts:233` is its awaiting-checkpoint precondition, not the list itself. [V-code].

### 3.2 Citations and coverage
- **F7** New scenes persist `sourceContentUnitIds`. [V-code] `lib/api/stage-api-scene.ts:76-81`; `lib/server/scene-generation.ts:52-57`; `tests/api/stage-api-scene.test.ts:70-89`. The carry-forward of stored lineage for writes that omit it happens **only in `putScene`**; `saveDocument` does not carry it forward. [V-code] `owner-bound-document-store.ts:74-83,149-158`.
- **F8** Help's citation rule, in order:
  - a scene's `sourceContentUnitIds` array, when present, is used even when empty, filtered to strings;
  - when absent, the ids of the outline entry whose `id === scene.outlineId`, never matched by order, with numeric ids turned into strings.

  [V-code] `lib/server/tutor/help-service.ts:218-242`.
- **F9** The outline grounding path checks only that each outline cites at least one known id. It does not check that every unit is covered, and no per-unit coverage report is stored. [V-code] `outline-grounding.ts:54-72`; `outline-correction.ts:128-147`. "Nowhere" is a static-search conclusion for the TE.

### 3.3 Slide generation inputs
- **F10** In the slide pipeline, unit text reaches only the outline step (`pdfText`, capped at 50,000). [V-code] `generation/src/constants.ts:1`; `outline-generator.ts:402-404`. Retained text is also read by Help (`help-service.ts:349`).
- **F11** `generateSlideContent` receives title, keyPoints, description, images, Skill definitions and role guidance, but no unit text. [V-code] `scene-generator.ts:1176-1197`. `sourceContentUnitIds` is planner guidance only (`slide-generation-inputs.ts:35-53`).
- **F12** A caller-supplied `editDirective` or `baselineContent` switches the content prompt to EDIT MODE. [V-code] `scene-generator.ts:1217-1244`.
- **F38** Visible and hidden inputs are split. Only `title` and `keyPoints` are learner-visible input (`toVisibleSlideInput`). `description`, `visualPlan`, slide semantics, Skills and unit ids are non-display planner guidance (`toPlannerGuidance`). `assistancePlan` is excluded from both. [V-code] `slide-generation-inputs.ts:27-75`.
- **F39** Assistance authoring is the only call that sees the hidden plan. It is a separate model call after the canvas. A required-but-missing assistance, or assistance that exposes internal text, fails the slide. Solution text leaking onto the canvas triggers one canvas regeneration plus one assistance re-author. [V-code] `scene-generator.ts:636-690`.
- **F40** A missing planned visual triggers one native-visual correction call. **The generator passes the first draft internally as `baselineContent`** at `scene-generator.ts:597-623`. This is existing generator behaviour, not a caller input.
- **F41** Outline semantics ([V-code] `outline-semantics.ts:168-246`; tiers at `@openmaic/dsl/src/slide-semantics.ts:211-228`):
  - `assistancePlan` is allowed only for `practice` / `check_understanding`;
  - its tiers are `hint`, `help` and `explanation`;
  - `practice` + `independent` requires `hint` and `explanation`;
  - `visualPlan` (`image` | `native` | `omitted` with a specific `omissionReason` of 15 characters or more) is required for the `cover` + `orientation` opening.
- **F42** Flow policy: a position with any `visual` requirement needs `visualPlan.mode` of `image` or `native` (`VISUAL_REQUIRED`). Only `visual: source_grounded` positions are normalized by `normalizeSourceGroundedVisuals`. [V-code] `teaching-flow-policy.ts:256-258,472-480`.

### 3.4 Submit rules
- **F13** Submit checks depend on the tier. Legacy v1 has none. A legacy successor refuses any added scene. Tier B gets the exact flow and game deferral. Governed versions also get actions, visuals, Skills and alignment. [V-code] `lifecycle.ts:379-425,434-514,540-605`.
- **F14** `validateExactTeachingFlow(scenes, flow, outlines?)` checks (orders, `exact-flow.ts:46-61`):
  - orders are finite and unique;
  - every scene has an in-range `(key, flowIndex)` whose key matches its flow entry;
  - if the scene's `outlineId` resolves, the outline agrees with the scene (`outline_scene_mismatch`); an unresolved `outlineId` is skipped;
  - the stage sequence with consecutive repeats collapsed equals `[0..n-1]`.

  Submit calls it with the stored `outline.outlines`. [V-code] `exact-flow.ts:62-213`; `lifecycle.ts:432-446`.
- **F15** Submit does not run scene policy (cardinality, slide types, roles, visual) or slide classification. Those are outline-time checks in `teachingFlowDiagnostics`. [V-code] `teaching-flow-policy.ts:347-518`; `outline-generator.ts:304-305`. Its diagnostics carry `code`, `outlineId`, `outlineIndex`, `field`, `flowIndex` and `stage`; `FLOW_SEQUENCE_INVALID` and `POSITION_CARDINALITY` are stage-wide codes. [V-code] `outline-diagnostics.ts:21-38`; `teaching-flow-policy.ts:497-510`.
- **F16** Governed Skills require:
  - an explicit classification;
  - exactly one primary Skill on instructional scenes;
  - selections drawn from the position's allowed set;
  - the required, version, duplicate and combination rules.

  [V-code] `skill-validators.ts:378-439,462-610`. `setSceneTeachingSkills` validates the whole stage with `validateOutlineSkillSelections`, `validateSkillAssignmentStructure` and `validateSceneClassifications`. [V-code] `scene-skills.ts:219-230`.
- **F17** Alignment:
  - no baseline gives `validation-required`, which blocks a governed submit;
  - the fingerprint excludes `order` and `teachingStage`;
  - `buildSceneAlignmentBaseline(scene, { origin, now })` returns null without a classification;
  - generation runs the DSL `migrate` **before** stamping, so the fingerprint matches the persisted bytes.

  [V-code] `alignment.ts:32-35,150-185,227-235`; `lifecycle.ts:565-583`; `stage-persistence-sink.ts:98-120`.
- **F18** On a **governed** submit, every slide image must screen as approved. [V-code] `visual-compliance/stage-gate.ts:48-89`; `lifecycle.ts:498-514`. Legacy and tier B submits do not run this gate.
- **F19** Narration audio does not block submit: `audioId` is excluded from structural validity, and `NARRATION_AUDIO_FAILED` is a mark only. [V-code] `action-validation.ts:33-38`; `narration-audio-issue.ts:12-52`.

### 3.5 Insert paths, outlines and traps
- **F20** The editor "+" builds a blank scene that inherits the previous scene's `teachingStage`, renumbers scenes client-side, and saves through a full `saveDocument`. That save is a document PUT with an expected revision for every live scene. [V-code] `SlideNavRail.tsx:281-297`; `scene-defaults.ts:31-77`; `stage-storage.ts:405-436`; `revision-precondition-fence.ts:94,165-174`.
- **F21** The agent's `generate_scene` can't serve reviewers:
  - it uses unrouted model calls (`generation-tools.ts:358-359`; `generation-ai-call.ts:22-35`);
  - it replaces by order instead of inserting (`:412-420`);
  - it mints `outlineId = p${order}` (`:507`);
  - its store is bound to the session owner (`runner.ts:1360-1370`), and package stages are service-owned (`owner.ts:10-16`; `owner-bound-document-store.ts:275-276`).

  [V-code].
- **F22** Existing server-side insertion precedents both shift scenes **and** outline entries, then call one `saveDocument`. They are agent `duplicate_scene` (`generation-tools.ts:915-939`, using `shiftCourseOrders` at `course-edit/tools.ts:59-78`) and agent `edit_deck` insertion (`course-edit/tools.ts:184-200`). `duplicate_scene` gives the copy `outlineId: id` and adds **no** outline entry for it (`generation-tools.ts:924`). That is a precedent for a scene whose `outlineId` resolves to nothing. [V-code].
- **F23** `outlineFromScene` uses `outlines.find(e => e.id === scene.outlineId || e.order === scene.order)`: the first entry matching either wins. It is used by package regeneration seeding and by agent `generate_actions`. [V-code] `generation-tools.ts:241-244,827`.
- **F24 (corrected)** The v1 inference was **wrong**. The client full save calls `documentSnapshot(…, existing?.outline, …)`, but `documentSnapshot` spreads `...data.outline` **after** `...existingOutline`, so the client's `outlines` array wins. [V-code] `stage-storage.ts:185-205,419-425`. The client sends `snapshot.outlines` on every save (`lib/store/stage.ts:676-691`), and `resyncStageScenesFromServer` refreshes scenes and revisions but not outlines (`stage.ts:1565-1603`). **A server-side outline change would be overwritten by the next full save of any tab.** This plan therefore does not write the outline record (D-6).
- **F43** In editor sessions the store's outline content changes only through `setOutlines` / `setGeneratingOutlines`. Their only caller is `app/generation-preview/page.tsx:945`; the `setOutlines` in `slide-element-pick-overlay.tsx` is local React state. [V-code] (grep). Grant editor sessions therefore echo outlines without authoring them.
- **F44** A whole-document precondition needs an expectation for **every** live scene, and every expectation must still be live at that revision. So a tab that has not seen a newly inserted scene cannot full-save until it resyncs, and the new scene appears in the 409's `scenes`. [V-code] `revision-precondition-fence.ts:144-176`. Conflict recovery resyncs the conflicted ids and pushes server scenes the tab did not have. [V-code] `stage.ts:1589-1596,1606-1636`.

### 3.6 Regeneration machinery
- **F25** `teaching_package_scene_regenerations` requires a pre-image (`previous_scene` and `base_scene_rev` are NOT NULL) and allows one running row per `(stage_id, scene_id)`. Its timestamps are `DOUBLE PRECISION` epoch ms. [V-code] `teaching-package.ts:476-512`.
- **F26** Regeneration T2 takes `stage_meta FOR UPDATE` in its fence, checks version, lease and revision, writes, then completes in the `'after'` phase. Triggers bump scene and stage revisions. [V-code] `scene-regeneration-store.ts:637-798`; `storage/src/document/pg.ts:157-224`.
- **F27** The review-event CHECK (`teaching_package_review_events_event_type_check`) is widened by a DO block guarded by `LIKE '%scene_regeneration_restored%'`. The fresh `CREATE TABLE` uses `REVIEW_EVENT_TYPES_SQL`. [V-code] `teaching-package.ts:60-77,137,378-396`.
- **F28** The ledger:
  - the capability CHECK is an inline column CHECK (`teaching_model_attempts_capability_check`), widened by a DO block guarded by `LIKE '%scene_regeneration%'`;
  - `createRegenerationRoute` hardcodes `capability: 'scene_regeneration'` and `sceneRegenerationId`;
  - attribution also lives in the association type, the INSERT mapping, `AttemptGroupBy` and `GROUP_BY_COLUMNS`.

  [V-code] `teaching-model-attempts.ts:25-31,124-132,176-195,225-238,417-467,850-883`; `routed-regeneration-call.ts:96-117`.
- **F29** The regeneration client works in this order:
  - it locks and flushes, checks durability, and holds writes;
  - it POSTs with a key and polls;
  - it applies the server scene and binds its revision.

  The dialog blocks closing while a run is going. [V-code] `scene-regeneration-client.ts:200-288`; `stage.ts:1645-1719`; `RegenerateSlideDialog.tsx:202-220`. The audio client uses the same per-scene `beginSceneRegeneration` hold. [V-code] `narration-audio-client.ts:49-60`.
- **F45** Regeneration T1 takes `stage_meta FOR SHARE` and the version `FOR SHARE`. It then reclaims **this scene's** expired leases, looks up idempotency `FOR UPDATE`, checks for a running row on the scene, and INSERTs. [V-code] `scene-regeneration-store.ts:400-515`.
- **F46** Restore requires the live revision to equal `result_scene_rev`; otherwise it fails with `SCENE_CHANGED_SINCE_REGENERATION`. [V-code] `scene-regeneration-store.ts:955-963`.
- **F47** The regeneration status read is scoped to tenant, version and Stage. [V-code] `scene-regeneration.ts:479-497`.

### 3.7 Images and compliance
- **F30** Only images selected by some outline are materialized and listed in `outline.sourceVisuals`, each with `sha256`, `servingPath` and `sourceContentUnitIds`. [V-code] `classroom-generation.ts:1547-1569`; `source-images.ts:132-136,274-327`; `lib/types/teaching-package.ts:793-818`. Regeneration also lifts concrete images already present in the pre-image into `imageMapping` (`scene-regeneration-images.ts:88-115`). The insertion has no pre-image, so only `sourceVisuals` apply.
- **F31** `normalizeSourceGroundedVisuals` tries, in order: the outline's suggested ids that are grounded in its units; then the first image linked to its units; then any available suggested id; then a native visual. [V-code] `teaching-flow-policy.ts:247-284`. The image set it receives decides what can be chosen.
- **F48 (corrected in v3)** Screening and verdict reads are separate.
  - `screenVisualWithDefaults` uses the verdict cache keyed by `(profileId, sha256)`, and on a cache miss it may call the vision screening client. [V-code] `visual-compliance/index.ts:39-60`; `screen-visual.ts:1-17,91-104`.
  - `VerdictStore` is an **interface** (`get`, `put`) (`visual-compliance/types.ts:93-96`).
  - The concrete Postgres class is `PgVerdictStore(queryable)` (`verdict-store.ts:48-50`). Its `get` first runs a lazy, memoized `ensureVisualComplianceSchema` (`CREATE TABLE IF NOT EXISTS visual_compliance_verdicts …`, idempotent DDL, once per store instance), then a single `SELECT … WHERE profile_id = $1 AND checksum = $2` (`verdict-store.ts:14-30,52-63`).
  - The verified factory is `getVerdictStore()`. It returns a process-wide promise of `PgVerdictStore(pool)` when `DATABASE_URL` is set, or a `MemoryVerdictStore` otherwise; the same store backs screening. [V-code] `visual-compliance/index.ts:20-31`.
  - The profile comes from `resolveMoeBrandProfile()` (`brand-profile.ts:8,41`).

### 3.8 Model routing and call counts
- **F28b** The subject policy resolves the model string **without a stage** (`resolve-policy.ts:1-12,55-62`). The ledger `stage` is a label (`execute.ts:88-97`). `executeTeachingCall` is non-streaming (`execute.ts:913-921`). The package runner already routes `scene-outlines-stream` (`classroom-generation.ts:994-1000`). A provider fallback is a retry with its own ledger row (`execute.ts:14,287-302`). [V-code].
- **F49** Narration register re-rolls are bounded at `SPEECH_REGISTER_MAX_ATTEMPTS = 3` in total. [V-code] `classroom-generation.ts:116,129-176`.
- **F32** The scene regeneration path serializes per scene; it has no tenant quota or in-flight cap (`scene-regeneration-store.ts:448-513`). The conversational budget check in `teaching-model/execute.ts:792-795` is not a tenant quota. [V-code] within the paths read.

### 3.9 Other repos
- **F33** The backend sends the approved version's section content pins (`zakrly-backend/.../build_generation_request.py:15-23`) and reads `scenesNeedingReview` from the attempt snapshot (`reconciliation.py:163-169`). Admin requests a handoff and opens the URL (`zakrly-admin-panel/.../learningItemService.ts:625-635`; `TeachingPackageActions.tsx:302-310`). Mobile orders scenes by `order` (`Zakrly-mobile-app/lib/features/classroom/domain/stage.dart:752-764`). [V-code]. This supports "no contract change". It does not prove that no other backend scene-level read exists, and it is not a playback test (A-10).

### 3.10 Revisions, locks and storage writes (resolves the v1 UNVERIFIED on stage revisions)
- **F34** `document_stage_revision(stage_id, rev)` exists. The scene trigger bumps it on every insert, update or delete of `document_scenes`, and the stage trigger does the same on `document_stages`. [V-code] `pg.ts:157-160,169-224`. `readStageFreshnessManifest(stageId, queryable)` reads it plus every scene's `(id, order, rev)` on **any** queryable. [V-code] `pg.ts:330-355`.
- **F35** Outlines are written **only** by storage `saveDocument` (`pg.ts:713-722`). That function always:
  - upserts the stage row (`persistStage`, `ON CONFLICT (id) DO UPDATE`, `pg.ts:618-630,682`);
  - upserts every incoming scene with an unconditional `DO UPDATE` (`pg.ts:688-702`);
  - deletes every stored scene that is missing from the payload (`pg.ts:703-710`).

  So **every write that can change scenes, the stage or the outline bumps the stage revision**. A revision → document → revision sandwich with equal revisions therefore proves that no such write committed in between.
- **F36** The owner-bound `withTransaction` runs `mutationFence(…,'before')` **before** it takes its own `stage_meta FOR UPDATE`. It then runs the body, then `'after'`, then COMMIT, all on one READ COMMITTED connection. [V-code] `owner-bound-document-store.ts:255-303`. So a fence that needs the lock must take it itself, as regeneration and the precondition fence do (`scene-regeneration-store.ts:637-642`; `revision-precondition-fence.ts:194-197`).
- **F37** Storage `loadDocument` returns an already-migrated document (`pg.ts:727-732`). `readFreshnessManifest` is its own transaction (`pg.ts:734-750`). The client has a precedent for the sandwich: three attempts, then `StageLoadRaceError`. [V-code] `stage-storage.ts:100-136`.
- **F50** The Content Unit lineage stop rule (F5) and the Help citation rule (F8) are the two rules the coverage helper must mirror exactly.

### 3.11 Skill carriers (V2-1)
- **F51** **Scenes are the Skill selection carrier; the outline record is history.**
  - The Skill edit route builds its post-change set from `document.scenes` and moves only `teachingSkills` (`scene-skills.ts:197-205`). It writes scenes only (`:247-254`).
  - The governed submit gate validates scenes (`lifecycle.ts:533-554`).
  - The outline record "keeps the generation-time selection as history" (`lifecycle.ts:536-538`).
  - Scenes satisfy the validators' input shape `OutlineSkillSelectionShape { id, teachingStage?, teachingSkills?: { primary?, supporting?, classification? } }` (`skill-policy.ts:171-179`).

  [V-code].
- **F52** The governed submit gate runs, first failure wins, over the scenes:
  - `validateFlowSkillPolicies(flow)`;
  - `validateFlowPolicySatisfiability(flow)`;
  - `validateSkillReferencesResolve(flow, scenes)`;
  - `validateRequiredSkillSatisfaction(scenes, flow)`;
  - `validateSkillAssignmentStructure(scenes, flow)`;
  - `validateSceneClassifications(scenes)`.

  [V-code] `lifecycle.ts:546-554`. The Skill edit route runs `validateOutlineSkillSelections` + `validateSkillAssignmentStructure` + `validateSceneClassifications` (`scene-skills.ts:219-230`).
- **F53** `validateSceneClassifications` refuses any carrier whose `teachingSkills.classification` is missing, or is not `instructional` / `non-instructional` (`skill-validators.ts:585-610`). An outline synthesized from a scene without copying `teachingSkills` would therefore fail it. That is the V2-1 failure mode.

### 3.12 Client persistence and durability (V2-2)
- **F54** `flushStageSave()` resolves **even when the round failed**. It returns early when the covering round reports failed keys (`stage.ts:1545-1550`), so a resolved promise is not proof of durability. [V-code] `stage.ts:1526-1556`.
- **F55** `isSceneDurable(stageId, sceneId)` proves one scene only. It returns false while a flush round is in flight for the Stage, or when `scene:<id>`, `structure` or `outline` is pending. Another scene's pending entry does not make it false. [V-code] `stage.ts:1640-1651`.
- **F56** Pending state is module-level:
  - `pendingStageId`, `pendingRevision` (a monotonic counter), `pendingChanges: Map<key, {change, revision}>`, `flushInFlight` (`stage.ts:56-65`).
  - The document-writing kinds are `scene`, `structure`, `stage` and `outline`. `currentScene` and `chats` do not write the document (`stage-storage.ts:142-148,368-381`).
  - `markPendingChanges` records a mark even for a scene under a regeneration lock (it only logs) (`stage.ts:317-343`).
  - An unresolved grant session records dirt but schedules nothing (`stage.ts:299-305,317-324`).
- **F57** The write hold is Stage-wide. `beginSceneRegeneration(...).holdWrites()` increments `regenerationBarriers[stageId]`, and while it is set `startFlushRound` returns null for that Stage. `release()` schedules what was held (`stage.ts:67-76,1680-1721,1414-1424`). The per-scene `regenerationLocks` has **no consumer** outside `lib/store/stage.ts` (grep); the editor relies on the modal dialog.
- **F58** `resyncStageScenesFromServer(stageId, 'all')` replaces every scene and binds revisions, **without clearing pending entries** (`stage.ts:1571-1603`). Run while document dirt exists, it would silently replace local unsaved content, and the later save would write the server copy back. `replaceSceneFromServer` drops one scene's pending entry (`stage.ts:1660-1673`). Save conflicts are published through `onStageSaveConflict` (`stage.ts:97-100,1631-1633`). The slide surfaces have their own undo paths (`components/edit/surfaces/slide/use-slide-surface.ts`, `slide-edit-session.ts`; grep), so a modal dialog alone is not a proven lock for keyboard-driven mutations [UNVERIFIED → W4 inventory].

- **F61 (V3-2)** `saveToStorage` is a **direct aggregate document save**.
  - It runs outside both `pendingChanges` and `flushInFlight`, and it bypasses the `regenerationBarriers` hold, because it never goes through `startFlushRound` (`stage.ts:1128-1146`; also documented at `:370-373,396-403`).
  - It awaits `preparePBLScenesForDocumentPersistence`, then `saveStageData`, and returns `true` only on a verified write (`:1147-1205`).
  - Its callers (grep) are:
    - `setGenerationComplete` (`stage.ts:1057-1061`);
    - the generation-complete self-heal in `loadFromStorage` (`:1389`);
    - `applyClassroomStageAndScenes` server-restore hydration (`lib/classroom/load-classroom.ts:310-311`);
    - `app/generation-preview/page.tsx:1051`.

  All four are load-time or generation-time, but nothing in the store prevents one from running during an editor session. Three are fire-and-forget (`void`: `setGenerationComplete`, the self-heal, server-restore hydration) and one is awaited (`generation-preview`), so one may still be in flight when preparation begins. [V-code]. **These four are the `saveToStorage` callers, not every document writer:** the departing-Stage `persistDirtySnapshot` in `setStage` (`stage.ts:746-815`), media-reference persistence (`lib/media/persist-media-reference.ts`), stage rename and delete/restore (`lib/utils/stage-storage.ts`, `lib/utils/database.ts`) also write the document outside the scheduler and the registry (v3.2, V3.1-2).
- **F62 (V3-1)** `resyncStageScenesFromServer` first `await`s `loadStageData`. **After** the await, it replaces every scene (`'all'`) and binds revisions, with no dirt check (`stage.ts:1571-1603`). A mutation that lands during its await is overwritten. `loadStageData` itself only reads (the sandwich, current scene, chats; `stage-storage.ts:515-530`). The scene-load token counter is `latestStageSceneLoadToken`, with `claimStageSceneLoadToken` and `isCurrentStageSceneLoadToken` (`stage.ts:52,481-488`). Its only claimers are navigation, reload and clear paths:
- `setStage` (`stage.ts:746-747`);
- `loadFromStorage` (`:1216`);
- `clearStore` (`:1400-1401`);
- the classroom loaders (`components/classroom/ClassroomSurface.tsx:121`; `app/classroom/[id]/page.tsx:70`).

Neither `loadStageData` nor `resyncStageScenesFromServer` claims one (grep). So the insertion's own fetch never moves the token, and a moved token means the Stage was switched, reloaded or cleared during the run. Revision binders are `bindStageSceneRevs` and `setSceneRev` (`lib/persistence/scene-revision-registry.ts:68,91`). [V-code].

### 3.13 Content generation call structure (V2-3)
- **F59** Per slide, `generateSceneContent` can make:
  - **three canvas calls**: the initial `generateCanvas()` (`scene-generator.ts:553-573`), the native-visual correction (`:597-623`) and the solution-leak regeneration (`:679-685`). `generateCanvas` and `generateSlideContent` each make exactly one `aiCall` (`:1251`);
  - **two assistance calls**: the initial `authorAssistance` (`:640-650`) and the re-author after a leak (`:688`). `generateSlideAssistance` makes one `aiCall` (`slide-assistance.ts:113`).

  `generateSceneActions` makes one `aiCall` for a slide (`scene-generator.ts:2261`). A model-free default is a fallback, and package paths refuse it (`regenerate-one-scene.ts:243-279`). Register re-rolls wrap it, up to 3 attempts (F49). [V-code].
- **F60** JSON repair is local parsing (`parseJsonResponse`, `tryParseJson` in `packages/@openmaic/generation/src/json-repair.ts:43,177`) and makes **no** model call. [V-code].

---

## 4. Decisions (all closed — the owner can object to any)

| # | Decision | Closed as | Why |
|---|---|---|---|
| D-1 | Which units can get a new slide | Instructional, with retained text, cited by **no live slide**; **1–3 units** per slide. A unit cited only by a quiz counts as uncovered, and the panel badges it "quiz only" | The owner asked for "a part with no slide"; a quiz tests a part, it does not teach it |
| D-2 | Entry points | A "Lesson parts" panel (uncovered units, each with "Generate slide") **and** a third "+" choice, "Generate with AI". Both use one dialog | The panel says what is missing; the "+" says where to put it |
| D-3 | Position from the panel | Suggested automatically (§9.1), editable in the dialog | The reviewer should not have to count slides |
| D-4 | Teaching stage at the position | Allowed `(key, flowIndex)` values are computed server-side (§9.2): one is used silently, two (a boundary) let the reviewer pick (the default is the previous scene's), none means refusal | Keeps the exact flow and the scene policy that submit does not check (F15) |
| D-5 | Grounding | A new app-local **planner** call reads the units' text and returns one outline. The unchanged slide generator runs on the **normalized** outline. No caller `editDirective` / `baselineContent` | F11/F12; no package change |
| D-6 | Order and outline record | **Integer shift of scenes only** (`order >= at` → `+1`), in the same atomic write as the new scene. The outline record is **not changed**: no entry, no shift. `saveDocument` rewrites the row with exactly the content loaded at the fenced revision (§11.4). The new scene's `outlineId` is a fresh `ins_<nanoid>` that resolves to nothing, as in the `duplicate_scene` precedent (F22). The planned outline is kept on the insertion row for audit | F24/F43: any outline the server writes would be overwritten by the next stale full save. Coverage, Help and exact flow all read the scene's own fields (F8, F14). **Depends on D-13** (an `outlineId` that is present never falls back to order) |
| D-7 | T2 consistency | A revision-sandwiched build, then a fenced write that re-checks the stage revision under `stage_meta FOR UPDATE`, with up to 3 rebuilds. Edits made to other slides during the generation are kept | R1; a fence on the T1 state would fail on any edit during a 1–2 minute run |
| D-8 | Serialization with other paid runs | At most one running insertion per Stage, and an insertion never overlaps any regeneration on that Stage, in either direction. This is enforced under a shared `stage_meta FOR UPDATE` mutex in **both** T1 paths. Regenerations of different scenes still run in parallel, as today. In the same tab, the editor will not start an insertion while a "Regenerate audio" call runs. Across tabs, the commit order decides, and nothing is lost silently (§11.7) | R2 |
| D-9 | Undo | No dedicated undo in v1. The success toast says the slide can be deleted like any slide | Normal delete removes it; there is no outline entry to clean up (D-6) |
| D-10 | Images | Only `sourceVisuals` linked to the chosen units **and** with an `approved` cached verdict. The verdict is read with `(await getVerdictStore()).get(profileId, sha256)`; failing closed makes the image ineligible. Otherwise a native visual or none, per policy. No `screenVisual*` call, no vision-client call, no new AI image | F18/F30/F48; a screening call would be an unledgered paid call |
| D-11 | Narration audio | No TTS in the run. On a voiced package the slide gets `NARRATION_AUDIO_FAILED`, and the reviewer uses the existing "إعادة توليد الصوت" button | Same rule as regeneration |
| D-12 | Skills and alignment | Governed: Skills come from the plan. They are validated over the **live persisted scenes, each with its current `teachingSkills`, plus the new scene's selection carrier**, never over outline history or synthesized outlines (§10.8). The baseline is stamped after the DSL migration, on the persisted bytes. **It must not be null** (`INSERTION_ALIGNMENT_UNAVAILABLE`). Tier B: neither | F16/F17/F51–F53 (V2-1) |
| D-13 | `outlineFromScene` match | **Id-first:** when `scene.outlineId` is present, match only by id. Fall back to order only when `outlineId` is absent | Wrong pairing after any order shift (F23); a prerequisite of D-6. **[BEHAVIOUR] B-1** |
| D-14 | Schema | New table `teaching_package_scene_insertions`, new event types, new ledger capability and column (§12) | F25 |
| D-15 | Who | Write Editor grant; purpose not `learner` / `preview`; version `draft` / `rejected` | Same as regeneration |
| D-16 | Model routes | Planner on stage label `scene-outlines-stream`, content on `scene-content:slide`, actions on `scene-actions`, all through a new insertion route adapter (§14). Routing is resolved: labels don't select models (F28b) | Provider JSON quality is runtime-only: [UNVERIFIED → A-11] |
| D-17 | Coverage helper | A new `content-unit-coverage.ts` mirrors Help's rule exactly (F8). Help itself is **not** touched | No unsolicited refactor; parity is tested |
| D-18 | Route adapter | A new `routed-insertion-call.ts`. `routed-regeneration-call.ts` is **not** touched | Keeps regeneration behaviour byte-for-byte |
| D-19 | Insert pipeline | A new `insert-one-scene.ts` composes the same exported functions regeneration uses. `regenerate-one-scene.ts` is not modified | Same reason |
| D-20 | A package that is already broken | Refuse when the projected post-insertion document fails `validateExactTeachingFlow` (`INSERTION_FLOW_INVALID`, with the violation in `details`). Also refuse when an existing scene already fails the per-scene Skill checks (`INSERTION_SKILLS_INVALID`, §10.8) | An insertion must never report success on a document that cannot be submitted |
| D-21 | Client durability and result application (V2-2, V3-1, V3-2) | A Stage-wide protocol (§5.1): lock editing; drain scheduler flushes **and registered direct aggregate saves**; **prove** with `isStageDocumentDurable(stageId)` (no document dirt, no flush round, no direct save in flight); hold writes and defer new direct saves; re-prove; POST. On success, **fetch first**, then one synchronous `applyInsertionResult` re-checks Stage and operation identity and the dirt present at that moment, and chooses clean apply or local-wins merge. A stale response is discarded. If durability cannot be proven there is no POST, and local edits stay. Needs new APIs in `lib/store/stage.ts` and a guarded deferral in `saveToStorage` | F54–F58, F61–F62: the per-scene check, a resolved flush and `flushInFlight` do not prove the Stage is saved, and the existing `'all'` resync awaits and then replaces without a dirt check |

### 4.1 Behaviour changes to existing features (each needs the owner's yes)

| # | Change | Who notices | Why it is needed |
|---|---|---|---|
| **B-1** | D-13 id-first matching in `outlineFromScene` | Package single-slide regeneration (seed outline), **and agent `generate_actions` on owner (non-package) stages, which is outside this feature** (`generation-tools.ts:827`) | Without it, every order shift (including the editor's own "+") can seed a slide from another slide's outline; D-6 relies on it |
| **B-2** | Regeneration T1 takes `stage_meta FOR UPDATE` instead of `FOR SHARE`, and also reclaims expired **insertion** leases of the Stage. Code change: `reclaimExpired` in `scene-regeneration-store.ts` (today scoped `{stageId, sceneId}`) gains a Stage-wide scope option, which insertion T1 uses. Regeneration's own call keeps its per-scene scope | Regeneration starts serialize with each other and with editor saves for the few milliseconds T1 lasts | R2: `FOR SHARE` is compatible with itself, so it gives no cross-operation exclusion |
| **B-3** | Regeneration T1 refuses with `STAGE_GENERATION_IN_PROGRESS` while an insertion runs on the Stage | A reviewer who starts a regeneration during an insertion | The shift bumps every scene revision, which would fail the paid regeneration at T2 |
| **B-4** | `RegenerateSlideDialog` shows a localized message for the new code | Same as B-3 | UI only |

The changes v1 considered for outlines (a persistence-route rewrite, or outline refresh in resync) are **not** made (D-6).

---

## 5. User journey (editor)

1. **Lesson parts panel** (grant sessions only).
   - It lists every retained unit in manifest order, badged "covered by N slides", "quiz only" or "no slide". Non-instructional units are greyed as "reference — not taught". Each uncovered instructional unit has "Generate slide".
   - With no retained units, it shows one line: "This package was generated before lesson parts were stored; regenerate the package to use this".
   - On an ineligible version (§7), it is hidden.
2. **"+" insertion zone** gets a third choice, "Generate with AI", shown only when the gate allows it. It opens the same dialog with the position fixed.
3. **Dialog** (`GenerateSlideForPartDialog`):
   - **units**: 1–3, pre-filled;
   - **position**: "after slide N — <title>", which the reviewer can change;
   - **teaching stage**: read-only, a two-way choice at a boundary, or an inline refusal;
   - **instruction** (optional) and **reason** (required).

   Submit follows the Stage-wide durability protocol (§5.1). The dialog is modal with progress, and it refuses to start while a slide or audio regeneration is in flight in this tab (§11.7).
4. **Result.** Per §5.1 step 9: the server snapshot is fetched, then applied in one synchronous step. That is a clean apply when no document dirt exists at that moment, otherwise the local-wins merge; a stale response is discarded. The outline needs no refresh because it is unchanged (D-6). The client then selects the new slide and shows "Slide added for <unit>. You can delete it like any slide." Voiced packages show the existing audio red card.
5. **Errors** map to localized messages (§16). The dialog keeps the reviewer's text. "Unsaved changes" refusals (§5.1) say which change is still unsaved and keep it.

### 5.1 Client protocol — Stage-wide durability and safe result application (V2-2, V3-1, V3-2)

**New store APIs** in `lib/store/stage.ts`. They extend the existing module-level pending state (F56–F58, F61–F62). Existing behaviour is unchanged except for the one guarded deferral in `saveToStorage` (5):

1. **`DOCUMENT_CHANGE_KINDS = {'scene','structure','stage','outline'}`** (F56).
2. **Direct-save registry (V3-2).**
   - It is a module-level `directDocumentSaves: Map<stageId, Set<Promise<boolean>>>`.
   - The order inside `saveToStorage` is fixed: (i) the existing `stage.id` and `mayWriteStageDocument` gates; (ii) the insertion-hold check of API 5, which defers and returns `false` without registering; (iii) **synchronous registration** of its own promise for `stage.id`; (iv) its first `await` (`stage.ts:1131-1146`). It removes the promise in `finally`.
   - So a direct aggregate save already running when preparation begins is visible. This holds for all four callers (F61), with no change to them.
3. **`isStageDocumentDurable(stageId): boolean`** is true only when all of these hold:
   - no flush round is in flight for the Stage (`flushInFlight?.stageId !== stageId`);
   - **no direct document save is registered for the Stage** (`(directDocumentSaves.get(stageId)?.size ?? 0) === 0`);
   - `stageDocumentWriteAccess(stageId) === 'writable'`;
   - `pendingStageId !== stageId`, **or** no `pendingChanges` entry has a kind in `DOCUMENT_CHANGE_KINDS`.

   `currentScene` and `chats` entries do not block, because they never write the document. `flushInFlight` is **not** treated as a counter of every kind of write; direct saves are counted separately.
4. **`drainStageDocumentWrites(stageId): Promise<void>`**. It runs at most 2 rounds of:
   - `await Promise.allSettled([...directDocumentSaves.get(stageId) ?? []])`;
   - then `await flushStageSave().catch(() => {})`.

   It stops early when `isStageDocumentDurable` turns true. It **proves nothing**: only the following `isStageDocumentDurable` call is proof (F54).
5. **Direct saves are deferred while an insertion holds the Stage (V3-2).** If `saveToStorage` is called for a Stage whose insertion handle has called `holdWrites()`, it does **not** write. Instead it re-marks the full aggregate, using the same descriptor set `restorePendingStageChanges` uses (`stage.ts:419-434`, extracted into a shared `fullAggregateChanges(state)` helper), and returns `false`. The held dirt is written by the normal flush after `release()`. This is the only change to `saveToStorage`, and it applies only during an insertion hold. So no direct document write can **start** between the re-prove (step 6) and the end of the run.
6. **`pendingDocumentRevisionMark(): number`** returns the current `pendingRevision`. **`documentDirtSince(stageId, mark): string[]`** returns the keys of document-kind entries whose `revision > mark`, **computed at call time**. `pendingStageDocumentKeys(stageId)` names the pending document keys for a refusal.
7. **`peekStageSceneLoadToken(): number`** reads the existing load-token counter without claiming it (`stage.ts:52,481-488`).
8. **`beginStageInsertion(stageId): StageInsertionHandle`**, with:
   - `operationId`, unique per run; the handle records `loadToken = peekStageSceneLoadToken()` when it is created;
   - `lock()`: a Stage-wide **editing lock**, read by `isStageEditingLocked(stageId)` / `useStageEditingLocked(stageId)`;
   - `holdWrites()`: increments the existing `regenerationBarriers[stageId]` (F57), sets the insertion-hold flag read by (5), and adds the `beforeunload` warning; `isStageWritesHeld(stageId)` reads the barrier for the client's preconditions;
   - `captureBaseline()`: the baseline of step 7 — `{ mark, sceneIds, revs }`;
   - `isCurrent()`: true when the handle is not released, it is the Stage's current insertion handle, `useStageStore.getState().stage?.id === stageId`, and `peekStageSceneLoadToken() === loadToken` (no navigation, reload or clear since it began);
   - `release()`: lifts the lock, the hold flag and the barrier, then schedules held dirt, like the regeneration handle.
9. **`applyInsertionResult(handle, serverData, baseline, { newSceneId, revTransitions }): 'applied' | 'merged' | 'stale' | 'unbound'`** (V3-1, V3.1-1). It is **synchronous**, with no `await` anywhere in it. In order:
   1. If `!handle.isCurrent()`, return `'stale'`: no state change, no revision binding.
   2. If `serverData.sceneRevs` is absent (the read sandwich did not prove its revisions), return `'unbound'`: no state change and no binding. The next save's existing `409` recovery delivers the new scene (F44).
   3. Read the **current** local scenes, and compute `dirty = documentDirtSince(stageId, baseline.mark)` **now**, never from keys captured before the fetch.
   4. If `dirty` is empty, run the **clean apply**: migrate the server scenes, then one `useStageStore.setState({ scenes, currentSceneId })` selecting the new scene, then `bindStageSceneRevs(stageId, serverData.sceneRevs)` (which also drops the binding of any Scene deleted elsewhere). Return `'applied'`.
   5. Otherwise run the **local-wins merge** over the union of ids described in step 9 below, as one `setState` plus per-Scene `setSceneRev` only, and return `'merged'`. Pending entries are never touched.

   Because nothing awaits between steps 1 and 5, no mutation can land between the final checks and the application. The existing `resyncStageScenesFromServer` is **not used** by the insertion client: it awaits its read and then replaces scenes without a dirt check (F62). It stays unchanged for its existing callers.

**Editing lock consumers** must refuse to mutate while `isStageEditingLocked(stageId)`, and must not mark dirt:
- the nav rail actions (`SlideNavRail.tsx`, `InsertionZone.tsx`);
- the slide and quiz edit surfaces, **including their undo/redo and keyboard shortcuts** (`components/edit/surfaces/slide/use-slide-surface.ts`, `slide-edit-session.ts`, `components/edit/surfaces/quiz/*`);
- the Teaching Skills panel (`components/edit/EditDock/TeachingSkillsPanel.tsx`).

The W4a inventory also covers **editor-triggered server writes** that create no client dirt and are therefore invisible to `documentDirtSince`:
- the Teaching Skills panel's `PUT /api/stages/[id]/teaching-skills` (a server `putScene`);
- editor alignment confirmations;
- "Regenerate audio".

These are disabled while the lock is held. If one still lands, for example from another tab, the stage revision moves, so T2 rebuilds (§11.4 step 5) and re-runs §10.8 on the changed scenes.

The full list of mutation entry points is [UNVERIFIED → W4a inventory]. Two safety nets cover anything the inventory misses: for client dirt, the at-apply dirt check in `applyInsertionResult`; for server writes, T2's rebuild with re-validation.

**Sequence** (`lib/edit/scene-insertion-client.ts`):
1. **Preconditions (no side effects).**
   - The gate allows the insertion.
   - Its `running` array is empty.
   - This tab has no slide or audio regeneration in flight: `SlideNavRail`'s `regenerating` / `regeneratingAudio` (F29, `SlideNavRail.tsx:83-89`) are empty, and `regenerationBarriers[stageId]` is unset.

   Otherwise refuse with "another generation is running".
2. **Lock.** `handle = beginStageInsertion(stageId); handle.lock()`. Subscribe to `onStageSaveConflict`. The dialog is now modal and editing is refused.
3. **Drain.** `await drainStageDocumentWrites(stageId)`. It awaits every registered direct aggregate save, including one already running when preparation began (V3-2), and the scheduler flush. A resolved drain is **not** proof (F54).
4. **Prove.** `isStageDocumentDurable(stageId)` must be true: no pending document dirt, no flush round in flight, **no direct save registered**. No save conflict may have been published since step 2. Otherwise:
   - `handle.release()`;
   - refuse `not-durable`, naming the pending keys or the conflict;
   - **no POST, no resync, local edits untouched.**

   If a conflict was published, the existing conflict path has already run its own notice. The insertion does not add a second replacement.
5. **Hold.** `handle.holdWrites()`. It blocks new flush rounds for the Stage (F57) and defers any new direct save (API 5).
6. **Re-prove** right after the hold, synchronously: `isStageDocumentDurable(stageId)`. This catches a mark, a flush round or a direct save that started between steps 4 and 5. If false, release and refuse as in step 4. From here until `release()`, no document write from this tab can start: flush rounds are barred, and direct saves are deferred into dirt.
7. **Mark.** `baseline = handle.captureBaseline()`:
   - `mark`, the current `pendingRevision`;
   - `sceneIds`, the local Scene ids;
   - `revs`, the revision each Scene is bound to in the registry.

   The Stage was just proven durable and no write can start until `release()`, so `revs` are exactly the server's revisions of what the tab holds. (v3.1 kept a per-Scene content snapshot; v3.2 compares revision lineage instead, see step 9.)
8. **Admit, then settle (network-hold fix, `fc4973fa`).** The v3.2 single run deadline was measured before the first POST. A retry accepted near that deadline could start a lease that outlived the hold. The protocol is now:
   - **8a. Admission clock.** After the baseline, the editor reads the server clock from the gate (`serverNow`, 30 s timeout). With no clock, nothing is sent; the outcome is `unknown` and the key is kept. Every POST of this run carries `admitBy = serverNow + 2 min` (`INSERTION_ADMISSION_WINDOW_MS`).
     - **Server enforcement.** T1 takes `stage_meta FOR UPDATE`, reads its clock *after* the lock, answers a replay first, then refuses `now > admitBy` with `409 INSERTION_ADMISSION_CLOSED` (audited). The lease starts at that same post-lock time, so any admitted run's lease ends by `admitBy + lease`.
     - **Service clamp.** The effective deadline is `min(admitBy, arrival + 5 min)` (`SCENE_INSERTION_MAX_ADMISSION_WINDOW_MS`). Every request therefore has a server-enforced admission deadline. `admitBy` is required (`400` without it).
     - **Digest.** `admitBy` is transport only and is not in the digest. A later run of the same request (same key, new deadline) replays.
   - **8b. Two separate bounds**, counted on a monotonic clock (`performance.now()`) from the arrival of the gate's answer:
     - *Retry budget*, `retryUntil = +2 min`: a POST may still start the run until then. After it, a POST could only replay.
     - *Safe release*, `releaseAt = retryUntil + 1080 s (longest lease) + 2 min grace`: any run this request started began by `admitBy`. T2 commits only inside its lease: it is checked in `'before'` and again in `'after'`, right before COMMIT. So past `releaseAt`, nothing of it can still commit. The hold ends no earlier than a definite answer or `releaseAt`.
   - **8c. Learn the row.**
     - POST the exact same body (same key, same `admitBy`) while within the retry budget. Each attempt has a 5 min timeout.
     - Reading and validating the body is part of the attempt (Finding 2). These are **ambiguous**:
       - a transport error or abort;
       - an interrupted body read;
       - invalid JSON;
       - a 2xx that is not a status envelope;
       - a 5xx, 408 or 429 without a TE envelope;
       - the TE's own `INTERNAL_ERROR`.
     - Any other coded TE error, or a code-less 4xx status line whatever its body, is a **refusal of that request**.
     - After an ambiguous attempt, the editor reads the key (`GET …/scene-insertions?key=`). This read creates nothing. It pins READ COMMITTED, runs under `stage_meta FOR SHARE` and reads the clock after the lock, so it waits for a T1 in progress and sees its row. Its 404 carries `details.serverNow`.
     - The key is settled when the TE names the row, or when it reports none with `serverNow > admitBy + 30 s` (a margin for a stepped-back TE clock). In that case no attempt of this run can ever start (`failed INSERTION_ADMISSION_CLOSED`, or the earlier refusal).
     - Some refusals are definite at once:
       - a refusal of the *only* request sent;
       - `IDEMPOTENCY_KEY_REUSED`.
     - A refusal of a *later* attempt waits for the key to settle, because an earlier attempt may still be in transit or queued on the lock. This includes a later `INSERTION_ADMISSION_CLOSED`, which settles through the margin.
   - **8d. A known row is settled by its id only**, never by another POST. It is polled while holding until it is terminal. A malformed read is transient. A plain 404 is transient. The TE's own 404 `INSERTION_NOT_FOUND`, or a 403 with a TE envelope, ends polling as `unknown`, because this tab cannot write the Stage either way.
   - **Past `releaseAt`**, one last read is made. By key, it queues behind any T2 still holding `stage_meta`. By id, its lazy reclaim waits for the row lock, which T2 holds until COMMIT, and settles an expired lease. The outcome is `unknown` only when that read fails.
   - `unknown` is therefore returned only when nothing was sent, when the last read past `releaseAt` failed, or after the TE refused the read itself.
9. **Apply the outcome**, still holding. On success, fetch first, then decide and apply synchronously (V3-1):
   - **(a) Fetch.** `const serverData = await loadStageData(stageId)`. This is the existing revision → document → revision sandwich (`stage-storage.ts:100-136,515-523`), and it changes no store state. **This is the last `await` before application.** No branch is chosen before it, and no dirty key captured before it is used.
   - **(b) Decide and apply in one synchronous step:** `applyInsertionResult(handle, serverData, baseline, { newSceneId, revTransitions })` (API 9). It re-checks the Stage and operation identity, re-reads the local scenes, recomputes `documentDirtSince(stageId, baseline.mark)` **at that moment**, and then:
     - clean apply when that set is empty;
     - otherwise the local-wins merge, over the dirt present at that moment, including any mutation that arrived **during the fetch** in either path.

     Its outcomes:
     - `'stale'`: the user moved to another Stage, the Stage reloaded, or the handle was released or superseded. The response is discarded with no state change. The server already holds the new scene, and the next load shows it.
     - `'unbound'`: as API 9 step 2.
     - `'applied'` / `'merged'`: the new scene is selected.

     **The local-wins merge** (API 9 step 5, V3.1-1) works on the current local state, the fetched server snapshot and the at-apply `dirty` set, over the **union** of local and server Scene ids. "Only the insertion touched S" means `baseline.revs[S] === revTransitions[S].before` **and** `serverData.sceneRevs[S] === revTransitions[S].after` (revision lineage; storage may normalize stored bytes, so content is not compared).

     | Scene | Local | Server | In baseline | Result | Binding |
     |---|---|---|---|---|---|
     | the new Scene | — | yes | no | added (structure dirt: next to its server neighbours, else by server order) | server revision |
     | clean, on both sides | yes | yes | — | server copy (structure dirt: kept at its local position) | server revision |
     | dirty, on both sides | yes | yes | — | **local content**, server `order` (structure dirt: local position); pending entry stays | server revision **only if only the insertion touched it**; else the old one stays → existing `409` + notice |
     | dirty, deleted elsewhere | yes | no | yes | **kept**, pending entry stays | **old expected revision kept** → the next save is refused (`409`, the Scene is gone) and the existing conflict path removes it with its notice; never re-created |
     | clean, deleted elsewhere | yes | no | yes | removed | binding removed (`setSceneRev(id, null)`) |
     | created here after the mark | yes | no | no | kept (structure dirt) | none (a creation) |
     | deleted here during the run (structure dirt) | no | yes | yes | stays deleted | server revision only if only the insertion touched it, so the next whole save deletes exactly what this tab saw; else the old one → `409` |
     | created elsewhere (structure dirt) | no | yes | no | not adopted | none → the next whole save's `409` recovery pulls it in (F44) |
     | created elsewhere (no structure dirt) | no | yes | no | added | server revision |

     With structure dirt the local list order wins and is renumbered `1..n`; the `structure` entry stays. Every binding is per Scene (`setSceneRev`); `bindStageSceneRevs` is used only by the clean apply.

     When another writer changed a Scene the tab also edited, the merge does **not** bind the newer revision, so the next save meets the existing `409` path (F44) and its existing notice. A genuine concurrent edit or deletion is never overwritten or dropped silently. Nothing the insertion itself caused replaces unsaved local content.
   - **(c) Failure:** the server made no change (§11.5). No fetch, no application, local state untouched.
   - **(d) Unknown** (polling gave up or a transport error after a 202): no fetch, no application, local state untouched. The dialog shows "status unknown" and keeps the key, so a later status read or re-POST replays the stored outcome (§11.6).
   - **(e) Fetch error after success:** retried up to three times while still holding; if every attempt fails, no application, local state untouched.
10. **Release** in `finally`, after `applyInsertionResult` has returned, or on any refusal or failure path. `handle.release()` lifts the lock, the hold and the deferral, then schedules held dirt (F57). Any direct save deferred during the run is now written through the normal flush, from the current store state. Then unsubscribe from conflicts.

**Recovery invariants:**
- No insertion path replaces local unsaved document content. The decision between clean apply and merge uses the dirt present at the synchronous application point, never earlier dirt. The only replacement left is the existing `409` conflict path, reached only when another writer changed or deleted the same scene (merge rule).
- A refusal before step 8 never sends a request.
- **While the handle is current** (v3.2, V3.1-2), no flush round and no direct aggregate save of the Stage from this tab is in flight or can start between the re-prove (step 6) and `release()`: the barrier holds the scheduler and `saveToStorage` defers. **Navigation is the documented exception:** `setStage` claims a new load token before its departure `persistDirtySnapshot`, so the handle is already not current when that write starts; it keeps its existing semantics (attempted, retried once, conflicts logged and dropped) and the late insertion result is discarded as `'stale'`. Writers outside the scheduler and `saveToStorage` (F61's list) are likewise outside this invariant; T2's sandwich/fence and the revision preconditions guard the server state against all of them.
- A stale response is discarded, not applied.
- A fetch error or an `'unbound'` result after a success leaves the local state as it was. Because any local dirt keeps its pending entry, the next save's `409` recovery pulls the server copy, including the new scene. The recovery's own conflict notice applies; the insertion adds no replacement (F44).

---

## 6. Server flow (order matters — R6)

```
POST /api/stages/[id]/scene-insertions
  1. grant: resolveRegenerationGrant(requireWrite)                   (§7)
  2. structural validation of the body (no DB reads beyond the grant)
  3. digest = sha256(canonical JSON of unitIds (sorted), afterSceneId, beforeSceneId,
                     teachingStage, instruction, reason)
  4. replay lookup by (versionId, idempotencyKey), scoped tenant+version+stage:
       same digest      → stored outcome (200 succeeded / 202 running / stored failure)
       different digest → 409 IDEMPOTENCY_KEY_REUSED
       none             → continue
  5. new-run checks (no writes): eligibility, unit resolution, coverage, anchors,
     allowed stage, exact-flow on the placeholder projection (§9.3),
     Skill pre-check on the live scenes (§10.8: validateSceneClassifications +
     validateSkillAssignmentStructure; governed only), route resolution
  6. T1 (authoritative, under the stage mutex)                         (§11.3)
  7. generation, no transaction open: planner → normalize → content → actions → candidate
  8. T2: sandwiched build → fenced atomic write (rebuild ≤ 3)          (§11.4)
     any failure after T1 → T3 (row failed, candidate kept, nothing else changes)
GET  /api/stages/[id]/scene-insertions?key=<k>            status by key (write grant)
GET  /api/stages/[id]/scene-insertions/[insertionId]      status by id  (write grant)
GET  /api/stages/[id]/scene-insertion                     gate
GET  /api/stages/[id]/content-units                       units + coverage
```

Step 4 runs **before** the coverage and adjacency checks. After a success whose response was lost, the units are already covered and the old anchors are no longer adjacent, so a retry checked against them first would be wrongly refused. Like regeneration, the POST ignores `req.signal`.

---

## 7. Authorization and eligibility

1. `resolveRegenerationGrant(headers, stageId, { requireWrite: true })` is reused as-is. It returns 404 for no grant or a version mismatch, and 403 `READ_ONLY_GRANT`. [V-code] `regeneration-grant.ts:41-65`.
2. The Stage owner must be `service:teaching-package`, and the version current and `draft` / `rejected`. This is checked again in T1 and T2.
3. **Eligibility** (gate and POST):
   - the version has a Teaching Model Flow;
   - it is not a legacy successor;
   - §8.1 returns `available` with at least one retained unit.

   Otherwise `INSERTION_NOT_SUPPORTED` with `reason` = `no_flow | legacy_successor | no_content_units`.
4. Every status read checks **tenant + version + Stage** against the row, the same as F47. Any mismatch is 404 `INSERTION_NOT_FOUND`.

---

## 8. Content units and coverage

### 8.1 All units of a version
Add the new function `readAllContentUnitsForVersion(versionId, scope)`. It mirrors the F5 walk exactly:
- tenant-scoped, cycle-guarded;
- **stops at the first version with a producing attempt**;
- that attempt must be `kafuo_normalized` with retained rows, or the result is `unavailable`.

Then it returns `readContentUnitsForAttempt(thatAttempt)`. The existing reader is unchanged.

### 8.2 Coverage (computed on read, never stored)
For each live scene, its cited ids follow Help's rule exactly (F8):
- If `sourceContentUnitIds` is present (even empty), use it, filtered to strings.
- Otherwise use the outline entry where `id === scene.outlineId`, never by order, with numeric ids turned into strings.

A unit is **covered** when a live **slide** cites it. Citations by other scene types are reported separately as `citedByOtherSceneIds`. "Uncovered" means instructional, retained, and cited by no live slide.

### 8.3 `GET /api/stages/[id]/content-units`
- Editor grants only: the `learner` and `preview` purposes are refused, as for writes.
- It applies the same learner refusal the regeneration gate route applies (`learnerRefusalWithoutAccessCode`, `app/api/stages/[id]/scene-regeneration/route.ts`).
- `Cache-Control: private, no-store`.
```json
{ "lineageStatus": "own_attempt",
  "units": [ { "id": "cu_12", "order": 3, "title": "…", "role": "EXPLANATION",
               "instructional": true, "textLength": 1840,
               "coveredBySlideIds": [], "citedByOtherSceneIds": ["scene_q1"],
               "covered": false } ] }
```
Unit **text** is never sent to the browser.

---

## 9. Position, stage and flow checks

### 9.1 Suggested position (panel entry)
For the first chosen unit by `order_index`:
1. Find the nearest preceding **covered** unit, and place the slide after the last live slide that cites it.
2. Otherwise find the nearest following covered unit, and place it before the first slide that cites it.
3. Otherwise append at the end.

The request carries the anchors `afterSceneId` / `beforeSceneId` (null at the start or end), not a number.

### 9.2 Allowed stages
Stage identity is the pair `(key, flowIndex)`; the key alone is not enough, because a key can repeat within a flow. Let `L` be the stage of `afterScene` and `R` the stage of `beforeScene`:
- inside a run (`L = R`): `{L}`;
- at a boundary: `{L, R}`;
- at the start: `{R}`; at the end: `{L}`.

Each candidate stays only if its flow entry's `scenePolicyFor` allows scene type `slide`. An `exactly_one` entry is excluded when it already holds a live scene, **counting live scenes of every type** at that `(key, flowIndex)`.

### 9.3 Exact flow, before T1 (no paid call yet) — R5
Build the **placeholder projection** from the real stored data:
- live scenes with `order >= at` shifted by `+1`;
- plus a placeholder scene `{ id: new_scene_id, order: at, teachingStage: chosen, outlineId: ins_… }`;
- the stored `outline.outlines` **as stored**, with no outline value replaced.

Run `validateExactTeachingFlow(projectedScenes, flow, storedOutlines)`. If it is invalid, refuse with `INSERTION_FLOW_INVALID` and put the violation `reason` and `offendingSceneIds` in `details`. This also refuses packages that are already broken (D-20), including a pre-existing `outline_scene_mismatch`, which is never hidden.

### 9.4 Policy diagnostics, after planning (tolerates old drift only)
1. Build the outline projection: for each live scene in order, its stored outline entry by `outlineId` **as stored** (its `teachingStage` untouched), with `order` set to the scene's order.
2. A scene with no resolvable entry is represented by an outline synthesized from the scene's own fields (type, title, `teachingStage`, slide semantics via `persistedSlideSemantics` `generation-tools.ts:253-274`, `sourceContentUnitIds`). This covers an earlier inserted scene and a blank "+" scene. There is no outline stage to hide, because its stage is the scene's.

This projection serves **scene-policy diagnostics only** (types, roles, visual, cardinality, sequence). Its `teachingSkills` values, historical or absent, are **never** read for Skill validation; that uses the scenes (§10.8, V2-1).
3. Add the normalized planned outline at `at`.
4. Run `teachingFlowDiagnostics(projection, flow, eligibleImages)` **after** and **before** (without the new outline).

**Stable identity:**
- Outline-scoped codes use `code | outlineId | field`.
- The stage-wide codes `FLOW_SEQUENCE_INVALID` and `POSITION_CARDINALITY` use `code | flowIndex`. Their first offending outline can change after an insert.
- Array indexes are never part of the identity.

**Rule:** refuse with `INSERTION_FLOW_POLICY_VIOLATION` when there is any diagnostic on the new `outlineId`, or any identity present after and not before. Identities present before are **tolerated pre-existing policy drift**, because submit does not check them (F15). `narrowDiagnosticsToPositionPolicy` supplies `allowedValues` for the message.

### 9.5 Repeated at T2 on the exact snapshot
§9.2, §9.3 (now with the real candidate instead of the placeholder) and §9.4 are recomputed on the document T2 builds and will persist (§11.4 step 3). A failure is a T3 with the same code.

---

## 10. Generation

### 10.1 Planner — `lib/server/teaching-package/plan-inserted-slide.ts`

**Inputs** (all server-derived except the instruction; the `reason` is never a parameter):
- the units' `title` and `normalized_text` in the `[[CONTENT_UNIT id=… order=… role=…]]` wrapper (`normalized-content-resource.ts:258-284`), capped at 12,000 characters in total;
- the flow entry: key, purpose, and `describeScenePolicy(scenePolicyFor(entry))`;
- the allowed Skills (governed);
- the previous and next slide **titles** only;
- the language and the spoken-register policy;
- the eligible visuals' ids and descriptions (§10.4);
- the instruction inside `<<<INSTRUCTION … INSTRUCTION>>>`, as untrusted text.

**JSON contract** (validated):

| Field | Rule |
|---|---|
| `title` | required; learner-visible |
| `keyPoints[]` | 3–6; learner-visible |
| `description` | required; planner guidance, non-display (F38) |
| `slideType`, `contentRole`, `contentKind?` | must pass `validateOutlineSlideSemantics` and the position policy |
| `visualPlan` | **required** when the position policy sets `visual` (mode `image` or `native`, F42), or for the `cover` + `orientation` opening (F41). Otherwise optional. `omitted` needs a specific `omissionReason` of 15 characters or more |
| `assistancePlan` | allowed only for `practice` / `check_understanding`. **Required** with `hint` and `explanation` for `practice` + `independent` (F41). Hidden: never copied into `title`, `keyPoints` or `description` |
| `suggestedImageIds[]` | subset of the eligible visuals |
| `teachingSkills` | governed: from the position's allowed set |

**The server fills these, never the model:** `id = ins_<nanoid>`, `order = at`, `type: 'slide'`, `teachingStage` (§9.2), and `sourceContentUnitIds` (the chosen ids).

**Prompt rules:** the solution path goes only in `assistancePlan`. Visible fields and `description` must not contain the answer or the explanation.

**Validation**, in order:
1. JSON shape.
2. `validateOutlineSlideSemantics`, which covers `assistancePlan` and `visualPlan` (F41).
3. Governed Skills: the §10.8 set over the **live persisted scenes plus the plan's selection carrier**, not over the §9.4 projection.
4. Normalization (§10.2).
5. §9.4.

**One corrective re-ask** carries only the validation messages and the same inputs, with no reason. Its answer is validated again by the same steps, with the same §10.8 inputs. A second failure is `INSERTION_PLAN_INVALID`. A §10.8 failure that names **only existing scenes** is not the planner's to fix: it gets no re-ask and is refused with `INSERTION_SKILLS_INVALID`.

### 10.2 Normalization (before content generation)
Run `normalizeSourceGroundedVisuals([plannedOutline], flow, eligibleImages)`. It gets **only** the eligible visuals linked to the chosen units, so F31's later fallbacks cannot pick an unrelated image. Its repairs are kept on the row. Everything from here on uses this **normalized outline**.

### 10.3 Content and actions
`insert-one-scene.ts` composes the exported functions regeneration uses, without changing regeneration:
1. `generateSceneContent` on `scene-content:slide` with the normalized outline. No caller `editDirective` and no caller `baselineContent`. The generator's own native-visual correction (F40) and assistance authoring (F39) run as they do today, and its leak checks stay in force.
2. `generateRegisterCompliantActions` on `scene-actions`: `refuseFallbackActions`, at most 3 attempts (F49), and an action context that includes a sentinel for the new scene (`generation-tools.ts:721-727` pattern).
3. `buildCompleteScene` with the minted scene id; then override `outlineId` to `ins_<nanoid>` (D-6); then `assertGeneratedSlideScene`.

### 10.4 Images — eligibility and scoping
- **Source:** `outline.sourceVisuals` of **this** Stage's stored outline record, read through the grant-resolved tenant, version and Stage. Bytes are served from that Stage's media folder (`servingPath`).
- **Eligible** means both of: the entry's `sourceContentUnitIds` intersects the chosen units; and `(await getVerdictStore()).get(resolveMoeBrandProfile().id, entry.sha256)` returns `verdict === 'approved'`.
  - `getVerdictStore()` is the verified factory (F48). It gives `PgVerdictStore(pool)` with `DATABASE_URL`, else a process-local `MemoryVerdictStore`. `VerdictStore` is only the interface and is never constructed.
- **Schema initialization:** the first `.get()` on the shared store runs the store's existing lazy, memoized `ensureVisualComplianceSchema`. That is idempotent `CREATE TABLE IF NOT EXISTS` DDL (`verdict-store.ts:14-30,52-58`), the same that every screening through the shared store already triggers (`visual-compliance/index.ts:45`). No new boot wiring is added. This DDL is not a screening call and calls no provider.
- **Fail closed:** a missing verdict (including every lookup on a `MemoryVerdictStore` in a DB-less dev process) or a non-approved one makes the image ineligible. **No `screenVisual` / `screenVisualWithDefaults` call and no vision-client call** on this path; `.put()` is never called (F48).
- Lifting uses the same mechanism as `scene-regeneration-images.ts` for `sourceVisuals` entries only.
- **Final check:** every image element on the candidate must map to an eligible entry, else `INSERTION_VISUAL_NOT_APPROVED`.
- [UNVERIFIED → A-13]: whether staging source visuals have cached approved verdicts. If they do not, the likely v1 outcome is that textbook images are never eligible and slides use native visuals.

### 10.5 Classification, Skills, alignment
Classification comes from the validated plan, and `assertGeneratedSlideScene` checks it on the built scene. Governed versions only (D-12):
1. Assemble the final document core (stage plus all scenes, with the candidate).
2. Run the same pure DSL `migrate` as the sink (`stage-persistence-sink.ts:105-108`).
3. On the **migrated** candidate, call `buildSceneAlignmentBaseline(scene, { origin: 'generation', now })`. Null → `INSERTION_ALIGNMENT_UNAVAILABLE`.
4. Persist **that** migrated document. Storage `saveDocument` migrates again (`pg.ts:665`); on an already-current document that is expected to be a no-op [UNVERIFIED → pg test: the new scene derives `current` after save].

Tier B gets no Skills and no baseline.

### 10.6 Narration
If `stageHasNarrationAudio`, add the `narrationAudioGap` mark, exactly as regeneration does (`regenerate-one-scene.ts:146-157`). It does not block submit (F19).

### 10.7 Candidate validation (built in T2, §11.4 step 3)
1. `type === 'slide'`. `teachingStage` is the chosen one, `sourceContentUnitIds` the chosen ids, and `outlineId` the minted one.
2. `assertGeneratedSlideScene`. `validateSceneActionStructure`. No fallback Actions.
3. Images per §10.4.
4. Governed: the §10.8 set over the T2 snapshot's live scenes, as loaded by the sandwich, plus the **real candidate scene**. Also a non-null baseline.
5. `validateAppScene`.
6. §9.5.

### 10.8 Skill validation inputs (V2-1)

**Rule:** whole-stage Skill validation always runs on **scenes**, which are the carrier that persists and that submit validates (F51). It never runs on outlines. Historical outline assignments never stand in for a scene's current assignment, and no synthesized outline is used.

**The set `S`** is:
- every live persisted scene of the Stage, **unchanged**: `id`, `teachingStage`, and its current `teachingSkills` (`primary`, `supporting`, `classification`), exactly as stored, including Skills a reviewer changed after generation and scenes that have no outline entry (earlier insertions, blank "+" scenes);
- the new scene's selection carrier `{ id: new_scene_id, teachingStage: chosen, teachingSkills: plan.teachingSkills }` during planning and re-ask, or the **real candidate scene** at T2.

**The validators.** The submit gate's deterministic checks, first failure wins (F52), plus the edit route's allowed-set check:
1. `validateFlowSkillPolicies(flow)`;
2. `validateFlowPolicySatisfiability(flow)`;
3. `validateSkillReferencesResolve(flow, S)`;
4. `validateOutlineSkillSelections(S, flow)` (allowed set, exact versions, required rules);
5. `validateRequiredSkillSatisfaction(S, flow)`;
6. `validateSkillAssignmentStructure(S, flow)`;
7. `validateSceneClassifications(S)`.

**When it runs:**

| When | `S` built from | On failure |
|---|---|---|
| **Pre-check**, before T1 (no paid call) | live scenes only. Run only the per-scene checks that a new slide cannot fix: `validateSceneClassifications` and `validateSkillAssignmentStructure` | `INSERTION_SKILLS_INVALID`, with `details.offendingSceneIds`. The reviewer fixes that scene's Skills first; the Skill edit route already blocks on the same condition (F16) |
| **After planning** and **after the re-ask** | live scenes from the document read for planning, plus the plan carrier | Failure naming the new id → re-ask (once), then `INSERTION_PLAN_INVALID`. Failure naming only existing scenes, or flow-level → `INSERTION_SKILLS_INVALID`, no re-ask. This happens before content generation, so it costs at most the planner calls |
| **T2** (§10.7 step 4) | the sandwich snapshot's live scenes plus the real candidate | T3, with the same code split. A scene whose Skills another tab changed during the run is validated with its new Skills |

**Classification of a failure** uses the validator's own `details.offendingSceneIds`. Requirement failures carry the scenes at the failing position plus `flowIndex` ([V-code] `skill-validators.ts:403-433`).
- If the list **includes the new scene's id**, the planner can fix it, so re-ask.
- If the list names only existing scenes, it is a pre-existing problem: `INSERTION_SKILLS_INVALID`.
- If the failure is flow-level with no scene scope (checks 1–2), it is a flow configuration problem: `INSERTION_SKILLS_INVALID`, and the new id is **not** attached.

---

## 11. Persistence

### 11.1 Table `teaching_package_scene_insertions` (E-1)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `tpsi_<nanoid>` |
| `tenant_id` | TEXT NOT NULL | CHECK `length > 0` |
| `version_id` | TEXT NOT NULL | FK → `teaching_package_versions`, ON DELETE RESTRICT |
| `stage_id` | TEXT NOT NULL | |
| `new_scene_id`, `new_outline_id` | TEXT NOT NULL | minted at T1 |
| `unit_ids` | JSONB NOT NULL | 1–3 ids |
| `after_scene_id`, `before_scene_id` | TEXT NULL | anchors |
| `teaching_stage` | JSONB NOT NULL | `{ key, flowIndex }` (`lib/types/teaching-package.ts:181-186`) |
| `idempotency_key`, `request_digest` | TEXT NOT NULL | |
| `instruction` | TEXT NOT NULL DEFAULT `''` | |
| `reason`, `actor_ref` | TEXT NOT NULL | CHECK non-blank |
| `session_ref` | TEXT NULL | |
| `status` | TEXT NOT NULL | CHECK `running`, `succeeded`, `failed` |
| `attempt_token` | TEXT NOT NULL | |
| `lease_expires_at` | DOUBLE PRECISION NOT NULL | epoch ms, as regeneration (F25); default 900 s, minimum 60 s |
| `planned_outline`, `outline_repairs`, `candidate_scene`, `result_scene` | JSONB NULL | `outline_repairs`: §10.2 normalization repairs |
| `result_scene_rev` | BIGINT NULL | |
| `scene_rev_transitions` | JSONB NULL | v3.2: `{ sceneId: { before, after } }` for every Scene the commit rewrote (the client's binding lineage) |
| `error_code` | TEXT NULL | |
| `register_policy`, `model_route` | JSONB NULL | |
| `requested_at` | DOUBLE PRECISION NOT NULL | epoch ms |
| `completed_at` | DOUBLE PRECISION NULL | epoch ms |

Indexes:
- `tpsi_version_key_unique` UNIQUE `(version_id, idempotency_key)`;
- `tpsi_single_running` UNIQUE `(stage_id) WHERE status = 'running'`.

All row timestamps are epoch ms numbers, so the `Number(row.…)` mapping used by regeneration applies unchanged.

### 11.2 Lock order (every insertion and regeneration path)
1. `stage_meta` FOR UPDATE.
2. `teaching_package_versions` FOR SHARE.
3. Operation rows (insertion / regeneration) FOR UPDATE.
4. Storage rows (`document_stages`, `document_scenes`, `document_outlines`), through the storage write.
5. `teaching_package_review_events` INSERT.

This matches the editor's grant writes (the precondition fence takes `stage_meta` first, F36) and regeneration T2 (F26). Locks are held until COMMIT.

### 11.3 T1 — start (one transaction; shared mutex — R2)
1. `SELECT … FROM stage_meta WHERE stage_id = $1 FOR UPDATE`. Check the owner and that the Stage is not deleted.
2. Version `FOR SHARE`: same tenant, `current_stage_id` = this Stage, editable.
3. **Reclaim expired leases in both tables for the whole Stage:**
   - insertion rows → `failed` / `LEASE_EXPIRED` + `scene_insertion_failed`;
   - regeneration rows → the existing `reclaimExpired` semantics (`failed` / `LEASE_EXPIRED`, `scene-regeneration-store.ts:283-325`), called with its **new Stage-wide scope option** (B-2).
4. **Replay** by `(version_id, idempotency_key)` `FOR UPDATE`: same digest → return the stored outcome; different digest → `IDEMPOTENCY_KEY_REUSED`.
5. Re-check the anchors, coverage and allowed stage on the live data (cheap reads; authoritative).
6. Running checks:
   - any running insertion on the Stage → `SCENE_INSERTION_IN_PROGRESS`;
   - any running regeneration on the Stage → `STAGE_GENERATION_IN_PROGRESS`.
7. INSERT the running row (new token, lease), and append `scene_insertion_started`.
8. COMMIT. Under the mutex the unique indexes are a backstop only. A violation of `tpsi_version_key_unique` re-runs step 4; a violation of `tpsi_single_running` maps to `SCENE_INSERTION_IN_PROGRESS`.

### 11.4 T2 — commit (R1)
1. **Build sandwich** (owner-bound service-owner store):
   1. `m1 = readFreshnessManifest(stageId)`;
   2. `doc = loadDocument(stageId)`, which is already migrated (F37);
   3. `m2 = readFreshnessManifest(stageId)`.

   If `m1.rev ≠ m2.rev`, repeat (at most 3 times), then T3 `INSERTION_STAGE_BUSY`. By F35, equal revisions prove that `doc` is exactly the state at `m2.rev`, including its outline.
2. **Re-check** on `doc`:
   - the anchors still exist and are adjacent;
   - the units are still uncovered;
   - the chosen stage is still allowed;
   - `new_scene_id` is not live.

   Failures are T3 `INSERTION_POSITION_CHANGED` or `INSERTION_UNIT_ALREADY_COVERED`.
3. **Build the final document:**
   - shift scenes with `order >= at` (`at = afterScene.order + 1`, or `beforeScene.order` at the start);
   - add the candidate (§10.3);
   - keep `doc.outline` **exactly as loaded**, not written differently (D-6);
   - migrate, then stamp the baseline (§10.5);
   - validate (§10.7, including §9.5).
4. **Fenced write.** Call owner-bound `saveDocument(finalDoc)` with `mutationFence = insertionCommitFence` (composed first) + `teachingPackageStageGuardFence()`.
   - **`'before'`**, in this order:
     1. `SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE` (the fence takes it itself, F36);
     2. the stage guard (version current and editable);
     3. the insertion row is `running`, with the same `attempt_token` and `lease_expires_at > now`, else `INSERTION_LEASE_LOST`;
     4. `readStageFreshnessManifest(stageId, queryable).rev === m2.rev`, else throw a retryable `StageRevisionMoved`.
   - **Body:** storage `saveDocument`, in the same transaction (F36): stage upsert, scene upserts, deletion of absent scenes (none, because the snapshot is current), and the outline written back unchanged.
   - **`'after'`:** the new scene is live with a revision. Read the manifest on the same queryable and record, for every Scene in `m2`, `{ before: m2 rev, after: rev now }`. `UPDATE` the row to `succeeded` with `result_scene`, `result_scene_rev`, `scene_rev_transitions` and `completed_at`, then INSERT `scene_insertion_completed`. COMMIT releases the locks.
5. **On `StageRevisionMoved`**, go back to step 1. There are at most 3 build attempts in total, and **no new AI calls**: the candidate is reused while step 2 and §10.7 still pass. Then T3 `INSERTION_STAGE_BUSY`. Deadlock and serialization errors (`40P01` / `40001`) are retried twice per attempt, as regeneration does.

Because the outline is written back exactly as `doc.outline` read at `m2.rev`, and the fence proves nothing committed since, the insertion cannot overwrite any concurrent change.

### 11.5 T3 — failure
Mark the row `failed` with `error_code`, keep `planned_outline` and `candidate_scene`, and append `scene_insertion_failed`. Nothing else changes. A refusal after the version is resolved but before T1 appends `scene_insertion_refused`, as regeneration does.

### 11.6 Idempotency and replay (R6)
- **Pre-T1 lookup** (§6 step 4) and the **authoritative T1 lookup** (§11.3 step 4) use the same `(version_id, idempotency_key)`. The status read applies tenant, version and Stage scoping.
- **Lost response after success:** the client re-POSTs with the same key. Step 4 returns `200` with the stored `result_scene` and `result_scene_rev`. The client then applies the result exactly as in §5.1 step 9: fetch, then synchronous `applyInsertionResult`.
- **Running:** `202` with the row id; the client polls.
- **Failed:** the stored error code and status. A new attempt needs a new key.
- **Different body, same key:** `409 IDEMPOTENCY_KEY_REUSED`. A Stage busy with another operation is `409 SCENE_INSERTION_IN_PROGRESS` or `STAGE_GENERATION_IN_PROGRESS`; these are distinct codes.

### 11.7 Interaction with regeneration and audio
- **Regeneration T1 changes (B-2, B-3):**
  - `stage_meta FOR SHARE` becomes `FOR UPDATE`;
  - after its own per-scene reclaim, it also reclaims expired **insertion** rows of the Stage;
  - after its running check, it refuses `STAGE_GENERATION_IN_PROGRESS` when a running insertion exists.

  The rest of regeneration is unchanged.
- **Audio, same tab:** `SlideNavRail` already tracks `regenerating` and `regeneratingAudio` (`SlideNavRail.tsx:83-89`). The new wiring disables "Generate with AI" and the panel buttons while either is non-empty, and disables slide/audio regeneration while the insertion dialog runs.
- **Audio, other tab**, decided by commit order:
  - Insertion first: the audio write sees a moved base revision and returns the existing `409 SCENE_REVISION_CONFLICT` (`scene-narration-audio.ts:158-206`). The paid TTS result is not written, and the reviewer retries.
  - Audio first: the insertion's fence sees the stage revision moved and rebuilds from the new state, so the audio is kept (§11.4 step 5).

### 11.8 Outline record and other tabs (R3)
- The insertion writes `doc.outline` back exactly as loaded. It adds no entry and shifts nothing (D-6).
- The new scene's `outlineId` resolves to nothing. The exact flow skips it (F14), coverage and Help use the scene's ids (F8), and a later regeneration of it seeds from the scene itself (with D-13, no order fallback).
- **Other tabs:** the insertion bumps every scene revision. Any later full save from a tab that has not resynced fails the whole-document precondition, because it lacks the new scene and has stale revisions. That tab's conflict recovery then pulls the new scene (F44). Its outline copy equals the server's, which is unchanged, so its eventual full save cannot drop anything the insertion wrote. This holds for tabs running JavaScript from before the deploy too, because it relies only on existing server checks.

---

## 12. Schema evolutions (TE boot — name E-1..E-3 to the owner before any push)

**E-1** — add `CREATE TABLE IF NOT EXISTS teaching_package_scene_insertions` plus both indexes (§11.1) to the boot DDL.

**E-2** — review events:
- Add `scene_insertion_started`, `scene_insertion_completed`, `scene_insertion_failed` and `scene_insertion_refused` to `REVIEW_EVENT_TYPES`. The fresh `CREATE TABLE` CHECK picks them up through `REVIEW_EVENT_TYPES_SQL` (F27).
- Leave the existing guarded DO block **unchanged**, and append a new block after it:
```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'teaching_package_review_events_event_type_check'
       AND pg_get_constraintdef(oid) LIKE '%scene_insertion_refused%'
  ) THEN
    ALTER TABLE teaching_package_review_events
      DROP CONSTRAINT IF EXISTS teaching_package_review_events_event_type_check;
    ALTER TABLE teaching_package_review_events
      ADD CONSTRAINT teaching_package_review_events_event_type_check
      CHECK (event_type IN (${REVIEW_EVENT_TYPES_SQL}));
  END IF;
END;
$$;
```
- The new CHECK is the full list, a superset of every existing value. On a very old database the old block already widens to the full list, and the new block then no-ops.

**E-3** — ledger:
- Fresh DDL: the `capability` CHECK lists `'package_generation','question_generation','help','free_chat','scene_regeneration','scene_insertion'`, and the table gains the column `scene_insertion_id TEXT`.
- Evolution: leave the existing block (guard `%scene_regeneration%`) **unchanged**, and append:
```sql
ALTER TABLE teaching_model_attempts ADD COLUMN IF NOT EXISTS scene_insertion_id TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'teaching_model_attempts_capability_check'
       AND pg_get_constraintdef(oid) LIKE '%scene_insertion%'
  ) THEN
    ALTER TABLE teaching_model_attempts
      DROP CONSTRAINT IF EXISTS teaching_model_attempts_capability_check;
    ALTER TABLE teaching_model_attempts
      ADD CONSTRAINT teaching_model_attempts_capability_check
      CHECK (capability IN ('package_generation','question_generation','help',
                            'free_chat','scene_regeneration','scene_insertion'));
  END IF;
END;
$$;
```
- On a database with the 5-value CHECK, the old block no-ops and the new block widens to 6. On a pre-regeneration database, the old block widens to 5 and then the new block to 6. A re-boot is a no-op.

**E-4** (no schema change): report grouping by `scene_insertion_id` (§14).

All of these apply at TE start. On staging that happens on the push-triggered deploy. Locally a restart needs the owner's yes.

---

## 13. Undo
There is no dedicated action in v1 (D-9). An editor delete removes the scene through the normal grant save, and there is no outline entry to clean up (D-6). F-3 can add one-click removal later.

---

## 14. Model calls, routing and attribution (R9)

### 14.1 Call budget per insertion (logical calls)

Corrected in v3 from source (F59–F60):

| Phase | Normal | Worst case | Source |
|---|---|---|---|
| Planner | 1 | 2: initial + one corrective re-ask | §10.1 |
| Canvas (slide content) | 1 | **3**: initial `generateCanvas` + native-visual correction + solution-leak regeneration | F59 (`scene-generator.ts:553-573,597-623,679-685`) |
| Assistance authoring (only with `assistancePlan`) | 1 | **2**: initial + re-author after a leak | F59 (`:640-650,688`; `slide-assistance.ts:113`) |
| Actions | 1 | 3: register attempts (F49); a fallback default ends the run, it is not retried | F59 |
| **Total logical calls** | **3** (4 with assistance) | **10** (2 + 3 + 2 + 3) | |

**Logical calls vs provider attempts:**
- A logical call is one `aiCall` invocation by the generator or the planner.
- Inside `execute`, each logical call makes **one or two provider attempts**: the primary, then on failure the fallback. A primary that lacks vision is skipped in favour of the fallback before any call (F28b). Each attempt is its own ledger row.
- So the worst case is **20 ledger rows**, and the typical case 3–4.
- T2 rebuilds make **no** calls.

JSON repair is a local parser and adds no model calls (F60). Nothing in this budget is deferred to implementation.

### 14.2 Insertion route adapter — `lib/server/teaching-package/routed-insertion-call.ts` (new)
- It follows `createRegenerationRoute`'s structure: the same subject-policy resolution, `SUBJECT_ROUTE_UNAVAILABLE` rules, `TEACHING_SUBJECT_ROUTING=off` behaviour and `assertAvailable` re-raise. Every `execute` call uses:
  - `capability: 'scene_insertion'`;
  - `association: { kind: 'generation', generationAttemptId: <producing attempt>, generationRun: null, versionId, learningItemType, learningItemId, sceneInsertionId: <row id> }`.
- **Every** callback goes through its `aiCallFor(stage)`: planner and re-ask, content, native-visual correction, assistance authoring and re-author, leak regeneration, and every register re-roll. The provider fallback is inside `execute`, so it inherits the same context.
- `routed-regeneration-call.ts` is **not** modified (D-18).

### 14.3 Ledger types and reporting
- `TeachingCapability` gains `'scene_insertion'`.
- The `generation` association gains `sceneInsertionId?: string | null`.
- The row type gains `scene_insertion_id`, and the INSERT column list and value mapping gain `scene_insertion_id` ← `generation?.sceneInsertionId ?? null`.
- `AttemptGroupBy` and `GROUP_BY_COLUMNS` gain `'scene_insertion_id'`.
- The report view groups `scene_insertion` spend by `scene_insertion_id`, next to the regeneration view. Existing views and regeneration rows are unchanged.

[V-code anchors] `teaching-model-attempts.ts:25-31,225-238,383,417-467,850-883`; `lib/server/teaching-model/report.ts:41,94`.

---

## 15. API contract

**Gate** `GET /api/stages/[id]/scene-insertion` (read or write grant; never writes):
```json
{ "capability": "write", "editable": true, "versionStatus": "draft",
  "supported": true, "unsupportedReason": null,
  "running": [ { "kind": "insertion", "id": "tpsi_…" } ], "serverNow": 1792700000000 }
```
`running` is an array of `{ kind: "insertion" | "regeneration", id, sceneId? }`, like the regeneration gate's `running` array, because several regenerations can run on one Stage. It is filled for write grants only. `serverNow` is the server clock; the editor's admission deadline counts from it (§5.1 step 8).

**Start** `POST /api/stages/[id]/scene-insertions`:
```json
{ "unitIds": ["cu_12"], "afterSceneId": "scene_a1", "beforeSceneId": "scene_b2",
  "teachingStage": { "key": "explain", "flowIndex": 3 },
  "instruction": "", "reason": "Unit 12 has no slide", "idempotencyKey": "…",
  "admitBy": 1792700120000 }
```
- `admitBy` (required): server time after which T1 refuses to start a run for this request (`409 INSERTION_ADMISSION_CLOSED`). The service enforces at most arrival + 5 min. It is not part of the request digest.
- `200 { insertion: Status, replayed }` — inserted, or the replay of a success.
- `202 { insertion: Status (status "running"), replayed: true }`.
- `Status` (as built, v3.2) = `{ insertionId, status, errorCode, newSceneId, resultSceneRev, scene, revTransitions, requestedAt, completedAt, leaseRemainingMs }`; `scene.order` is the new Scene's position; `leaseRemainingMs` is the time left on a running row's lease (`null` once terminal).
- Errors: `{ error: { code, message, details? } }` (§16).

**Status** `GET …/scene-insertions?key=` and `GET …/scene-insertions/[insertionId]` return `Status` (write grant; tenant + version + Stage scoped; a mismatch is `404 INSERTION_NOT_FOUND`). The by-key read runs under `stage_meta FOR SHARE` at READ COMMITTED, and its `404` carries `details.serverNow` (read after the lock). The editor trusts "no row" only when `serverNow > admitBy + 30 s`; then no run under that key exists or can start.

**Units** `GET /api/stages/[id]/content-units` (§8.3), as built: `{ lineageStatus, units: [{ …coverage, suggestedPosition }], positions: [{ afterSceneId, beforeSceneId, allowedStages }], stages: [{ key, flowIndex, label }] }` — one `positions` entry per gap, so the dialog shows the §9.2 stage rule without another round trip.

---

## 16. Error codes (new)

| Code | HTTP | When |
|---|---|---|
| `INSERTION_NOT_SUPPORTED` | 422 | no flow, legacy successor, or no retained units (`details.reason`) |
| `INSERTION_UNIT_INVALID` | 422 | unknown, non-instructional, textless, duplicate, or more than 3 units |
| `INSERTION_UNIT_ALREADY_COVERED` | 409 | a unit is covered by a live slide (at new-run checks, T1 or T2) |
| `INSERTION_POSITION_NOT_ALLOWED` | 422 | anchors not adjacent, or no allowed stage |
| `INSERTION_POSITION_CHANGED` | 409 | anchors or stage changed before T2 |
| `INSERTION_FLOW_INVALID` | 422 | the projected or final document fails `validateExactTeachingFlow` (§9.3, §9.5) |
| `INSERTION_FLOW_POLICY_VIOLATION` | 422 | a new policy diagnostic (§9.4) |
| `INSERTION_PLAN_INVALID` | 502 | the planner failed validation after one re-ask |
| `INSERTION_ALIGNMENT_UNAVAILABLE` | 422 | governed baseline is null (§10.5) |
| `INSERTION_SKILLS_INVALID` | 422 | whole-stage Skill validation fails on existing scenes or the flow, not on the new scene (§10.8); `details.offendingSceneIds` |
| `INSERTION_VISUAL_NOT_APPROVED` | 422 | the candidate has an image outside the eligible set (§10.4) |
| `INSERTION_STAGE_BUSY` | 409 | 3 build attempts without a stable revision (§11.4) |
| `INSERTION_LEASE_LOST` | 409 | the lease expired or the token changed |
| `INSERTION_ADMISSION_CLOSED` | 409 | the request reached T1 (after the Stage lock) past its admission deadline; audited; no run under its key can start any more |
| `INSERTION_NOT_FOUND` | 404 | status lookup outside tenant + version + Stage |
| `INSERTION_PERSISTENCE_FAILED` | 503 | as built: the slide was generated but the commit could not be recorded; nothing was written |
| `SCENE_INSERTION_IN_PROGRESS` | 409 | another insertion is running on the Stage |
| `STAGE_GENERATION_IN_PROGRESS` | 409 | a regeneration runs (for insertion), or an insertion runs (for regeneration, B-3) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | same key, different digest |

These are reused unchanged: `STAGE_LOCKED` (423), `READ_ONLY_GRANT` (403), `TEACHING_MODEL_UNAVAILABLE`, `SUBJECT_ROUTE_UNAVAILABLE`, `SPEECH_REGISTER_NONCOMPLIANT` and `SCENE_CONTENT_GENERATION_FAILED`. Arabic and English strings go under `edit.slideInsertion.errors.*`.

---

## 17. Files

**As built (v3.2).** Everything below landed, plus: `lib/server/teaching-package/stage-generation-mutex.ts` (the shared T1 helpers: Stage-wide insertion-lease reclaim and the running-insertion read, so neither store imports the other's T1); `lib/server/teaching-package/insertion-skill-validation.ts` (§10.8); `lib/server/teaching-package/errors.ts` (the §16 codes + `INSERTION_PERSISTENCE_FAILED`). The editing-lock guards landed in `slide-edit-session.ts` (covers `use-slide-surface.ts`, the canvas shortcuts and undo/redo through one choke point), `quiz-edit-session.ts`, `TeachingSkillsPanel.tsx`, `ThumbItem.tsx`, `ElementPickLayer.tsx`, `ActionsBar.tsx` ("Voice all") and the rail; the inventory with the deliberately unguarded entry points is in the implementation report (§4). The "Untouched" list held, except that the insertion **store** imports `readLiveScene` / `reclaimExpiredStageRegenerations` from the regeneration store (one direction only).

**New**
- `app/api/stages/[id]/scene-insertion/route.ts` (gate)
- `app/api/stages/[id]/scene-insertions/route.ts` (POST + GET by key)
- `app/api/stages/[id]/scene-insertions/[insertionId]/route.ts`
- `app/api/stages/[id]/content-units/route.ts`
- `lib/server/teaching-package/scene-insertion.ts` (service, order of §6)
- `lib/server/teaching-package/scene-insertion-store.ts` (T1/T2/T3, sandwich, fence, reclaim, replay)
- `lib/server/teaching-package/plan-inserted-slide.ts`
- `lib/server/teaching-package/insert-one-scene.ts`
- `lib/server/teaching-package/content-unit-coverage.ts` (citations, coverage, position suggestion, allowed stages, projections, diagnostic identities)
- `lib/server/teaching-package/routed-insertion-call.ts`
- `lib/edit/scene-insertion-client.ts`
- `components/edit/GenerateSlideForPartDialog.tsx`
- `components/edit/LessonPartsPanel.tsx`

**Changed**
- `lib/persistence/teaching-package.ts` — E-1, E-2, `readAllContentUnitsForVersion`
- `lib/persistence/teaching-model-attempts.ts` — E-3, capability, association, INSERT mapping, group-by
- `lib/server/teaching-model/report.ts` — E-4
- `lib/server/teaching-package/scene-regeneration-store.ts` — B-2 (`FOR UPDATE`, Stage-wide `reclaimExpired` scope option, insertion-lease reclaim) and B-3
- `lib/server/agent-runtime/generation-tools.ts` — D-13 (B-1)
- `lib/types/teaching-package.ts` — event types
- `components/edit/SlideNavRail/SlideNavRail.tsx`, `InsertionZone.tsx` — third choice, panel entry, same-tab mutual disabling, and refusal while `isStageEditingLocked`
- `lib/store/stage.ts` — new APIs (§5.1):
  - `DOCUMENT_CHANGE_KINDS`;
  - the `directDocumentSaves` registry;
  - `isStageDocumentDurable` (including direct saves);
  - `drainStageDocumentWrites`;
  - `pendingDocumentRevisionMark` / `documentDirtSince`;
  - `peekStageSceneLoadToken`;
  - `beginStageInsertion` (`operationId`, `lock`, `holdWrites` through the existing `regenerationBarriers` plus the hold flag, `isCurrent`, `release`), with `isStageEditingLocked` / `useStageEditingLocked`;
  - the synchronous `applyInsertionResult` (clean apply + local-wins merge);
  - a shared `fullAggregateChanges(state)` helper extracted from `restorePendingStageChanges`, with unchanged behaviour.

  It also gets **two scoped changes to `saveToStorage`**: synchronous registration of its promise in the registry, and deferral into full-aggregate dirt while an insertion holds that Stage. Outside an insertion hold, `saveToStorage` behaves exactly as today.

  `flushStageSave`, `isSceneDurable`, `beginSceneRegeneration`, `resyncStageScenesFromServer` and conflict recovery keep their behaviour. The insertion client does not call `resyncStageScenesFromServer`.
- Edit surfaces that must honour the editing lock, including undo/redo and keyboard shortcuts: `components/edit/surfaces/slide/use-slide-surface.ts`, `components/edit/surfaces/slide/slide-edit-session.ts`, `components/edit/surfaces/quiz/*`, `components/edit/EditDock/TeachingSkillsPanel.tsx`. The full list was inventoried in W4a/W4b (implementation report §4)
- `components/edit/RegenerateSlideDialog.tsx` — B-4
- `lib/i18n/` — strings

**Untouched (explicitly):** `@openmaic/generation`; `@openmaic/storage`; `app/api/persistence/[...path]/route.ts`; `lib/utils/stage-storage.ts` (its `loadStageData` sandwich is reused as is); `lib/server/tutor/help-service.ts`; `routed-regeneration-call.ts`; `regenerate-one-scene.ts`; `lib/server/teaching-package/scene-skills.ts` and `skill-validators.ts` (validators are called, not changed); `lib/server/visual-compliance/*` (only `getVerdictStore().get` is called); submit and lifecycle rules; backend, admin and mobile. `lib/store/stage.ts` is **no longer** on this list (v3).

---

## 18. Tests (as built; run only these files)

**As built (v3.2).** The files below exist and pass, with these differences: the T2 rebuild, the build cap, E-1/E-2 widening and the lazy reclaim run on PGlite in `tests/teaching-package/scene-insertion-store.test.ts`; E-3 widening (5 → 6 and 4 → 5 → 6 values, re-boot no-op) and the E-4 view in `tests/usage/reporting-queries.test.ts`; the true two-connection races (insertion vs regeneration T1 in both orders, a commit racing T2) stay in the **gated** `scene-insertion-store.pg.test.ts` (skipped without `PG_CONTRACT_URL`); the governed "born submit-ready" path, two consecutive insertions and `submitForReview` run in `scene-insertion-route.test.ts`; the V3.1-1 deletion cases and the V3.1-2 navigation case are in `tests/store/stage-insertion-durability.test.ts` and `tests/edit/scene-insertion-client.test.ts`; `tests/agent-runtime/outline-from-scene.test.ts` covers D-13; `tests/components/edit/lesson-parts-panel.test.ts` covers the panel. "A mark between prove and hold" has no window to test: the prove, the hold and the re-prove run in one synchronous turn (the re-prove stays as a defence). Exact commands and counts: implementation report §6.

**New:**
- `tests/teaching-package/content-unit-coverage.test.ts`:
  - Help-parity citations: an empty array stays empty; strings only; outline fallback by `outlineId` only; numeric to string;
  - slide-only coverage;
  - position suggestion;
  - allowed stages by `(key, flowIndex)`, with cardinality counting every scene type;
  - the placeholder projection;
  - diagnostic identities (array index ignored; stage-wide codes by `flowIndex`).
- `tests/teaching-package/plan-inserted-slide.test.ts`:
  - inputs: text cap, delimiters, **reason absent from the prompt and the re-ask**;
  - conditional `visualPlan` / `assistancePlan`;
  - independent practice requires `hint` + `explanation`;
  - no solution text in visible fields;
  - one re-ask;
  - Skills from the allowed set.
- `tests/teaching-package/insert-one-scene.test.ts`:
  - no caller `editDirective` / `baselineContent`;
  - normalization gets only eligible images;
  - assistance authored for independent practice;
  - fallback actions refused;
  - narration mark;
  - `outlineId` override.
- `tests/teaching-package/routed-insertion-call.test.ts`: every callback (planner, re-ask, content, visual correction, assistance, re-author, register re-rolls) records `scene_insertion` + `sceneInsertionId`; fallback rows inherit it.
- `tests/teaching-package/scene-insertion-route.test.ts`:
  - grant and eligibility;
  - **replay before new-run checks** (lost response after success → 200);
  - key conflict vs running conflict;
  - status scoping;
  - error mapping.
- `tests/teaching-package/scene-insertion-store.pg.test.ts` (disposable `PG_CONTRACT_URL` only, never the dev DB):
  - a scene created, or a text edit made, **between the document read and the revision read** → rebuild, no loss;
  - a write committing between the build and the fence → rebuild;
  - concurrent insertion T1 and regeneration T1 starts → exactly one runs, **in both orders**;
  - expired-lease reclaim in both directions;
  - the T2 snapshot fails exact flow → T3;
  - the outline record is byte-equal before and after;
  - the new scene derives `current` after save;
  - E-1/E-2/E-3 on fresh **and** old schemas (5-value capability CHECK → 6; old review-event CHECK widened), and a re-boot no-op.
- `tests/edit/scene-insertion-client.test.ts`:
  - hold, poll, then fetch and the synchronous `applyInsertionResult` (never `resyncStageScenesFromServer`);
  - a stale tab's full save after an insertion → 409 → recovery pulls the new scene → its next save keeps the new scene and the outline;
  - **preparation** (§5.1 steps 1–6):
    - a non-anchor scene whose save failed (pending `scene:<id>` left after `flushStageSave` resolves) → refused, no POST, local edit kept;
    - pending `structure` dirt → refused, no POST;
    - a flush round in flight during preparation → proceeds only after the round settles and the re-prove passes, otherwise refused;
    - **a direct aggregate `saveToStorage` still running when preparation starts** (V3-2) → the drain awaits it. If it is still registered at the prove, the insertion is refused, with no POST. If it settled, the prove passes;
    - a save conflict published during the drain → refused;
    - a mark between prove and hold → the re-prove refuses;
    - `saveToStorage` called after the hold → writes nothing, re-marks the full aggregate, returns `false`; after `release()` the normal flush writes it;
  - **result application** (§5.1 step 9, V3-1):
    - a mutation arriving **during the clean-path fetch** → `applyInsertionResult` sees the dirt and merges, and the local edit is kept;
    - on a run that is already dirty, **an additional mutation during the fetch** → that key is included in the at-apply dirty set and kept, which proves the keys are recomputed after the fetch;
    - **Stage navigation** during the fetch, or a **stale operation** (handle released, superseded, or load token moved) → `'stale'`, no state change, no revision binding;
    - after a clean apply, every scene's bound revision equals `serverData.sceneRevs`, so the next save passes the precondition. After a merge, revisions are bound only where the server copy equals `baseline`, and the next save writes the local edit on top;
    - a missing `sceneRevs` → `'unbound'`, no change;
    - failure, unknown or fetch error → no application, local state byte-equal.
- `tests/store/stage-insertion-durability.test.ts` (new):
  - `isStageDocumentDurable` over every pending kind (`currentScene` / `chats` never block), the flush round, and a registered direct save;
  - `saveToStorage` registers synchronously before its first await and unregisters in `finally`, on success, failure and stale-drop;
  - `drainStageDocumentWrites`;
  - `documentDirtSince` evaluated at call time;
  - `beginStageInsertion` lock, hold flag, `isCurrent()` (released, superseded, Stage switch, load-token change) and its interaction with `regenerationBarriers`;
  - the `saveToStorage` deferral only while held;
  - edit surfaces refuse while locked, including undo/redo;
  - `applyInsertionResult` is synchronous (no await), covering clean and merge cases including structure dirt;
  - `fullAggregateChanges` equals the previous `restorePendingStageChanges` descriptor set.
- `tests/teaching-package/skill-validation-inputs.test.ts` (new, V2-1):
  - `S` is built from scenes, with current `teachingSkills` preserved;
  - outline history is ignored;
  - a scene with no outline entry passes when its Skills are valid;
  - the failure split: new id → re-ask, existing-only → `INSERTION_SKILLS_INVALID`, flow-level → `INSERTION_SKILLS_INVALID`, with no new id attached;
  - the pre-check runs only the per-scene checks;
  - T2 uses the snapshot's scenes.
- `tests/components/edit/generate-slide-for-part-dialog.test.ts`.

**Existing to re-run (paths verified):**
- `tests/teaching-package/regenerate-one-scene.test.ts`, `scene-regeneration-route.test.ts`, `scene-regeneration-store.pg.test.ts` (B-2/B-3), `routed-regeneration-call.test.ts` (unchanged behaviour), `revision-precondition.test.ts`;
- `tests/edit/scene-regeneration-client.test.ts`, `tests/edit/narration-audio-client.test.ts`;
- `tests/components/edit/regenerate-slide-dialog.test.ts`;
- `tests/agent-runtime/generation-tools.test.ts` and `generation-tools-governed.test.ts` (B-1, including `generate_actions`);
- `tests/store/stage-insert-scene-after.test.ts`, `tests/store/stage-regeneration-barrier.test.ts` (`beginStageInsertion` reuses `regenerationBarriers`), `tests/document-store/slide-nav-rail-teaching-stage.test.ts`;
- for the scoped `saveToStorage` change and the extracted `fullAggregateChanges` helper (V3-2): `tests/store/stage-document-persistence.test.ts`, `tests/store/stage-deletion-aggregate-recovery.test.ts`, `tests/classroom/load-classroom.test.ts`, `tests/classroom/read-only-grant-autosave.test.ts` (paths verified to exist). Their behaviour outside an insertion hold must be unchanged;
- `tests/usage/reporting-queries.test.ts`.

**Static:** `eslint` and `prettier --check` on touched files only. No full suites.

---

## 19. Implementation waves

| Wave | Content | Depends on |
|---|---|---|
| W0 | D-13 (after the owner's yes on B-1) + generation-tools tests | — |
| W1 | E-1..E-3, types, `readAllContentUnitsForVersion`, insertion store (T1/T2/T3, sandwich, fence), regeneration T1 changes B-2/B-3, pg tests | W0 |
| W2 | Coverage helper, position, allowed stages, projections, identities; `GET content-units`; gate | W1 |
| W3 | Planner, normalization, Skill validation inputs (§10.8), insert-one-scene, routed-insertion-call, service, POST/status routes | W2 |
| W4a | Store APIs in `lib/store/stage.ts` (§5.1) + their tests: the direct-save registry with the scoped `saveToStorage` registration and hold deferral; `drainStageDocumentWrites`; `isStageDocumentDurable`; `beginStageInsertion` with `isCurrent`; the synchronous `applyInsertionResult`; the `fullAggregateChanges` extraction. Re-run the existing `saveToStorage` tests. **Inventory every editor mutation entry point** (including undo/redo and shortcuts) **and every `saveToStorage` caller**, and confirm the four in F61 are all of them. Wire the editing lock into each mutation entry point, and record both lists in the implementation report | W3 |
| W4b | UI: panel, "+" choice, dialog, `scene-insertion-client.ts` protocol (§5.1), same-tab disabling, i18n, B-4 | W4a |
| W5 | Report view E-4; implementation report | W3 |

W0–W3 touch shared persistence and generation seams, so they are sequential. W4a must land before W4b, because the client protocol depends on the store APIs. W5 can run in a separate worktree after W3, in parallel with W4a/W4b.

**As built (v3.2):** all waves are done. Order actually taken: W0 → W4a → the W4b client protocol → (W4b UI in a separate worktree, in parallel) W1 → W2 → W3 → W5 → integration. The W4a `saveToStorage` inventory found that the four callers are **not** every document writer (F61); the V3.1-2 policy scopes the invariant accordingly instead of claiming otherwise.

---

## 20. Acceptance checks (staging, after the owner's yes; none run yet)

- **A-1** Read-only count of `teaching_package_content_units` rows for the target versions (F4).
- **A-2** Governed draft: insert inside a run. The slide has the unit id, Skills and a `current` alignment, and **Submit passes**.
- **A-3** The same at a boundary, choosing the right-hand stage.
- **A-4** A full `exactly_one` position is refused (`INSERTION_POSITION_NOT_ALLOWED`). A version that already fails the exact flow is refused (`INSERTION_FLOW_INVALID`).
- **A-5** Regeneration and insertion started together from two tabs: exactly one runs, in both orders.
- **A-6** Edit another slide during the run: the insertion succeeds and the edit is kept. Move a neighbour: `INSERTION_POSITION_CHANGED`.
- **A-7** After the insertion:
  - (a) a structural save (delete or reorder) in the same tab;
  - (b) a structural save from a second tab opened **before** the insertion;
  - (c) the same from a tab opened **before the deploy** (old JavaScript).

  Each time the new slide survives, and the outline record is unchanged. Then regenerate a shifted slide: it seeds from its own outline entry (B-1).
- **A-8** Voiced package: the audio red card appears, and "إعادة توليد الصوت" fixes it. Audio and insertion run in two tabs in both commit orders: nothing is silently lost.
- **A-9** Ledger: every provider call of a run is a `scene_insertion` row with `scene_insertion_id`. The reason text appears in no model input.
- **A-10** Mobile plays the slide in order, and Help on it cites the unit.
- **A-11** The planner returns valid JSON on the routed model for the subject.
- **A-12** Lost response: kill the client after the POST, then re-POST with the same key → 200 with the stored scene.
- **A-13** Approved cached verdicts exist for the target source visuals, or the slide uses a native visual.
- **A-14** Independent-practice position: the slide carries assistance, and the canvas does not show the solution.
- **A-15** (V2-1) **Two consecutive insertions** on the same governed Stage. The second succeeds, and its Skill validation sees the first inserted scene's own `teachingSkills`, which has no outline entry. Submit passes.
- **A-16** (V2-1) A reviewer changes an existing scene's Skills through the Skills panel, then inserts. Validation uses the changed Skills, not the outline's generation-time selection. Submit passes.
- **A-17** (V2-1) A valid existing scene whose outline entry is absent (an earlier insertion, or a blank "+" scene given Skills and confirmed): the insertion is not refused because of it.
- **A-18** (V2-2) Make a **non-anchor** slide's save fail (for example, the network offline for that save), then start an insertion near another slide. It is refused as "unsaved changes", nothing is sent, and the local edit is still there after reconnecting and saving.
- **A-19** (V2-2) Pending structural change (reorder not yet saved) → the insertion waits for the drain, or is refused if the drain fails. The reorder is never lost.
- **A-20** (V2-2) Start the insertion while an autosave is in flight. It proceeds only after the round settles and the Stage is re-proven durable; otherwise it is refused.
- **A-21** (V2-2) Clean Stage: the insertion succeeds, the synchronous clean apply shows the new slide and the shifted orders, and no unrelated slide content changes.
- **A-22** (V3-1) A local edit lands **during the clean-path fetch** (test hook or slowed network): the edit is still there after the insertion is applied, and is saved afterwards.
- **A-23** (V3-1) On a run where dirt already exists, a **second** edit lands during the fetch: both edits survive.
- **A-24** (V3-1) Switch to another lesson while the fetch is running: the response is discarded, nothing changes in the other lesson, and reopening the original lesson shows the new slide.
- **A-25** (V3-1) After a clean apply or a merge, the next save goes through **without** a `409` for scenes whose server copy equals the baseline, which shows the revisions were bound correctly.
- **A-26** (V3-2) A **direct aggregate save** (for example a server-restore hydration `saveToStorage`) is still running when the reviewer starts an insertion. The insertion waits for it, or refuses if it has not settled. It never POSTs while that save is in flight.
- **A-27** (V3.1-2) With an edit that bypassed the lock held during a run, navigate to another lesson: the departure save runs under its existing semantics (kept if it lands before T2's commit — T2 rebuilds around it — else its revision conflict is logged and dropped), the insertion's late result is discarded, and reopening the lesson shows the new slide.
- **A-28** (V3.1-1) In tab A edit slide X during the run; in tab B delete X. After A's merge X is still visible in A with its edit; A's next save is refused and the existing conflict notice appears, after which X is gone — never re-created. In a second run, delete an unedited slide Y in tab B: A drops Y quietly and its next save passes.

---

## 21. Deploy order and gates
1. OpenMAIC only. This task was authorized to push the feature branch `codex/reviewer-generated-slide-for-lesson-part` (unmerged). Landing it on `staging` is a separate step under the workspace rule: `git fetch` and rebase first, then check `git log origin/staging..HEAD`.
2. **E-1..E-3 apply at TE boot** wherever the branch's code first starts — on the staging deploy once it lands on `staging`. A feature-branch push triggers no workflow (`ci.yml` / `staging-te.yml` triggers checked).
3. B-1..B-4 were authorized by the owner for this task.
4. Pending gates: the disposable-PostgreSQL suites (`scene-insertion-store.pg.test.ts`, `scene-regeneration-store.pg.test.ts` — need `PG_CONTRACT_URL`), required CI on the branch, A-1..A-28 on staging, and a Codex re-review of the implementation.

---

## 22. Side effects and limitations (R7)
- **B-1 reach:** `outlineFromScene` also seeds agent `generate_actions` (`generation-tools.ts:827`) on owner (non-package) stages. With id-first matching, a scene whose `outlineId` has no entry gets no planned fields there either, where today it may silently borrow another entry's by order.
- **Restore after a later whole-document write:** every whole-document write rewrites every scene row and bumps every revision (F35). That includes this insertion and the editor's own "+", delete and reorder. So a Restore of an earlier regeneration is refused with `SCENE_CHANGED_SINCE_REGENERATION` (F46), even for a slide whose content and order did not change. This is existing behaviour for every structural edit. **The guard is kept**, and the dialog's message already explains it.
- **Order fallback for scenes without `outlineId`** (for example blank "+" scenes) remains unsafe. The insertion shifts scene orders and not outline orders (D-6), so such a scene's order fallback may now point at a different entry than before. Generated package scenes always carry an `outlineId` (`scene-builder.ts:71,99,118,143`). Whether any historical eligible package scene lacks one is [UNVERIFIED → data check, needs a yes].
- **A later regeneration of an inserted slide** seeds from the scene itself: its title, its canvas as the edit baseline, carried assistance (`generation-tools.ts:229-238`), and persisted slide semantics. It loses the planner's `description` and `keyPoints`, which stay only on the insertion row.
- **Tenant cost:** there is no tenant-wide quota. Serializing per Stage is not a quota (F32).

---

## 23. Pre-existing findings (not changed here unless listed in §4.1)
- **P-1** The `outlineFromScene` `||` match (F23): fixed by D-13 (B-1).
- **P-2** The stale comment at `regenerate-one-scene.ts:125-127` (F7): not touched (D-19).
- **P-3** `assertOutlineContentUnitGrounding` is test-only, and its code is still in the runner's retryable list (`outline-grounding.ts:78-119`; `generation-runner.ts:903`): not touched.
- **P-4** Agent `edit_deck` inserts without `teachingStage` (`course-edit/tools.ts:184-200`): not touched.
- **P-5** The §16 test paths in `single-slide-regeneration-plan.md` are wrong: not touched.
- **P-6** A governed blank "+" scene cannot pass submit until it gets Skills and an alignment confirmation (F20): not touched; this feature is the governed-safe path.
- **P-7** Any server-side outline change is overwritten by the next client full save (F24). This plan avoids it by design (D-6) and does not fix it.

---

## 24. Follow-ups
- **F-1** A second slide for an already-covered unit.
- **F-2** A quiz for a lesson part.
- **F-3** One-click "Remove generated slide".
- **F-4** Optional TTS inside the run.
- **F-5** Coverage gaps on the admin package card (read-only).
- **F-6** Make the outline record server-authoritative for grant sessions (P-7), if a later feature needs to write outlines.

---

## 25. Remaining UNVERIFIED items and status
- **UNVERIFIED by reading, provable only at runtime or by data:**
  - A-1: retained rows on staging;
  - A-11: planner JSON quality on the routed model;
  - A-13: cached approved verdicts;
  - a historical eligible scene without an `outlineId` (§22);
  - a re-migration no-op on save (§10.5);
  - every concurrency and acceptance behaviour in §20 on real infrastructure, including A-15..A-28 (focused unit and PGlite tests cover their logic, §18; true two-connection races need the gated pg suite).
- **Settled by the implementation (v3.2):**
  - The editor mutation entry points that honour the editing lock are inventoried in the implementation report. Entry points left unguarded are listed there with the reason; the safety nets are the at-apply dirt check in the synchronous `applyInsertionResult` and T2's rebuild.
  - The four `saveToStorage` callers are **not** every document writer (F61's list): the registry covers every `saveToStorage` caller because registration lives inside it, and the other writers are outside the handle-scoped invariant by the documented V3.1-2 policy.
- **Resolved in v3 by reading** (no longer open):
  - generator call counts (F59);
  - JSON repair is local, with no model call (F60);
  - the verdict store factory and its lazy schema ensure (F48);
  - Skill carriers are scenes (F51–F53);
  - the Stage-wide durability gaps in the existing client APIs (F54–F58).
- **Resolved in v3.1 by reading:**
  - direct aggregate saves bypass both the pending map and the flush round, and their callers are known (F61);
  - the existing resync awaits its read and then replaces scenes with no dirt check, and load tokens can detect navigation (F62).
- **Owner decisions:** B-1..B-4 (§4.1) and the E-1..E-3 source evolutions were authorized for this task. Decisions D-1..D-21 are closed but open to objection.
  - D-21 adds store APIs and one scoped `saveToStorage` change, active only while an insertion holds the Stage. It does not change existing behaviour outside that window, so it is not a B-item.
  - The editing lock and the `saveToStorage` deferral do change what the editor does **during an insertion run only**. The owner may object to that under D-21.
- **Status:** implemented W0–W5 on the feature branch; focused tests pass; not runtime-verified. This document makes no merge-readiness or release-readiness claim; the gates of §21 stay pending.
