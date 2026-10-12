---
name: zakrly-fast-implementation
description: Execute an approved Kafuo or Zakrly implementation plan with reuse-first changes, isolated parallel work, focused validation, and independent review. Invoke manually after planning; does not author or replace specifications.
argument-hint: "[BRD/spec path] [approved plan path] [scope] | check"
disable-model-invocation: true
user-invocable: true
---

# Zakrly Fast Implementation

Use this workflow only when the user invokes `/zakrly-fast-implementation`.
Arguments: $ARGUMENTS

The workspace `.claude/skills/zakrly-fast-implementation/SKILL.md` is the canonical
source. Identical, self-contained repository copies support standalone checkouts
and future worktrees. From the workspace, use
`python3 .claude/skills/zakrly-fast-implementation/scripts/sync_skill.py --check`
to check parity; use `--write` only when explicitly maintaining this Skill.
Do not synchronize Skills as a side effect of implementation.

## Read-only invocation check

If the entire argument is `check`, report `ZAKRLY_FAST_IMPLEMENTATION_LOADED`,
the current working directory, and the applicable repository row below (or
`workspace: select affected repositories`). State that invocation is manual,
implementation requires exact approved inputs, repository safeguards take
precedence, and independent review is required. Do not edit files, execute
shell commands, run tests, start services, or delegate. Then stop. This checks
command loading, not implementation readiness or successful application tests.

## Authority and scope

- Require exact readable paths to the authoritative BRD/spec and approved plan,
  plus the requested scope: full plan, phase, or named work packages. A Spec Kit
  `spec.md` and `plan.md` qualify; consume existing `tasks.md` when applicable.
  If inputs or approval are missing, report the missing input and stop. Do not
  guess which similarly named document or older draft is authoritative.
- Read applicable ancestor and repository `CLAUDE.md`, their imports, `AGENTS.md`,
  scoped rules, and the relevant existing constitution and contributor guidance.
  Apply repository-specific rules to each affected repository. This Skill does
  not override those rules, user constraints, or tool permissions.
- The BRD/spec controls approved product behavior; the plan controls technical
  sequencing. Report material contradictions with exact file/function evidence
  and the smallest proposed adjustment. Stop only the affected package while
  independent work continues. Do not silently redesign or rewrite artifacts.
- Preserve architecture, domain/application/infrastructure/presentation boundaries,
  existing ports, dependency wiring, compatibility, and API contracts. Do not
  bypass boundaries through direct cross-module persistence access.
- Preserve Spec Kit feature selection, dependencies, checklist and approval gates,
  and task tracking. Run its prerequisite command from the owning repository
  only when this is a Spec Kit task. Report branch/path resolution failures;
  do not regenerate artifacts, disable gates, or switch branches to evade them.
  One coordinator updates completed task entries after verification, never
  concurrent agents. Do not update Spec Kit artifacts outside the authorized task.
- Invocation authorizes work within the approved scope, not deployment, database
  resets, destructive device operations, external messages, or unrelated changes.

## Preflight and reuse

1. Establish affected repository roots, branches/commits, current dirty files,
   and read-only dependencies. Preserve unrelated staged, unstaged, and untracked
   work; never reset, stash, overwrite, or stage it incidentally.
2. Read authoritative inputs once, then inspect only impacted entry points,
   existing abstractions, callers, contracts, and relevant tests. Use indexed
   search or outlines before large reads. Reuse existing memory/exploration
   tools when available; verify recalled facts against the current code.
3. Classify each change: **REUSE AS-IS → ADAPT → EXTEND → NEW → REPLACE**.
   Leave working code alone; prefer small adapters and established abstractions.
   New code requires checking for an existing capability. Replacement requires
   evidence that reuse/adaptation/extension cannot safely satisfy the requirement.
4. Keep unrelated refactors, folder reorganizations, renames, generic frameworks,
   dependencies, and speculative abstractions out of scope. Report unrelated
   debt only when it materially affects the requested work.

## Orchestration and isolation

- Build a dependency graph by change surface, not task count. Use existing
  subagents when available rather than requiring new plugins or agent files.
  Give each worker its exact requirement, approved contract, repository rules,
  owned files, prohibited/shared files, and smallest verification command.
- Parallel implementation requires a separate worktree/checkout for every writer,
  an explicitly verified base commit, and an integration owner. Do not rely on
  default background isolation. A new worktree does not include uncommitted work;
  do not dispatch against a base missing required changes or contracts.
- Assign one owner for each change. The coordinator owns shared registrations,
  dependency wiring, API contracts, migration-chain integration, lockfiles, and
  task tracking. Serialize dependent work and integration; do not parallel-edit
  shared files even when branches are isolated.
- Worktrees do not isolate databases, Redis, storage, ports, output directories,
  device state, or CPU/memory. Give services separate resources before concurrent
  execution. Do not run concurrent backend database sessions without proven
  fixture isolation and repository authorization. Keep heavy OpenMAIC test
  groups sequential where its CI/configuration requires this.
- If isolation or agents are unavailable, implement sequentially. Independent
  review remains required; do not relabel self-review as independent review.
- Worker reports include status, files/commit, reused code, behavior, exact test
  commands and outcomes, discovered dependencies, and unresolved risks. Workers
  report boundary expansion to the coordinator before editing outside ownership.

## Focused validation

- Choose the smallest meaningful affected unit, component, contract, widget,
  integration, or journey tests. Selection follows actual changed behavior and
  repository policy; targeted integration/E2E checks are not blanket-prohibited.
- Run one focused verification pass per completed slice, normally 1–3 relevant
  files/nodes. Use a tool/process timeout of at most two minutes per focused
  command. On timeout, split once; if still over budget, report and stop that
  validation. Do not conceal long runs with output-truncating pipes.
- Follow repository failure/rerun limits. Backend allows one targeted diagnostic
  rerun (`-vv -x --durations=20`); after failure, report and stop as its rules
  require. Do not diagnose or fix unrelated failures or expand the test surface.
  Where policy allows an in-scope fix, rerun only tests invalidated by that fix.
- Never reconstruct a baseline by broad testing or comparing suite pass counts.
  Backend pre-existing-failure claims require `test-baseline.md`; elsewhere cite
  a documented baseline. Without evidence, report an unclassified failure.
- Never automatically run full suites or broad integration/cross-flow regression.
  Preserve mandatory merge/release gates: if a gate is outside authorized focused
  validation, record it as pending and do not claim merge/release readiness.
- A timeout, interruption, still-running command, skipped required test, or
  mocked-only check of a real database/provider requirement is not a pass.
  Unit tests with fakes are valid for branching/business logic; they do not
  establish persistence, migration, provider, or end-to-end correctness.
- Do not run tests for unaffected repositories. Do not install dependencies,
  run migrations, regenerate code, start services, or execute builds just because
  a command appears below; do so only when needed for the authorized change.

## Repository-specific routing

Treat these as routing hints; inspect current repository instructions and scripts
before choosing a command. Commands use paths selected for the actual change.

| Repository | Boundaries and validation |
| --- | --- |
| `zakrly-backend` | Code: `app/modules/`; tests: `tests/`. Read `CLAUDE.md` and the existing constitution. Use `.venv/bin/pytest <file-or-node> -x --tb=short --durations=10`. Unit fakes cover branching; use targeted real disposable DB tests when schema, SQL, constraints, transactions, or persistence matter. Preserve `tests/db_safety.py`, fixture locks, fresh-schema rules, remote-host restrictions, and the no-concurrent-content-sources-tests rule. Check running pytest processes before required integration work; identify ownership before stopping a stale process. Never run unrelated migrations or services. |
| `zakrly-admin-panel` | Code: `src/`; tests: `tests/`. Read `CLAUDE.md`, `AGENTS.md`, and constitution. Preserve the thin-client/data-provider pattern. Use `npm test -- <test-file>`; use `npm run test:e2e -- <spec>` for changed critical journeys as required by policy. Keep mocks deterministic and verify endpoint contracts and unauthorized/error states. Preserve build/lint and relevant journey gates before merge; a generated broad command does not supersede the focused-testing policy. Reuse Impeccable only for relevant UI work. |
| `Zakrly-mobile-app` | Code: `lib/features/`; tests: `test/`. Read `CLAUDE.md` and constitution; actual layout wins over placeholder paths. Preserve MVVM, Riverpod/DI, repository boundaries, network-layer Dio, design-system and localization patterns. Use `flutter test <test-file>` and relevant widget/integration tests; format changed Dart files and run required analyzer checks. Regenerate annotated outputs only when needed, never hand-edit generated files. The constitution requires full `flutter test` before merge except a documented external blocker: defer that broad gate explicitly when not authorized; focused success alone is not merge readiness. |
| `kafuo-website` | Inspect `src/app/`, current `package.json`, and `CLAUDE.md` imports. Follow `AGENTS.md`: read the relevant installed Next.js guide under `node_modules/next/dist/docs/` before writing website code. Use `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test <test-file>` for affected Node tests. Check lint/type/build behavior when the change requires it; do not run the all-files test script automatically. Preserve existing auth, payment, API, and rendering contracts. |
| `OpenMAIC` | Code: `app/`, `lib/`, `packages/`; inspect `CONTRIBUTING.md`, package scripts, and relevant CI/configuration. Use the declared pnpm/Node versions and `pnpm exec vitest run <test-file>` from the owning package/root. Preserve package export/import boundaries, generated assets, i18n, version/internal-dependency contracts, and PostgreSQL contract guards. Installation/postinstall builds packages and may rewrite tracked assets; do not reinstall casually. Avoid concurrent heavy PGlite suites. Preserve required static checks/manual regression/CI before ready-for-review, without running broad suites automatically or treating a staging build as full CI. |

## Integration, independent review, and completion

1. The coordinator integrates verified packages and inspects shared wiring and
   final diff. Run focused tests only for integration changes that invalidate
   existing evidence; avoid confidence reruns.
2. Assign a reviewer who did not implement the affected work. Review a fixed
   final commit/diff against the BRD/spec, plan, relevant repository rules, and
   test evidence. The reviewer stays read-only and does not run broad tests.
   Check missing entry points, duplicate authorities, authorization bypasses,
   lineage/idempotency, migrations, compatibility, scope drift, and missing tests.
3. Findings need severity (**BLOCKER/HIGH/MEDIUM/LOW**), exact file/function
   evidence, impact, and smallest mitigation. Route confirmed fixes to the owner;
   document rejected findings briefly. Material fixes require focused retesting
   and a focused independent follow-up review.
4. Declare requested implementation complete only when approved scope is
   integrated, required focused validation passes, independent review is complete,
   and no BLOCKER/HIGH remains. If review or validation cannot run, report PARTIAL
   or BLOCKED. Separately report pending merge/release gates and manual checks;
   never infer production readiness from focused tests.
5. Return a concise report: status; authoritative paths and scope; repositories,
   branches/commits and changed files; reuse decisions; exact validation commands
   with pass/fail/timeout/deferred results; independent reviewer and findings;
   unresolved work and merge/release gates. Estimates, when useful, describe the
   elapsed critical path (longest parallel branch + sequential dependencies +
   integration + verification + review), with assumptions rather than false precision.
