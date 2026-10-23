# Reviewer-Generated Slide for a Lesson Part — Implementation Report

| Attribute | Value |
|---|---|
| Date | 2026-10-23 |
| Plan | `reviewer-generated-slide-for-lesson-part-plan.md` v3.2 (as implemented); v3.1 + the v3.1 re-review (V3.1-1, V3.1-2) were the inputs |
| Review report | `reviewer-generated-slide-for-lesson-part-plan-review.md` — kept unchanged as historical evidence |
| Branch | `codex/reviewer-generated-slide-for-lesson-part`, from `origin/staging` at `eae05f4c` |
| Scope | W0–W5, B-1..B-4, E-1..E-3 (authorized by the owner for this task) |
| Status | Implemented; focused tests pass; independent review done (§7); **not runtime-verified** (§8) |

## 1. What was built

| Wave | Delivered | Main files |
|---|---|---|
| W0 | D-13 id-first `outlineFromScene` (B-1) | `lib/server/agent-runtime/generation-tools.ts` |
| W1 | E-1 table `teaching_package_scene_insertions` (+ `scene_rev_transitions`, `outline_repairs`); E-2 `scene_insertion_*` events with a guarded superset CHECK block; E-3 ledger `scene_insertion` + `scene_insertion_id` with its own guarded block; `readAllContentUnitsForVersion`; insertion store T1/T2/T3; regeneration T1 `FOR UPDATE` + insertion-lease reclaim + refusal while an insertion runs (B-2, B-3) | `lib/persistence/teaching-package.ts`, `lib/persistence/teaching-model-attempts.ts`, `lib/types/teaching-package.ts`, `lib/server/teaching-package/scene-insertion-store.ts`, `stage-generation-mutex.ts`, `scene-regeneration-store.ts`, `errors.ts` |
| W2 | Help-parity citations, coverage, positions, allowed `(key, flowIndex)` stages, projections, diagnostic identities; `GET content-units`; gate | `content-unit-coverage.ts`, `app/api/stages/[id]/content-units`, `app/api/stages/[id]/scene-insertion` |
| W3 | Planner (one re-ask), §10.8 Skill validation over live Scenes + the carrier, normalization, policy diagnostics, insert pipeline, routed adapter, service, POST/status routes | `plan-inserted-slide.ts`, `insertion-skill-validation.ts`, `insert-one-scene.ts`, `routed-insertion-call.ts`, `scene-insertion.ts`, `app/api/stages/[id]/scene-insertions/**` |
| W4a | Store APIs: direct-save registry, deferral while held, Stage-wide durability, drain, editing lock, insertion handle, synchronous `applyInsertionResult` with the union merge | `lib/store/stage.ts` |
| W4b | Client protocol; UI (panel, dialog, "+" choice, same-tab mutual disabling, lock guards, i18n, B-4) | `lib/edit/scene-insertion-client.ts`; UI files in §4 |
| W5 | Report view E-4 (`sceneInsertion.perInsertion / perVersion`) | `lib/server/teaching-model/report.ts` |

## 2. V3.1-1 — server-deleted Scenes in the local-wins merge

- The merge runs over the **union** of local and server ids, classified with the baseline's id set (plan §5.1 step 9 table). Implementation: `mergeInsertionScenes` + `applyInsertionResult` in `lib/store/stage.ts`.
- **Dirty, deleted elsewhere:** kept with its pending entry; its old expected revision is **not** touched. The next per-Scene `PUT` carries an expectation for a Scene that is gone, which `revisionConflicts` refuses (`revision-precondition-fence.ts`: not live + expectation → conflict), so the existing conflict path removes it with its notice — never a silent drop, never a re-creation.
- **Clean, deleted elsewhere:** removed and `setSceneRev(id, null)`.
- **Structure dirt + deletions:** the local list wins; a clean remote deletion is still removed; a dirty one is kept; a Scene deleted here stays deleted (its expectation moves only when nobody else touched it); a Scene created elsewhere is not adopted and gets no expectation, so the next whole save's `409` recovery pulls it in.
- **Binding by revision lineage, not bytes:** the commit records `{ before, after }` per rewritten Scene; a dirty Scene is rebound only when `baseline.revs[id] === before` and the fetched revision `=== after`. A content comparison could fail on benign storage normalization (lineage carry-forward, PBL stripping) and turn a local edit into a needless `409` that replaces it.
- Fetch stays separate from application: `loadStageData` is the last `await`; `applyInsertionResult` is synchronous, re-checks the handle (`'stale'`), the proven revisions (`'unbound'`) and recomputes the dirt; the client never calls `resyncStageScenesFromServer` (asserted by a test).
- Tests: `tests/store/stage-insertion-durability.test.ts` — "a dirty Scene deleted elsewhere is kept …" (follows through the real 409 path and its notice), "a clean Scene deleted elsewhere is removed …", "structure dirt + a remote deletion …", "structure dirt + a dirty Scene deleted elsewhere …", "structure dirt: a Scene deleted here stays deleted …"; fetch-window cases in `tests/edit/scene-insertion-client.test.ts`.

## 3. V3.1-2 — navigation departure writes

- **Policy chosen:** the no-write invariant is scoped to the insertion handle **while it is current** (plan §5.1 invariants, store comment block above the insertion APIs).
- Why it holds: `setStage` calls `claimStageSceneLoadToken()` before its departing-Stage `persistDirtySnapshot`; the handle compares the token it recorded, so by the time a departure write starts the handle is not current and the late result is discarded as `'stale'`.
- The departure write keeps its existing semantics; holding it until the run settles would only guarantee a revision conflict (the insertion bumps every revision). Before T2's commit it is rebuilt around (kept); after it, its conflict is logged and dropped — the existing "navigation is not a durability barrier" rule.
- F61 no longer implies the four `saveToStorage` callers are every writer; the other writers (departure, media-reference persistence, rename, delete/restore) are listed and stated to be outside the handle-scoped invariant.
- Tests: "navigating away during the fetch → stale; the departing dirt keeps the departure-save path (V3.1-2)" (store) and "navigating away while held dirt exists: the departure save runs, the result is stale (V3.1-2)" (client).

## 4. UI and the editing-lock inventory

Built in a separate worktree by a UI sub-agent (branch `codex/reviewer-slide-ui`, cherry-picked here as `5e1f791b`, `52e01a9e`), against the client/store APIs above, which it did not modify.

- `components/edit/GenerateSlideForPartDialog.tsx` — units (1–3 uncovered instructional parts with text), position (`positions` select; pre-filled from `suggestedPosition`, fixed from a "+" zone; an inline refusal when the "+" position is not a server position), teaching stage (0 → inline refusal, 1 → read-only, 2 → choice, left default), optional instruction (≤2000), required reason (5–1000). One idempotency key per open; after `unknown` the key **and the exact request** are kept and the fields freeze ("Retry"), after `failed` a new key is minted. Modal; cannot close while running; no unit text is ever shown.
- `components/edit/LessonPartsPanel.tsx` — every part in manifest order with "covered by N slides" / "quiz only" / "no slide" badges, non-instructional parts greyed; the single "regenerate the package" line when there are no retained parts. Entry: a full-width "Lesson parts · N without a slide" button at the top of the rail list (the rail header is hidden in the workbench; the EditDock is per-slide).
- `SlideNavRail.tsx` / `InsertionZone.tsx` — the gate is read in grant sessions, keyed by Stage, re-read on Stage change, on open and after every settled run; "Generate with AI" is the third "+" choice when `canInsertScene(gate)`; same-tab mutual disabling both ways (§11.7).
- `RegenerateSlideDialog.tsx` — B-4 message for `STAGE_GENERATION_IN_PROGRESS`.
- i18n: `edit.slideInsertion.*` + the B-4 string in all 12 locales (ar-SA and en-US translated; the others carry English, as `slideRegeneration` does).

**Editing-lock inventory (guarded — no-op, no dirt):** rail reorder / insert / duplicate / delete / delete-undo / regenerate / audio / open insertion; `InsertionZone` trigger; `ThumbItem.commitRename`; `slide-edit-session` `replace` + the auto-height branch (covers every slide-surface mutator, canvas transactions incl. document-level shortcuts, CommandBar undo/redo); `quiz-edit-session` `replace` + `commitText` (every quiz mutator, undo/redo); `TeachingSkillsPanel.mutate` (Skills PUT, alignment-confirmation PUT, resync); the regeneration restore toast; ActionsBar "Voice all"; `ElementPickLayer` cue binding.

**Deliberately unguarded (reason; safety nets are the at-apply dirt check and T2's rebuild/fences):** the ActionsBar `commit` funnel (unreachable behind the modal; it also stamps already-paid TTS results, so guarding it alone would desync text and audio); the per-line TTS regenerate (unreachable; a paid result); PronunciationPanel reading mode and the agent roster (pointer-only, behind modals; stage-level dirt written after release); `setCurrentSceneId` (not a document kind); a Skills PUT already in flight when the lock starts (narrow; the clean apply takes the server copy); media/narration persistence, playback stage-api, loaders, `setStage`, scene generator, PBL renderer, workspace rename (outside the invariant by the V3.1-2 policy; loaders move the load token → stale); other tabs (server fences).

## 5. Deviations from the v3.1 text (all recorded in plan v3.2)

1. Revision-lineage binding instead of the `migrateScene`-normalized content comparison (V3.1-1 as built).
2. API shapes: `{ insertion: Status, replayed }`; `Status` carries `revTransitions`; content-units adds `positions`, `stages`, `suggestedPosition`; `lineageStatus` uses the persistence values.
3. New modules `stage-generation-mutex.ts` (no T1 import cycle) and `insertion-skill-validation.ts`; new code `INSERTION_PERSISTENCE_FAILED` (503).
4. `pendingDocumentRevisionMark()` takes no argument; the handle records the load token at creation and exposes `captureBaseline()`; `isStageWritesHeld()` is exported for the client preconditions.

## 6. Verification

Focused pass from the worktree root, each file set sized first with `pnpm exec vitest list` (at most three files per command, the command guard's limit). No full suite was run. The rows were run on `8dd30da1`; the two rows that `ddff7126` (review 4) touches were rerun on `ddff7126`, as was the rail's own test file (`tests/document-store/slide-nav-rail-teaching-stage.test.ts` + the dialog and panel tests: 38 passed).

| `pnpm exec vitest run …` | Result |
|---|---|
| `tests/teaching-package/scene-insertion-route.test.ts tests/teaching-package/scene-insertion-store.test.ts tests/teaching-package/scene-insertion-store.pg.test.ts` | 29 passed, 4 skipped (pg, no `PG_CONTRACT_URL`) — rerun on `ddff7126` |
| `tests/teaching-package/content-unit-coverage.test.ts tests/teaching-package/plan-inserted-slide.test.ts tests/teaching-package/routed-insertion-call.test.ts` | 27 passed |
| `tests/teaching-package/insert-one-scene.test.ts tests/teaching-package/skill-validation-inputs.test.ts tests/usage/reporting-queries.test.ts` | 22 passed |
| `tests/store/stage-insertion-durability.test.ts tests/edit/scene-insertion-client.test.ts tests/agent-runtime/outline-from-scene.test.ts` | 61 passed — rerun on `ddff7126` |
| `tests/components/edit/generate-slide-for-part-dialog.test.ts tests/components/edit/lesson-parts-panel.test.ts tests/components/edit/regenerate-slide-dialog.test.ts` | 39 passed |
| `tests/teaching-package/scene-regeneration-route.test.ts tests/teaching-package/regenerate-one-scene.test.ts tests/teaching-package/scene-regeneration-store.pg.test.ts` | 48 passed, 3 skipped (pg) |
| `tests/teaching-package/routed-regeneration-call.test.ts tests/teaching-package/revision-precondition.test.ts tests/agent-runtime/generation-tools.test.ts` | 36 passed |
| `tests/agent-runtime/generation-tools-governed.test.ts tests/edit/scene-regeneration-client.test.ts tests/edit/narration-audio-client.test.ts` | 23 passed |
| `tests/store/stage-document-persistence.test.ts tests/store/stage-deletion-aggregate-recovery.test.ts tests/store/stage-regeneration-barrier.test.ts` | 15 passed |
| `tests/store/stage-insert-scene-after.test.ts tests/classroom/load-classroom.test.ts tests/classroom/read-only-grant-autosave.test.ts` | 60 passed |
| `tests/store/stage-agents.test.ts tests/store/stage-generation-complete.test.ts tests/store/stage-incremental-persistence.test.ts` | 67 passed |
| `tests/persistence/teaching-model-attempts.test.ts tests/server/teaching-model-execute.test.ts tests/i18n/edit-chrome-keys.test.ts` | 50 passed |
| `tests/edit/slide-edit-session.test.ts tests/edit/surfaces/quiz/quiz-edit-session.test.ts tests/edit/teaching-skills-panel.test.ts` | 27 passed |
| `tests/document-store/slide-nav-rail-teaching-stage.test.ts tests/edit/actions-bar-findings.test.ts tests/components/edit/thumb-item-generation-issues.test.ts` | 15 passed |
| `tests/edit/surfaces/slide/element-pick-layer-purposes.test.ts tests/edit/surfaces/slide/element-pick-layer-renderer-dom.test.ts` | 18 passed |
| **Total** | **537 passed, 7 skipped, 0 failed** |

Static:
- `pnpm exec eslint <touched files>` — clean.
- `pnpm exec prettier --check <touched files>` — clean, except the three files that were not prettier-clean at `eae05f4c` (§8), whose unrelated lines were left as they were.
- `pnpm exec tsc --noEmit -p tsconfig.json` — no error in any touched file. The application-level errors are the same three untouched test files as at `eae05f4c` (`--incremental false` baseline in the original checkout: 9 errors, one of them in an ignored `docs/` file that the worktree does not have). The worktree adds 67 `packages/*` errors only because per-package `node_modules` (e.g. `@testing-library/*` under `packages/@openmaic/editor`) are not present in a worktree whose root `node_modules` is a symlink.

## 7. Independent review

Four read-only reviewer sub-agents that did not write the code: (1) server + store + client, `eae05f4c..43235d1a`; (2) UI, `5e1f791b` + `52e01a9e`; (3) follow-up on the fixes `c6614d3b`; (4) follow-up on `8dd30da1`. No BLOCKER was found.

| Finding | Severity | Disposition |
|---|---|---|
| (1) H-1 / (2) HIGH — a proxy timeout on the long POST, a poll error, or a 600 s poll budget below the 900 s lease could report `failed`/`unknown` and release the hold while the server can still commit | HIGH | **Fixed** (`c6614d3b`, completed in `8dd30da1` after review 3): same-key retry on code-less gateway / 429 / `INTERNAL_ERROR` answers with a delay; polling ends only on 404/403; 600 × 2 s budget; lease clamped to ≤ 1080 s; 30 s per status read; result fetch retried while holding. Review 4 replaced the poll count with one wall-clock deadline that follows the lease (below) |
| (2) MEDIUM — a chosen position vanishing from a refreshed read left the select and the state out of step | MEDIUM | **Fixed** (fallback + test) |
| (1) M-1 — the PG race suite thin; "both orders" not deterministic | MEDIUM | **Improved**: deterministic order via a held `stage_meta` lock, two concurrent starts, same-key concurrent start. Still **unexecuted** (gated) — pending gate |
| (3) MEDIUM — the instruction sanitizer could be rebuilt by nested markers | MEDIUM | **Fixed** (strip `<{3,}`/`>{3,}` until stable + nested test) |
| (1) L-1 fetch error after success | LOW | Fixed (retried while holding) |
| (1) L-2 expired-running replay ran new-run checks first; (3) its first fix read without the row lock | LOW | Fixed (scoped reclaim under the row lock, then replay; test with a locked version) |
| (1) L-4 completion not reset per attempt | LOW | Fixed (unreachable today; guard) |
| (1) L-5 wrapper break-out | LOW | Fixed (see MEDIUM above) |
| (1) L-6 T1 re-check code | LOW | Fixed (409 CHANGED + test) |
| (1) L-7 status shape in the plan | LOW | Fixed in the plan text |
| (1) L-8 live vs replay code | LOW | Fixed (wrapped + test) |
| (1) L-3 transient duplicate order in a merge with a dirty remote deletion | LOW | Accepted: cosmetic, ends with the next save's 409 |
| (1) L-9 T2 re-runs the DSL ladder on every Scene | LOW | Accepted: a no-op on current data, identical to every client whole-document save |
| (1) L-10 / (2) test gaps | LOW | Partly closed (A-25 precondition proofs after merges, 202 + poll, expired replay, held-during-poll assertions). Still open: no rendering test of the rail wiring (mutual disabling, gate keyed by Stage) |
| (2) LOW — dialog not keyed by Stage; parts-read failure spins; `INSERTION_PERSISTENCE_FAILED` unmapped | LOW | Fixed |
| (3) LOW — running flag / open dialog not keyed by Stage in the rail | LOW | Fixed |
| (2) LOW — frozen form shows the refreshed list after `unknown`; Cancel after `unknown` drops the key; auto-height refused while locked is not re-applied; "Voice all" stops silently; disabled-button hints; in-flight Skills PUT resync | LOW | Deferred, documented here: the resent body is always the frozen request; the server's IN_PROGRESS / ALREADY_COVERED checks prevent a duplicate commit; the others are cosmetic or already in the unguarded inventory (§4) |

Review (4), on `8dd30da1` — fixed in `ddff7126`:

| Finding | Severity | Disposition |
|---|---|---|
| (4) POST retries ended after 3 attempts (~3 s): a network drop after the first POST reached the TE returned `unknown` with the hold released while the server could still commit (not introduced by `8dd30da1`) | MEDIUM | **Fixed**: the same key is re-POSTed with a capped backoff inside one wall-clock run deadline (20 min), each attempt with a 5 min timeout; tests for a sustained drop and for an ambiguous answer up to the deadline |
| (4) Rail: a settled run of Stage A, after a switch to Stage B, closed B's dialog (`setInserting(null)`) and its settle-refresh could write A's gate/parts into B | MEDIUM | **Fixed**: close only the dialog of its own Stage; the refresh is ignored when the current Stage ref no longer matches. No rendering test of the rail wiring (§8) |
| (4) The poll budget counted polls, not time (≈ 5 h if every read stalls); the POST had no timeout | LOW | **Fixed**: one wall-clock deadline shared by the POST and the polls; a running status reports `leaseRemainingMs` and the deadline extends to the lease + 60 s; a test pins `1080 s × 1000 + 60 s < budget` and the clamp |
| (4) A plain-text 404 (edge, misroute, the TE's own `notFound()`) ended polling | LOW | **Fixed**: only the TE envelope's `INSERTION_NOT_FOUND` (or a 403) ends polling; test |
| (4) A synchronous throw from `eligibleVisuals` (outside the try) left a running row with no generation | LOW | **Fixed**: moved inside the wrapped generation |
| (4) A T1 commit whose acknowledgement is lost leaves a running row with no generation; the editor then waits for `LEASE_EXPIRED` (≤ 18 min) | LOW | Accepted (rare); the status read reclaims the lease, and the hold ends with a terminal answer |
| (4) Step 9a `loadStageData` has no timeout | LOW | Deferred: it is the shared `stage-storage` read used by every load; the result fetch is retried 3 times while holding |

## 8. Pending gates and limitations

- `PG_CONTRACT_URL` suites (`tests/teaching-package/scene-insertion-store.pg.test.ts`, `scene-regeneration-store.pg.test.ts`) were **skipped**: no disposable PostgreSQL was identified. True two-connection races (A-5) are only proven there.
- Acceptance checks A-1..A-28 on staging, required CI on the branch, and a Codex re-review of the implementation are pending.
- No live provider was called: the planner/content/actions are covered with stubs. Provider JSON quality (A-11) and cached verdicts (A-13) are runtime facts.
- `pnpm exec tsc --noEmit` reports 75 errors, none in a touched file (pre-existing: packages' test dependencies and three untouched tests).
- `prettier --check` reports `lib/server/teaching-model/report.ts`, `lib/persistence/teaching-model-attempts.ts` and `tests/usage/reporting-queries.test.ts`: they were not prettier-clean at `eae05f4c`, and their unrelated lines were deliberately not reformatted.
- E-1..E-3 apply at TE boot when the branch's code first runs (the staging deploy once it lands on `staging`).
- No rendering test covers the nav rail's wiring (mutual disabling, the gate and dialog keyed by Stage, the stale-Stage refresh guard); it is covered by review only.
- The edge where the client's deadline and the server's lease end at nearly the same moment is reasoned (the lease is clamped below the budget, and the deadline follows the reported lease) but not exercised against a real clock.
- The branch is pushed unmerged; merging into `staging` (which deploys and runs E-1..E-3 at TE boot) needs the owner's separate yes.
