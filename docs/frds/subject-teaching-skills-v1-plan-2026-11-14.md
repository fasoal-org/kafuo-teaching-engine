# Subject-Specific Teaching Skills V1 — Plan

Date: 2026-11-14 · Repo: OpenMAIC (Teaching Engine), slot 2 (`slot-2`, based on
`origin/staging` @ `531bad94`) · Status: **BUILT (14 Nov 2026). TE and backend parts
are committed to `staging` on the owner's word. The mobile line and the curriculum
assignment to g5.v9 are still pending (§10.5). See §9.1 for the owner decisions and §10
for the build record.**

Scope source: the owner's spec "Kafuo — Implement Subject-Specific Teaching Skills V1".
The five Skills are `mathematics-academic-teaching`, `physics-conceptual-teaching`,
`chemistry-scientific-teaching`, `biology-structured-teaching` and
`arabic-language-teaching`.

## 0. Bottom line

The Teaching Engine (TE) can register the five Skills as canonical, versioned Skills
today, using only content files.

A registered Skill reaches a Teaching Package only when the lesson's **G5 Skill Policy**
names it. Those policies are authored in the **backend**
(`zakrly-backend/app/modules/teaching_engine/domain/teaching_model_flows/g5_v*.py`).
The TE only re-validates them. No current G5 version (g5.v1–g5.v8) names the five Skills,
and the existing versions must not be altered. Making the Skills actually shape
generated lessons therefore needs a **new Teaching Model version, `g5.v9`**. That
version needs:

- a backend change;
- a one-line mobile-app change (its supported-flow list);
- a small TE change;
- a later data step that assigns curricula to `g5.v9`.

Per the task rules, a backend change needs the owner's explicit decision first, and
every backend slot is currently taken.

## 1. Investigation — verified against the code

### 1.1 Canonical Skill registry, versioning, loading

- **Catalog.** `skills/agent-runtime/<skillId>/` holds 23 directories. Each has a
  top-level `SKILL.md`, a `skill-versions.json` manifest
  (`{recordVersion: 1, currentVersion, versions: {<v>: {digest}}}`), and an immutable
  retained snapshot `versions/<v>/SKILL.md`. Every shipped Skill is at `v1`.
- **Registry.** `lib/server/agent-runtime/canonical-skills.ts` does exact-version
  resolution only (`resolveCanonicalSkillVersion`). It has no "latest" path and no
  fallback. The digest (`skillSourceHash`) is an integrity guard, never a version.
  Verification also flags a top-level `SKILL.md` that drifts from its current
  snapshot.
- **Shared root.** The same directory is the Workbench agent catalog
  (`lib/server/agent-runtime/skills.ts`, `listSkills`). Nothing excludes a Skill
  from it.
- **Guarding tests.**
  - `tests/agent-runtime/canonical-skills.test.ts`: every shipped Skill has an intact
    `v1`.
  - `tests/agent-runtime/skills.test.ts`: every Skill loads and has a `title:`. That
    title must currently match Chinese characters.
  - `tests/workbench/workbench-i18n.test.ts`: every Skill has a display name in
    `lib/i18n/workbench.ts` (en + zh). The 10 locale overlays fall back to the base.

### 1.2 G5 flows, allowlists, required/preferred policies

- **Backend authors the policies.** The Skill Policy on each flow stage is authored in
  the backend (`teaching_model_flow.py::SkillPolicy`). It is projected **verbatim** onto
  every expanded entry by `expand_teaching_model_flow`, and sent as
  `teachingModel.flow[].skillPolicy` under the `teachingSkills: "kafuo.teaching-skills.v1"`
  marker.
- **TE re-parses for coherence.** `lib/server/teaching-package/kafuo-request.ts::parseSkillPolicy`
  checks that required/preferred sit inside allowed, one version per id, and at most one
  every-scene Primary.
- **TE resolves every ref.** `lib/server/teaching-package/skill-policy.ts::resolveFlowSkillPolicies`
  resolves every ref against the registry (`SKILL_NOT_FOUND`,
  `SKILL_VERSION_UNRESOLVED`). Its stated boundary: TE never re-derives or re-projects
  policy.
- **Current policies.** g5.v3 → v8 reuse the g5.v2 policy objects. g5.v6–v8 stages:

  | Stage (g5.v6–v8)             | allowed                                   | preferred | required |
  | ---------------------------- | ----------------------------------------- | --------- | -------- |
  | `lesson_opener`              | UbD, SEL, learning-to-learn               | UbD       | none     |
  | `lesson_learning_map`        | UbD, SEL, learning-to-learn               | UbD       | none     |
  | `outcome_visual_explanations`| UbD, spiral, learning-to-learn, SEL, Feynman | UbD    | none     |
  | `outcome_check_understanding`| Feynman, learning-to-learn, UbD           | Feynman   | none     |

  All refs are `@v1`. No combination restrictions exist.
  `outcome_visual_explanations` holds every teaching slide of an objective, with roles
  explanation / worked_example / check_understanding / summary.
- **Version assignment.** Which version a lesson uses comes from the DB assignment
  (`teaching_models` + curriculum assignment, read in `build_generation_request.py`).
  It is advanced by data migrations (e.g. `297_g5_v6_game_free_flow`,
  `326_lesson_template_recall_and_exercises`). The mobile app pins its supported flows
  explicitly (`Zakrly-mobile-app/.../teaching_runner_models.dart`: `'g5/g5.v7'`,
  `'g5/g5.v8'`).

### 1.3 How Skill text reaches content, narration and actions

1. **Outline planning.** `requirements-to-outlines` renders each position's
   allowed/preferred/required refs (ids only) in the "Teaching Skill Policy — Selection
   Authority" block. The planner writes `teachingSkills {classification, primary,
   supporting[]}` on each outline.
2. **Stage-1 gate.** `findOutlineSkillSelectionIssues` checks:
   - invented id or version;
   - out-of-policy selection;
   - required scope and role.

   Failures become admin-correctable diagnostics (`outline-correction.ts`) or re-rolls.
3. **Pre-resolution.** `lib/server/classroom-generation.ts` resolves the full `SKILL.md`
   of every policy ref once per governed run (`resolvedSkills`).
4. **Prompt injection.** `packages/@openmaic/generation/src/scene-generator.ts::buildSceneSkillContext`
   pairs the outline carrier with that text (PRIMARY, then SUPPORTING). It is rendered
   into:
   - `slide-content` and `quiz-content` ("Teaching Skills — HOW this slide teaches");
   - `slide-actions`, `quiz-actions`, `interactive-actions` and `pbl-actions` ("Teaching
     Skill Authority"). **Narration is the speech actions** generated by these actions
     prompts.

   Authority order (in the templates): Flow instructions → Primary → Supporting → prompt
   defaults. Safety, grounding, language and schema never yield.
5. **Regeneration and insertion.** Single-scene regeneration and insertion reuse the
   pinned flow and `resolvedSkills`, so they need no new code.

### 1.4 Subject and Lesson Template identification

- **Subject.** The authoritative subject is `learningItem.subjectOffering.code`
  (= `master_subjects.routing_key`), normalised by `subjectCodeOf`
  (`kafuo-request.ts`). The routed set is MATH, PHYSICS, BIOLOGY, ARABIC,
  SOCIAL_STUDIES, CHEMISTRY and ENGLISH. Literary Studies routes as ARABIC.
  `null` means unrouted. TE already keys policy on this code: the speech register
  policy, the sacred-text policy, and model routing (code-owned in OpenMAIC, mirrored by
  the backend).
- **Lesson Templates.** These are backend-only (`curriculums_management/domain/lesson_template.py`).
  They reach TE only as `bookStructure` unit kinds (key concept, worked example, try-it,
  prior knowledge, exercise…) on g5.v7/v8, and as the flow instructions text. A Skill
  can adapt only to those unit kinds and to the source content itself.

### 1.5 Validation and persistence of assignments

- **Persistence.** The outline carrier is copied onto `scene.teachingSkills`
  (`scene-builder.ts`).
- **Validators.** The submit-gate validators (`skill-validators.ts`, checks 4–9) and the
  scene Skill mutation (`scene-skills.ts`) are generic over Skill ids.
- **Lineage.** The policy-lineage digest (`computeSkillPolicyDigest`) records which
  policies governed an attempt. Historical packages pin their own flow and resolve their
  Skills at the exact `v1` they used. Adding Skills or a new model version never
  re-interprets them.

## 2. Conflict with the G5 allowlists

- **Not selectable.** The five Skills are in no G5 allowlist, so a governed outline that
  selected one would be refused (`SKILL_ASSIGNMENT_INVALID`). Registry-only work ships
  Skills no lesson can use.
- **v8 is frozen.** Adding them to g5.v8's policies alters a production Teaching Model
  version. That is forbidden by the spec (§8, §10).
- **TE-only injection rejected.** A TE-only path would inject a subject block by
  `subjectCode` outside the Skill Policy. It is **rejected** for three reasons:
  - It would change every existing g5.v6–v8 run.
  - It bypasses the Primary/Supporting governance ("the unrestricted catalog is never a
    fallback").
  - It is invisible to lineage and to the alignment baseline.
- **Not deterministic.** All five in `allowed` with the planner choosing is not a
  deterministic "select by subject".

## 3. Integration design (recommended)

### 3.1 Versioning decision

- **Skills.** Each Skill is a new canonical Skill at **`v1`**, using the existing
  registry: manifest, retained snapshot and digest.
- **Teaching Model.** A new version, **`g5.v9` = g5.v8 + a subject-aware Skill Policy**.
  Stages, keys, instructions, scene policies, book structure and exercise policy stay
  identical to v8.
- **Untouched.** g5.v1–v8 stay byte-identical, and so do historical packages.

### 3.2 Role and placement in g5.v9

> **Revised 14 Nov 2026 (decision 2, §9.1):** the subject Skill is now the required
> **Primary** (`role: primary`), not supporting. The text below records the original
> design.

At **`outcome_visual_explanations`** only, for a lesson whose subject maps to a Skill:

- **allowed** = v8's allowed + **that subject's Skill only**;
- **required** += `{skill: <subject Skill>@v1, scope: every_instructional_scene, role: supporting}`;
- **preferred** unchanged (UbD).

Rationale:

- **Supporting, not primary.** The spec says the Skill gives discipline guidance while
  the Teaching Model keeps the stages and slide structure. The primary stays the
  pedagogical method (UbD, Feynman, etc.), and the one-Primary rule (BR-TS-021) is
  untouched.
- **Required on every instructional scene.** This makes selection deterministic: the
  planner copies the rule and the gate enforces it.
- **Transitions exempt.** Slides explicitly classified non-instructional (transitions)
  are exempt.

The other stages (`lesson_opener`, `lesson_learning_map`, `outcome_check_understanding`)
keep v8's policy unchanged. SOCIAL_STUDIES, ENGLISH and unrouted subjects get v8's
policy byte-for-byte under g5.v9.

New failure mode (named): a planner that omits the required supporting Skill now gets
`SKILL_REQUIREMENT_UNSATISFIED`. This is handled by the existing correction diagnostics
and re-roll.

### 3.3 Subject → Skill mapping (single source)

| Subject code | Skill                            |
| ------------ | -------------------------------- |
| MATH         | `mathematics-academic-teaching@v1` |
| PHYSICS      | `physics-conceptual-teaching@v1`   |
| CHEMISTRY    | `chemistry-scientific-teaching@v1` |
| BIOLOGY      | `biology-structured-teaching@v1`   |
| ARABIC       | `arabic-language-teaching@v1`      |

Following the subject-routing precedent, the mapping is code-owned in TE
(`lib/server/teaching-package/subject-teaching-skills.ts`) and pinned by a shared fixture
(`tests/fixtures/subject-teaching-skills.v1.json`). The backend mirrors it, pinned to the
same fixture by a backend test.

### 3.4 Changes per repo

**TE (this slot):**

1. Five Skill directories. Each has `SKILL.md`, `skill-versions.json` (`currentVersion:
   v1`) and `versions/v1/SKILL.md`. The snapshot is byte-identical to the top-level file,
   and the digest is computed by `skillSourceHash`.
2. `lib/server/teaching-package/subject-teaching-skills.ts`: the mapping plus
   `subjectTeachingSkillFor(subjectCode)`.
3. A fail-closed **subject guard** at the existing policy seam. A governed request whose
   policies name any subject Skill must name only the one mapped to its `subjectCode`.
   Otherwise it is refused with `SKILL_POLICY_INVALID`. No existing request names these
   Skills, so the guard changes nothing for g5.v1–v8.
4. `book-coverage.ts::isTeacherParityModel` accepts `g5.v9` as well as `g5.v8`. This is
   the ONE teacher-parity switch, with 14 callers. Without it, g5.v9 would silently lose
   every v8 gate.
5. Workbench display names (en + zh) in `lib/i18n/workbench.ts`. Widen the title
   assertion in `skills.test.ts` to accept an Arabic title.

**Backend (needs a slot and the owner's go; Spec Kit applies):**

- `teaching_model_flows/g5_v9.py`: v8 stages + per-subject policy projection, chosen by
  `subject_routing_key`.
- `TEACHING_MODEL_G5_V9_VERSION`, the `_FLOWS` entry, and the
  `curriculums_management/domain/teaching_flows/g5_v9.py` descriptor.
- Add v9 to `BOOK_STRUCTURED_TEACHING_MODEL_VERSIONS`. Widen the
  `== TEACHING_MODEL_G5_V8_VERSION` switches (`build_generation_request.py`
  recall/exercises, exercise policy) to include v9.
- The mapping mirror and its fixture test.

**Mobile:** add `'g5/g5.v9'` to the supported-flow list. A tester build must ship before
any curriculum is assigned to g5.v9.

**Data (owner, later):** assigning curricula to g5.v9 is a migration or data step on the
pattern of `297`/`326`. It is not part of this work, and it is never run without the
owner.

## 4. Skill content design

- **Language.** The instructions are English, matching every generation prompt, with
  Arabic terms where the curriculum uses them. The display `title:` is Arabic.
- **Shared principles.** The universal principles (§2 of the spec) are embedded in each
  Skill as a short shared section. Each version is an immutable, self-contained snapshot,
  so a shared include would break exact-version resolution. No sixth Skill is created.
- **Size.** Each Skill is about 4–6 KB, the same scale as UbD and learning-to-learn
  (4.2–4.4 KB). The full text rides every instructional slide and actions prompt.
- **Conflicts resolved in the wording.**
  - *Answers.* "Do not reveal answers to independent assessment" means the quiz and bank
    questions. In-slide check solutions and the exercises block follow the Teaching
    Model's flow instructions, which outrank the Skill.
  - *Math.* The math Skill complements g5.v8's RECALL and VISIBLE WORKING rules and does
    not restate them.
  - *Register.* Only the Arabic Skill asks for Modern Standard Arabic, which matches the
    existing ARABIC → MSA register policy. The other Skills defer to the narration
    register policy.
  - *Lesson Templates.* Lesson Templates are not visible to TE. Skills key off the
    book-unit kinds and the grounded content, and never ask for experiments or
    calculations the source does not hold.
- **Structure.** The Teaching Model owns stages and slide structure. Each Skill states
  that it shapes HOW a slide teaches, never which slides exist.

## 5. Reuse mapping

| Need | Reused capability |
| --- | --- |
| Versioned definitions | Canonical registry (`canonical-skills.ts`), manifest + retained snapshot + digest |
| Allowlist / required / role | Backend `SkillPolicy` + `expand_teaching_model_flow`; TE `parseSkillPolicy` |
| Resolution | `resolveFlowSkillPolicies` (exact version) |
| Selection and enforcement | Outline Skill Policy prompt block + `findOutlineSkillSelectionIssues` + correction and re-roll |
| Prompt delivery | `resolvedSkills` + `buildSceneSkillContext` → slide/quiz content + all actions (narration) |
| Persistence / lineage | `scene.teachingSkills`, policy digest, submit validators, scene Skill mutation |
| Subject context | `subjectCodeOf` / `subject_routing_key` |
| Pedagogical method | UbD / Feynman / spiral / learning-to-learn stay Primary (no duplication) |
| v8 behaviour | Teacher-parity switch (`isTeacherParityModel`), book structure, exercise policy |

## 6. Side effects (stated, not hidden)

- **Workbench picker.** The five Skills appear in the Workbench Skill picker, because
  the canonical root is the Workbench catalog. They need en/zh display names. No loader
  change is proposed.
- **Title test.** One test assertion is widened (Chinese-only title → Chinese or
  Arabic).

## 7. Tests (mapped first; at most 3 files per run; stubbed models only)

**New:**

- `tests/teaching-package/subject-teaching-skills.test.ts`:
  - each Skill resolves at `v1` (content, digest);
  - the mapping covers the five subjects and nothing else;
  - the guard accepts the matching subject and refuses a mismatch;
  - g5.v8-shaped policies are untouched;
  - a g5.v9-shaped flow passes `findOutlineSkillSelectionIssues` with the supporting
    Skill and fails without it.
- `packages/@openmaic/generation/test/subject-skill-prompts.test.ts`: one representative
  outline fixture per subject (five subjects). For each, it asserts that the Skill's own
  instruction lines appear in the rendered `slide-content` and `slide-actions` prompts,
  and that no other subject's Skill appears. It uses the existing prompt builders, with
  no model call.

**Existing (must still pass):**

- `tests/agent-runtime/canonical-skills.test.ts`
- `tests/agent-runtime/skills.test.ts`
- `tests/workbench/workbench-i18n.test.ts`
- `tests/teaching-package/skill-policy.test.ts`
- `packages/@openmaic/generation/test/scene-skill-context.test.ts`
- the teacher-parity / book-coverage test file(s) that exercise `isTeacherParityModel`

**Static:** `pnpm exec eslint` and `pnpm exec prettier --check` on touched files.

**Pending gates (not run here):** CI, backend tests, the mobile build, and a real paid
generation (only with the owner's yes).

## 8. Out of scope

Teaching Session Runtime, adaptive remediation, existing packages, production data, deploys,
and feature flags.

## 9. Open decisions for the owner

1. **The blocker.** The integration needs a backend change (g5.v9) and a mobile one-liner.
   Options:
   - (a) Do the TE part now (zero change to any current lesson), and the backend and
     mobile parts when a slot frees.
   - (b) Wait and do everything together.
   - (c) Something else.
2. **Role.** The subject Skill is a required **supporting** Skill on every teaching slide
   of the objective stage, and the Primary stays as today. Confirm.
3. **Placement.** The objective teaching stage only; the opener, learning map and quiz
   stage are unchanged. Confirm.
4. **Workbench.** The five Skills become visible in the Workbench picker. Accept?

### 9.1 Owner decisions

- **14 Nov 2026, decision 1 → (b) wait.** No TE-only part ships first. The work
  resumes when a backend slot is free, and then the TE, backend and mobile parts are done
  together. Decisions 2–4 are still open.
- **14 Nov 2026, backend slot.** Owner: start in the 4th backend worktree after updating
  it. That worktree is `zakrly-backend/.claude/worktrees/brave-lovelace-c8a556` on branch
  `claude/priceless-lamarr-4d9937`, the stale app worktree. It was rebased onto
  origin/staging @ `434df233` and is clean. The mobile one-liner waits for a free mobile
  slot: all three hold uncommitted work.
- **14 Nov 2026, decision 2 → supporting.** The subject Skill is a required
  **supporting** Skill (`every_instructional_scene`). The Primary stays the pedagogical
  method, as in §3.2.
- **14 Nov 2026 (evening), decision 2 REVISED → primary.** The first g5.v9 run (lesson
  329, attempt `tpa-vTtRwc6bnF4z`) stopped at the outline with 19
  `SKILL_REQUIREMENT_UNSATISFIED`: the planner made `mathematics-academic-teaching` the
  Primary of every teaching slide. Owner: «we have create the today skill to do this the
  model is correct» and «أيوه، غيّرها». The rule is now
  `{scope: every_instructional_scene, role: primary}`; a pedagogical method may ride as
  supporting. Changed:
  - backend `SUBJECT_TEACHING_SKILL_REQUIREMENT_ROLE = "primary"`;
  - the shared fixture (both repositories, byte-identical);
  - the five Skills' role wording, edited in place at v1, with new digests. v1 was never
    deployed: the last staging TE deploy was 12 Nov, before `ed8a73b5`.
  - the tests.
  Lesson 329 needs a fresh, paid run; its stopped checkpoint must not be resumed.
- **14 Nov 2026, decision 3 → objective teaching stage only.** The Skill applies at
  `outcome_visual_explanations` only. `lesson_opener`, `lesson_learning_map` and
  `outcome_check_understanding` keep v8's policy unchanged.
- **14 Nov 2026, decision 4 → visible in the Workbench.** The five Skills are listed in
  the Workbench picker with en/zh display names. The skill loader is not changed.

## 10. Build record (14 Nov 2026)

Nothing is committed, pushed or deployed. No data change, migration or paid model call
was made.

### 10.1 The five Skills (TE, `skills/agent-runtime/<id>/`)

| Skill | Version | Digest | Title |
| --- | --- | --- | --- |
| `mathematics-academic-teaching` | v1 | `c43c5ca36e7033a4` | تدريس الرياضيات الأكاديمي |
| `physics-conceptual-teaching` | v1 | `6deb5692d2c9025b` | تدريس الفيزياء المفاهيمي |
| `chemistry-scientific-teaching` | v1 | `743917903708511d` | تدريس الكيمياء العلمي |
| `biology-structured-teaching` | v1 | `355b672fceff6315` | تدريس الأحياء المنظّم |
| `arabic-language-teaching` | v1 | `943459b05c78519d` | تدريس اللغة العربية |

Digests as of the decision 2 revision (14 Nov evening). The first build's were
`4023261f…`, `db6e7d39…`, `4df7ac13…`, `407ba33d…` and `168d2c38…`, never deployed.

Each Skill has `SKILL.md`, a byte-identical `versions/v1/SKILL.md`, and
`skill-versions.json`. Each is 5.5–6.8 KB and has the same four parts:
- how it works in the lesson (supporting, Flow-first, grounded);
- the shared principles (spec §2), embedded verbatim;
- the subject method (spec §3–§7);
- slide-role guidance.

### 10.2 TE changes (OpenMAIC slot 2)

- `lib/server/teaching-package/subject-teaching-skills.ts` (new):
  - the subject → Skill map;
  - `subjectTeachingSkillFor`;
  - `assertSubjectTeachingSkillPolicy`, a fail-closed `SKILL_POLICY_INVALID` when a policy
    names another subject's Skill.
- `kafuo-request.ts`: `parseKafuoGenerationRequest` runs the guard on every request.
  Requests naming no subject Skill are untouched.
- `book-coverage.ts`: `isTeacherParityModel` accepts `g5.v9` as well as `g5.v8`.
- `lib/i18n/workbench.ts`: en/zh display names for the five Skills.
- `tests/agent-runtime/skills.test.ts`: the title assertion accepts an Arabic title.
- `tests/fixtures/subject-teaching-skills.v1.json`: the shared fixture, byte-identical to
  the backend copy.

### 10.3 Backend changes (`zakrly-backend/.claude/worktrees/brave-lovelace-c8a556`, branch `claude/priceless-lamarr-4d9937`, on origin/staging `434df233`)

- `curriculums_management/domain/teaching_model.py`:
  - `TEACHING_MODEL_G5_V9_VERSION`;
  - `BOOK_STRUCTURED_TEACHING_MODEL_VERSIONS` + v9;
  - the new `TEACHER_PARITY_TEACHING_MODEL_VERSIONS = {v8, v9}`;
  - the new `SUBJECT_TEACHING_SKILL_MODEL_VERSIONS = {v9}`.

  The governing version stays `g5.v6`.
- `teaching_engine/domain/subject_teaching_skills.py` (new): the mirror map, plus
  `project_subject_teaching_skill`. At `outcome_visual_explanations` it adds the subject
  Skill to `allowed` and a required rule to `required`
  (`every_instructional_scene`, `supporting`).
- `teaching_engine/domain/teaching_model_flows/g5_v9.py` (new): v8's stage objects, all of
  them. It is registered with an import-time assert that v9 reuses v8's stages.
- `curriculums_management/domain/teaching_flows/g5_v9.py` (new): the runtime descriptor,
  which is v8's with identity and display name changed. It is registered.
- `build_generation_request.py`:
  - projects the subject Skill after expansion for v9 only;
  - recall and exercises now apply to every teacher-parity version.
- `generate_lesson_metadata.py`: template out-of-scope units now apply to every
  teacher-parity version, as v8 had them.
- `tests/fixtures/subject-teaching-skills.v1.json`: a copy of TE's.

### 10.4 Tests (stubbed models only; at most 3 files per run)

**TE:**
- New: `subject-teaching-skills.test.ts` and `subject-teaching-skills-prompts.test.ts`,
  70/70. They prove:
  - each Skill resolves at v1, byte-exact;
  - the map matches the fixture;
  - the guard runs at the request seam;
  - g5.v9 selection: supporting passes, missing or as-Primary is
    `SKILL_REQUIREMENT_UNSATISFIED`, another subject is `SKILL_ASSIGNMENT_INVALID`;
  - the parity switch accepts v9;
  - for one lesson per subject, the Skill's own lines are in the slide-content and
    slide-actions (narration) prompts, no other subject's are, and the quiz position never
    gets the Skill.
- Existing, all passing:
  - `canonical-skills`, `skills`, `workbench-i18n`: 192;
  - `skill-policy`, `book-coverage-v8`, `teaching-skills-governance`: 77;
  - `teaching-skills-cross-system`, `classroom-generation-subject-routing`: 36;
  - `kafuo-request`: 31;
  - `skill-handle-inference`, `skill-preload`, `tool-presentation`: 135.
- Static checks:
  - eslint is clean on the touched TS files;
  - prettier is clean on the touched TS/JSON files;
  - `tsc --noEmit`: 0 errors in `lib/`, `tests/`, `app/` and `@openmaic/generation`. The
    67 errors it reports all sit in the untouched renderer, editor and importer packages.

**Backend:**
- New: `test_g5_v9_subject_teaching_skills.py`, 33/33. It covers the fixture mirror, the
  registries, v8 stage reuse and the version sets. It also checks, for each subject:
  - the projection;
  - the wire shape;
  - no-Skill subjects stay v8 byte-for-byte;
  - through the real request use case: a v9 request sends its subject Skill at the
    objective only, a v8 request is unchanged, and a v9 ENGLISH flow equals v8's.
- Existing, all passing:
  - `test_g5_v8_flow_and_book_structure`: its version-set assert updated;
  - `test_teaching_model_flow_registry`, `test_teaching_skills_cross_system`,
    `test_teaching_flow_registry_invariants`: 61 passed, 1 skip, an unprovisioned
    digest-vector copy, pre-existing;
  - `test_game_deferral`, `test_subject_route_refusal`, `test_g5_v8_recall_and_exercises`:
    109.
- Guard file `tests/guards/test_teaching_flow_ownership_boundaries.py`: 6 passed, 2
  failed. The two failures:
  - `test_no_unauthorised_module_resolves_a_flow` (`build_generation_request.py`) is
    listed in `test-baseline.md` as pre-existing. This change adds no resolver call there.
  - `test_the_production_registry_holds_only_the_versioned_g5_flows` is **not** in
    `test-baseline.md`. It pins the registry to {v1, v2, v6}, while the registry on
    origin/staging already holds v1–v8 before this change. Reported as is, not classified
    or edited; this change adds v9 to the same mismatch.
- Full-grep check: no other `g5.v7`/`g5.v8` version switch remains under `app/`. Every
  book-structured or teacher-parity decision now goes through the two version sets.
- The five SKILL.md files are excluded from prettier by `.prettierignore` (`*.md`), so
  their pinned digests are safe from formatting.

### 10.5 Pending gates and gaps

- **Mobile:** add `'g5/g5.v9'` to the supported flows (`teaching_runner_models.dart`).
  This waits for a free mobile slot; all three hold uncommitted work. A tester build must
  ship before any curriculum moves to g5.v9.
- **Data:** moving curricula to g5.v9 is an owner-approved assignment step on the pattern
  of migration 297/326. Not done.
- **Backend lint:** not run. The command guard refuses the `ruff` binary.
- **Not run:** CI, full suites, and a real paid generation, which needs the owner's yes.
  Merge readiness is not claimed.
- **Not committed:** neither repo, and this plan is gitignored (`/docs`). Committing waits
  for the owner.
- **Limitation:** the Skills cannot see Lesson Templates directly. They adapt to the book
  unit kinds and the grounded content only.
- **Limitation:** the planner must copy the required supporting Skill. When it omits it,
  the existing correction and re-roll path handles that (`SKILL_REQUIREMENT_UNSATISFIED`).
