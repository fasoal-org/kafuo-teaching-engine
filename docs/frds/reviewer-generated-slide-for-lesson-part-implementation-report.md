# Reviewer-Generated Slide for a Lesson Part — Implementation Report

| Attribute | Value |
|---|---|
| Date | 2026-10-23 |
| Plan | `reviewer-generated-slide-for-lesson-part-plan.md` v3.2 (as implemented); v3.1 + the v3.1 re-review (V3.1-1, V3.1-2) were the inputs |
| Review report | `reviewer-generated-slide-for-lesson-part-plan-review.md` — kept unchanged as historical evidence |
| Branch | `codex/reviewer-generated-slide-for-lesson-part`, from `origin/staging` at `eae05f4c` |
| Scope | W0–W5, B-1..B-4, E-1..E-3 (authorized by the owner for this task) |
| Status | Implemented; focused tests pass; independent review done (§7); network-hold fix on `codex/fix-scene-insertion-network-hold` (§9); grant-only access behind `ACCESS_CODE` (§10); **not runtime-verified** (§8, §9.5, §10.3) |

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

`ddff7126` itself has had no separate independent review; it is covered by the pending Codex re-review gate (§8).

Verified fact behind the hold-until-lease design: a dropped or aborted POST connection (the client's 5 min per-attempt timeout, or an edge `proxy_read_timeout`) does not cancel the server run. No request signal is passed into generation: `grep -n signal|abort` over the four insertion routes, `scene-insertion.ts`, `insert-one-scene.ts`, `routed-insertion-call.ts` and `plan-inserted-slide.ts` finds only the POST route's comment that the run ignores `req.signal`.

Known tradeoff: a TE-coded `INTERNAL_ERROR` on the POST now retries the same key until the 20 min deadline. A server bug that fails every attempt keeps the editor's Stage locked that long before `unknown` (no duplicate run is possible — one row per version + key). Before review 3 it failed fast. A possible later refinement: after a coded `INTERNAL_ERROR`, a `GET ?key=` answering `INSERTION_NOT_FOUND` is definite, because that handler has already finished.

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

## 9. Network-hold fix (post-implementation review, Findings 1–2)

| Attribute | Value |
|---|---|
| Branch | `codex/fix-scene-insertion-network-hold`, from the implementation HEAD `7a392eae`; `origin/staging` was `eae05f4c` (the implementation's base), so nothing had to be incorporated |
| Code commits | `fc4973fa` (the fix), `8ea82415` (hardening after the independent review), `e3d5c095` (re-review follow-ups) — §9.4 |
| Superseded here | §7 review-4 rows on the run deadline and `leaseRemainingMs`; §7 "Known tradeoff"; §8 "the edge where the client's deadline and the server's lease end…" |

### 9.1 The two findings

- **Finding 1 (Major): a late POST could start a lease that outlived the hold.**
  - The v3.2 client measured one deadline before the first POST, and compared the maximum lease with that budget.
  - A retry near the deadline could be the first request the server accepted. If its answer was lost, the client returned `unknown` and released the hold while that new lease was still valid.
  - Comparing two durations does not bound when an accepted request starts.
- **Finding 2 (Major): response-body failures bypassed the retry handling.**
  - `response.json()` of a successful POST ran outside the ambiguity handling.
  - A truncated or interrupted `202` body escaped as a transport error, returned `unknown` and released the hold while generation continued.

### 9.2 The protocol now (plan §5.1 step 8)

1. **Server-enforced admission deadline.**
   - After the baseline, the editor reads `serverNow` from the gate. Every POST of the run carries `admitBy = serverNow + 2 min` in an identical body.
   - T1 takes `stage_meta FOR UPDATE` and only then reads its clock (`scene-insertion-store.ts`, `startOnce`). It answers a replay first and refuses `now > admitBy` with `409 INSERTION_ADMISSION_CLOSED` (audited, no row). The lease starts at that same post-lock time.
   - A request still in transit, in the unlocked pre-T1 phase, or queued on the lock after the client's timeout can therefore start a run only by `admitBy`. Its lease ends by `admitBy + 1080 s`.
   - The service enforces `min(admitBy, arrival + 5 min)`, so every request has a server-side deadline. `admitBy` is required by the parser (`400 INVALID_REQUEST` without it), so a client without the protocol cannot run. A client timestamp is never trusted on its own: `admitBy` is a server-clock value, and the server compares it with its own clock.
   - `admitBy` is not part of the digest. The dialog's retry after `unknown` (same key, a new run, a new deadline) still replays.
2. **T2 commits only inside its lease.** The `'before'` phase already checked the lease under the row lock. The `'after'` phase now repeats the check right before COMMIT (`AND lease_expires_at > completedAt`), so only the COMMIT statement itself can land after the lease.
3. **The by-key read is linearizable with T1.**
   - It pins READ COMMITTED, takes `stage_meta FOR SHARE`, then reads the clock, then selects by key (and lazily reclaims an expired row) — `readSceneInsertionByKeyUnderStageLock`.
   - A T1 holds the lock FOR UPDATE from its admission check to its COMMIT, so the read waits for it and sees its row.
   - Its 404 carries `details.serverNow`. The editor trusts "no row" only when `serverNow > admitBy + 30 s` (`INSERTION_CLOCK_MARGIN_MS`). Then no run under the key exists or can start: every later T1 reads a later clock, and the margin absorbs a TE clock stepped back by less than 30 s.
   - The lock order is stage_meta, then the insertion row, as in T1 and T2.
4. **The client separates its two bounds**, both counted on `performance.now()` from the gate's answer:
   - *Retry budget* — `retryUntil` = 2 min.
   - *Safe release* — `releaseAt` = `retryUntil` + 1080 s + 2 min grace.

   Over that run, the client:
   - POSTs only within the retry budget;
   - after an ambiguous attempt, reads the key, which creates nothing;
   - settles a known id only by its status reads, never by another POST;
   - waits for the key to settle after a refusal of a *later* attempt, including a later `INSERTION_ADMISSION_CLOSED`;
   - past `releaseAt`, makes one last read. By key, it queues behind any T2 still holding `stage_meta`; by id, its lazy reclaim waits for T2's row lock and settles an expired lease. Only when that read fails is the outcome `unknown`;
   - ends the hold only on a definite answer, or when that last read fails.
5. **Bodies are part of the attempt (Finding 2).**
   - `postOnce`, `readByKey` and `readById` read `text()` and parse inside the attempt. Each status body is validated: `insertionId`, a known `status`, and `newSceneId` on success.
   - The following are ambiguous:
     - an interrupted read;
     - invalid JSON;
     - a 2xx that is not a status envelope;
     - a 5xx, 408 or 429 without a TE envelope;
     - the TE's `INTERNAL_ERROR`.

     Ambiguous means: the same body again within the budget, else the key read.
   - A coded TE error, or a code-less 4xx status line whatever its body, stays a refusal of that request.
   - A malformed status read is transient. It can no longer leave the poll loop with `status: undefined`, and it can no longer reach the apply step.

**Why release is now safe:**
- Every return path either got a definite answer, or ran past `releaseAt` and a last read failed. The definite answers are:
  - a terminal row;
  - the TE's server-attested "no row a margin past `admitBy`";
  - `IDEMPOTENCY_KEY_REUSED`;
  - a refusal of the only request sent;
  - the TE refusing the status read itself.
- Two server-enforced facts make `releaseAt` safe. A run can start only by `admitBy`, and it can commit only before its lease ends.
- In real time, both fall before `releaseAt` minus the grace, because `serverNow` was read before the gate's answer arrived and a monotonic clock never runs fast.
- When no clock can be read, nothing is sent: `unknown` keeps the key, the Stage is released, and nothing was started.

Preserved:
- Stage-wide drain, durability proof, hold and direct-save deferral (steps 1–7, unchanged code).
- Fetch-then-synchronous-apply (step 9, unchanged).
- Stale-handle checks, revision-lineage binding and the local-dirt merge.
- No `resyncStageScenesFromServer` (asserted by a test).
- Tenant/grant scoping of every read.
- T1/T2 fences, audit events and model accounting (no change to the routed adapter or the ledger).

### 9.3 Verification

- Mapped statically first: `scene-insertion-client.ts` (callers: the dialog, the rail's gate read), `scene-insertion-store.ts`, `scene-insertion.ts`, `errors.ts`, the four routes, the dialog's `KNOWN_ERROR_CODES`, and the 12 locales.
- Sized the impacted tests with `pnpm exec vitest list` (131 tests in 8 files at `fc4973fa`), then ran them at most three files per command. No full suite was run.
- After the hardening (`8ea82415`), the same 8 files were rerun. After the re-review fixes, the first row was rerun (the other files are unaffected: only the client comment, one unreachable line and a store test changed).

| `pnpm exec vitest run …` | Result |
|---|---|
| `tests/edit/scene-insertion-client.test.ts tests/teaching-package/scene-insertion-route.test.ts tests/teaching-package/scene-insertion-store.test.ts` | 90 passed (client 49, store 13, route 28) — after the re-review fixes |
| `tests/teaching-package/scene-insertion-store.pg.test.ts tests/components/edit/generate-slide-for-part-dialog.test.ts tests/components/edit/lesson-parts-panel.test.ts` | 33 passed, 6 skipped (pg, no `PG_CONTRACT_URL`) — on `8ea82415` |
| `tests/i18n/edit-chrome-keys.test.ts tests/document-store/slide-nav-rail-teaching-stage.test.ts` | 18 passed — on `8ea82415` |
| **Total** | **141 passed, 6 skipped, 0 failed** |

Regression coverage added:
- **Client** (fake clock and fake pause; every pause records whether the Stage is still held):
  - earlier POSTs never reach the server, then a late accepted POST loses its answer → settled by key; held until the run commits 14 min later; one identical body throughout;
  - a request still queued on the Stage lock after its POST timed out starts 90 s later → held for it;
  - offline once the POST left → held until `releaseAt`, then `unknown`, never earlier;
  - a truncated 202 body; an interrupted 202 body read; three malformed success envelopes (re-sent with the same key and body);
  - same-key recovery to a stored failure;
  - a later attempt's refusal that waits for the key (and the earlier attempt starts), or is reported once the key stays empty past the deadline;
  - a later attempt's `INSERTION_ADMISSION_CLOSED` waits for the key, trusted only a clock margin past the deadline;
  - `IDEMPOTENCY_KEY_REUSED` definite on any attempt;
  - a code-less 404 on the only POST is its refusal (no long hold); a code-less 408 or 429 is ambiguous and re-sent;
  - a by-key 404 without `serverNow` never settles the key;
  - past `releaseAt`, the last read still settles: by key (a run that committed late) and by id (an expired lease reclaimed as a failure);
  - a TE `403 READ_ONLY_GRANT` on the status read ends polling as `unknown`;
  - no server clock → nothing sent;
  - a malformed status read is transient;
  - a never-settling row held to `releaseAt`;
  - a long run polled by id without another POST;
  - invariants: the client's maximum lease equals `MAX_SCENE_INSERTION_LEASE_SECONDS × 1000`, and its window is at most the service's.
  - Existing normal success, refusal and stale-navigation tests are unchanged and pass.
- **Store** (PGlite; a statement hook moves the clock when the lock statement runs, simulating the wait):
  - T1 reads its clock after the lock (a late grant refuses; the lease starts at the grant);
  - a replay answers before the admission check;
  - T2's `'after'` lease re-check writes nothing;
  - the by-key read takes the lock, then the clock, and reclaims an expired row.
- **Route** (PGlite):
  - a past `admitBy` → 409, audited, no row, no model call;
  - a T1 lock granted past `admitBy` → refused;
  - the service clamp;
  - `admitBy` excluded from the digest (a later run replays even past its deadline);
  - a malformed or missing `admitBy` → 400, no row;
  - the by-key 404 carries a post-lock `serverNow`;
  - the gate reports `serverNow`.
- **PG-gated (written, NOT run):**
  - a real lock wait past `admitBy` → refused;
  - a by-key read queued behind a real T1 sees its row;
  - past the deadline, an absent key plus a refused T1.

Static:
- `pnpm exec eslint` on the 9 touched code and test files: clean.
- `pnpm exec prettier --check` on every touched file: clean (three feature files formatted with `--write`).
- `pnpm exec tsc --noEmit --incremental false`: 75 errors, the same baseline as §8, none in a touched file.

### 9.4 Independent review

A read-only reviewer sub-agent that did not write the code reviewed `fc4973fa`. It walked every return path, the lock order and the clock reasoning, and ran the three main test files (80/80). Verdict: Findings 1 and 2 are resolved. **No BLOCKER and no MAJOR.**

| Finding | Severity | Disposition |
|---|---|---|
| M1 — "no row past the deadline" and T1's check compare one TE clock with no slack; a backward clock step, or a second TE instance, could admit a queued attempt after the editor settled | MEDIUM | **Fixed** (`8ea82415`): the key settles only 30 s past `admitBy`, and a later attempt's `ADMISSION_CLOSED` waits for the key. Residual: a clock difference above 30 s (§9.5) |
| M2 — the 2 min grace for COMMIT is not enforced by the server | MEDIUM | **Mitigated** (`8ea82415`): past `releaseAt` one last read waits behind any T2 still holding its locks. Residual: when that read also fails (offline) |
| M3 — a lost COMMIT acknowledgement answers `INSERTION_PERSISTENCE_FAILED` as definite | MEDIUM | **Not changed**: pre-existing, outside the diff and outside the bug class (the release comes after the commit). Documented in §9.5 |
| L1 — the by-key proof depends on READ COMMITTED | LOW | **Fixed**: the read pins `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` |
| L2 — a by-id 403 releases while the run can still commit | LOW | Not changed (pre-existing); the tab's writes are refused server-side once read-only. Documented |
| L3 — a code-less non-JSON 4xx on the POST became ambiguous (up to a 22 min hold), contradicting the comment | LOW | **Fixed**: any code-less 4xx status line other than 408/429 refuses that attempt; tests added |
| L4 — a client without `admitBy` still runs with the old protocol | LOW | **Fixed**: `admitBy` is required (400) |
| L5 — a first-attempt refusal assumes nothing below `fetch` duplicated the POST | LOW | Accepted and documented (browsers do not silently resend a POST that got an answer) |
| L6 — test gaps | LOW | Partly closed (§9.3 list). Still open: the PG suite is unexecuted; the fake clock does not advance during a fetch; no clock-skew test |

The hardening commit `8ea82415` rewrote the 8b/8c loops (margin, last read, later-attempt `ADMISSION_CLOSED`). A second read-only reviewer reviewed only that commit and ran the three main files (89/89). It found **no BLOCKER, MAJOR or MEDIUM**: the hold is only made more conservative, the loops terminate, no last-read answer is discarded, and both final-read tests fail against the parent commit. Verdict: safe. It stays in the Codex re-review gate.

| Finding (re-review of `8ea82415`) | Severity | Disposition |
|---|---|---|
| The 30 s margin is a heuristic for one TE clock, not a proof under several skewed instances | LOW | Accepted; documented in §9.5. A database clock is the robust option |
| A code-less non-JSON 4xx now refuses; a browser resend below `fetch` combined with an evicted grant could hide a started first transmission | LOW | Accepted (very unlikely; coded refusals have the same exposure); §9.5 |
| The READ COMMITTED pin had no test | LOW | **Fixed** (`e3d5c095`): a PGlite test sets the session default to REPEATABLE READ and asserts the pin is the first statement and in force at the lock. Removing the pin fails the test (checked) |
| An unreachable `status === null` guard after the 8b loop | LOW | **Removed** |
| The `unknown` comment did not name the "TE refused the status read" exception | note | **Fixed** (comment) |
| The insertion routes are missing from `EDITOR_GRANT_EXEMPT_ROUTES` (`lib/config/access-code-allowlist.ts`): with `ACCESS_CODE` on and no access cookie, grant-only editors get a 401 on the gate, so nothing is sent | note (implementation, not this fix) | **Not changed here** (outside this task): fails safe, but blocks the feature for grant-only editors on staging. Follow-up; §9.5 |

### 9.5 Remaining limitations and UNVERIFIED

- **UNVERIFIED — PostgreSQL concurrency.** The `PG_CONTRACT_URL` suite was skipped (no disposable database was identified). The real lock-wait and FOR SHARE-versus-T1 races are reasoned and simulated in PGlite only, and have not been run.
- **UNVERIFIED — one TE clock.** Admission and lease checks compare TE wall clocks (`Date.now()`). The production and staging compose files each run a single `te` service. Clock differences — a second instance, or a backward step of the host clock — are absorbed up to 30 s on the "no row" path and up to 2 min on the release bound; beyond that they are not. The pre-existing lease logic has the same dependency. A database clock (`clock_timestamp()`) would remove it, but it was not adopted here because leases are stored and compared in TE time everywhere else.
- **UNVERIFIED — COMMIT latency when offline.** After T2's `'after'` check, the COMMIT is assumed to land within the 2 min grace *only if* the last read past `releaseAt` also fails. When the read reaches the server, it waits behind the T2 instead.
- **Hold length.** While offline after a POST left, the editor holds for up to about 22 min (window + lease + grace) before `unknown`. That is the price of a finite safe bound.
- **No server clock.** When the gate cannot be read, nothing is sent. The outcome is `unknown`, so the dialog keeps the key, but its message ("could not confirm") is broader than "nothing was sent".
- **Late-attempt refusal delay.** A refusal of a later attempt is reported only after the key settles. This can wait until the admission window plus the 30 s margin passes, at most about 2.5 min.
- **A lost commit acknowledgement** still answers `INSERTION_PERSISTENCE_FAILED` as a definite failure (review M3; pre-existing). The handler finished and its run cannot commit later, so the release itself is safe. The slide may in fact have landed; the next load shows it, and revision preconditions protect the next save.
- **By-id read refused by the TE.** The TE's own `404 INSERTION_NOT_FOUND`, or a `403` with a TE envelope, on a known id ends the hold as `unknown` (review L2; pre-existing). T2 does not check the grant, so the run may still commit. This tab's writes are refused once its grant is read-only, and the revision preconditions guard what lands later.
- **A duplicated POST below `fetch`** (review L5, re-review L-2): a first-attempt refusal is trusted as the only request. `sent` counts `fetch` calls, not transmissions. A silent browser resend on a reset reused connection, together with a grant that expired in between (the plain 404), could hide a first transmission that started a run. Very unlikely; accepted.
- **Access-code exemption (found by the re-review; implementation gap).** The insertion routes were missing from `EDITOR_GRANT_EXEMPT_ROUTES`. **Fixed in §10** (`5496c380`).
- **A silently hanging first POST.** One POST attempt may take 5 min, because it waits for the whole generation, and the admission window is 2 min. A first POST that hangs without ever reaching the TE is not retried inside the window. After its timeout, the key settles as `failed INSERTION_ADMISSION_CLOSED` (nothing started; try again) instead of recovering. This is safe and inherent to the window. Under the old 20 min budget the same case could recover.
- **Merge target.** `codex/fix-scene-insertion-network-hold` contains every implementation commit. Merge **this** branch, never `codex/reviewer-generated-slide-for-lesson-part` alone, which still has both findings. This fix adds **no schema change**: E-1..E-3 are as before, and a merge to `staging` still deploys the TE and runs them at boot, so it needs the owner's yes.
- **Pending gates:** CI on the branch, staging acceptance A-1..A-28, the PG contract suite, and a Codex re-review. Nothing was deployed, no TE was restarted, no live database was queried and no provider was called.

## 10. Grant-only editors behind `ACCESS_CODE` (O1 exemption rows i1–i5)

| Attribute | Value |
|---|---|
| Branch | `codex/fix-scene-insertion-network-hold`, on top of `91efffdd`; `origin/staging` still `eae05f4c`, nothing to incorporate |
| Code commit | `5496c380` |
| Finding | Major. `EDITOR_GRANT_EXEMPT_ROUTES` omitted the feature's routes. With `ACCESS_CODE` on, a valid editor grant and no `openmaic_access` cookie, the middleware answered 401 before any handler ran. The gate looked unavailable and the feature stayed hidden |

### 10.1 What changed

`lib/config/access-code-allowlist.ts` gains five exact rows, in the table's `:id` convention (one `[A-Za-z0-9_-]+` segment, anchored, exact method):

| # | Method | Path | Handler | Its own checks (before any read or write) |
|---|---|---|---|---|
| i1 | GET | `/api/stages/:id/scene-insertion` | `stages/[id]/scene-insertion/route.ts` | learner 401 without the access cookie (`learnerRefusalWithoutAccessCode`); `resolveRegenerationGrant` (`requireWrite: false`); read-only, and `running` is listed for write editing grants only |
| i2 | GET | `/api/stages/:id/content-units` | `stages/[id]/content-units/route.ts` | learner 401 without the access cookie; `resolveRegenerationGrant` (read); learner and preview grants refused (403); unit text never sent |
| i3 | POST | `/api/stages/:id/scene-insertions` | `stages/[id]/scene-insertions/route.ts` | `resolveRegenerationGrant` (`requireWrite: true`) before the body is parsed |
| i4 | GET | `/api/stages/:id/scene-insertions` (`?key=`) | same file | `requireWrite: true`; the key read is scoped to the grant's tenant, version and Stage |
| i5 | GET | `/api/stages/:id/scene-insertions/:id` | `stages/[id]/scene-insertions/[insertionId]/route.ts` | `requireWrite: true`; the id read is scoped to the grant's tenant, version and Stage |

`resolveRegenerationGrant` takes these steps in order:
1. A signed, unexpired grant for the path's Stage, else a plain 404.
2. The grant's version must exist in the grant's tenant and still name this Stage, else 404.
3. For writes, `capability === 'write'` on an editing grant (not learner, not preview), else `403 READ_ONLY_GRANT`.

Preserved unchanged:
- **The POST is same-origin only** (`SAME_ORIGIN_ONLY_METHODS`, D-O1-R8). It needs `Sec-Fetch-Site: same-origin`, or a matching `Origin` when that header is absent. Same-site, cross-site and `none` are refused.
- **Middleware order.** The closed-mode 503 and the access cookie come before the table.
- **Presence-only checks** in the middleware. The `PERSISTENCE_DEV_TOKEN` rule and every existing row are unchanged.
- **No wildcard, no HEAD/OPTIONS row**, and no other route was opened.

i5's last segment is the insertion id, the same shape as row 5. A `.rsc`-suffixed id reaches the handler only after its grant check for the Stage, and the scoped lookup then answers 404.

**Reviewed inventory.** The workspace inventory (`Zakrly-App/docs/frds/roles/roles-module-phase-1-o1-route-inventory-review.md`) gains an addendum, §7, with these rows and their evidence. That folder is not a git repository, so the addendum exists only in the local workspace.

### 10.2 Validation

Mapped statically first. The table is read only by `middleware.ts`; its tests are `tests/middleware/*` and the handlers' `tests/teaching-package/scene-insertion-route.test.ts`. Sized with `pnpm exec vitest list` (95 tests in 4 files); no full suite was run.

| `pnpm exec vitest run …` | Result |
|---|---|
| `tests/middleware/editor-grant-exemption.test.ts tests/middleware/access-code-gate.test.ts tests/middleware/access-gate-w1-b2a.test.ts` | 59 passed |
| `tests/teaching-package/scene-insertion-route.test.ts` | 36 passed |
| **Total** | **95 passed, 0 failed** |

What the tests prove:
- **Middleware**, with `ACCESS_CODE` set:
  - the pinned table and the route-file map include i1–i5;
  - each row passes with only a grant cookie, including `?key=` on i4 and an insertion id on i5;
  - every row answers 401 without a grant cookie, or with an empty one, or with only the learner-key cookie;
  - i3 joins the CSRF set: same-origin, or a matching `Origin`, passes; same-site, cross-site, `none`, an empty header, no headers, and same-site or cross-site next to a matching Origin all answer 401;
  - un-listed methods (POST on i1/i2/i5; PUT, DELETE, PATCH, HEAD, OPTIONS) answer 401;
  - 21 new look-alikes answer 401: trailing slashes, extra or empty segments, `%2F`, `..%2F`, a dot id, case variants, prefix and suffix neighbours, and a query that names a route;
  - closed mode still answers 503;
  - every other `app/api` route file stays blocked with only a grant cookie;
  - a structural pin checks each handler's own checks.
  - **Regression check:** the new middleware test, run against the committed (HEAD) allowlist, fails with `expected 401 to be 'passed'`.
- **Handlers**, with `ACCESS_CODE` set and no access cookie:
  - a write editing grant (and a legacy write grant) reaches all five: gate `write`, parts 200, start 200, status by key and by id 200;
  - a read grant sees gate `read` and parts 200, and gets 403 on i3–i5;
  - a preview grant, read or write, sees gate `read`, and gets 403 on the parts and on i3–i5;
  - a learner grant gets the middleware's 401 body on the gate and the parts, and 403 on i3–i5, with no row and no model call;
  - a forged grant, an empty one, another Stage's grant, an other-tenant grant, an other-version grant and a stale-version grant are each a plain 404 on all five, with no row and no model call.
- **Static:**
  - `pnpm exec eslint` and `pnpm exec prettier --check` on the three touched files: clean.
  - `pnpm exec tsc --noEmit --incremental false`: 75, the unchanged baseline.

### 10.3 Remaining gates (UNVERIFIED)

- **End to end on staging.** A grant-only editor (teacher handoff) on staging with `ACCESS_CODE` on: the gate shows "Generate with AI", and a run completes. This is part of A-1..A-28, not run.
- **Middleware and handler together.** These are tested separately (the middleware returns `next`; the handlers are called directly). They are not tested together through a running server.
- **Unchanged from §9.5:** the PG contract suite, CI on the branch, and a Codex re-review (now including `5496c380`). Nothing was deployed, no TE was restarted, no live database was queried and no provider was called.
