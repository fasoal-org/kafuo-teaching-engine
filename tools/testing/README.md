# Impact-based testing

Before verification, state affected modules, callers/consumers and selected test files.
Use the smallest meaningful unit/contract/widget/integration/journey scope, normally
1–3 files or nodes. Size that selection using collection/listing where supported;
label static estimates for Flutter/Node. Never run tests after every edit. Run one
focused pass per completed slice; preserve repository timeout/rerun, DB isolation,
security and independent-review rules. Unrelated failures do not expand scope.

The local guard intercepts Claude Bash (`PreToolUse`) and OpenCode bash
(`tool.execute.before`, including GLM). It tokenizes compounds, resolves literal cwd,
shell/env/timeout wrappers, package scripts and pre/post lifecycle scripts, and simple
shell files. Each command group permits at most three existing explicit files/nodes and three runner
invocations (collection, verification, diagnostic). Broad defaults,
directories, globs, recursive scripts, opaque inline code, substitutions, unresolved control
flow, task runners and opaque scripts are denied. `npm test -- FILE` works for Admin;
it does **not** narrow Website's fixed-glob npm script: use Node directly there.
Backend `scripts/ci/run_unit_tests.sh FILE` still selects `tests/unit`: use pytest directly.

Allow examples (replace paths with existing affected tests):
- `.venv/bin/pytest tests/unit/MODULE/test_case.py::test_name -x --tb=short`
- `npm test -- tests/MODULE.test.ts`
- `pnpm exec vitest run tests/MODULE.test.ts`
- `npm run test:e2e -- e2e/MODULE.spec.ts --list`
- `flutter test --no-pub test/MODULE_test.dart`
- `node --test tests/MODULE.test.ts`

Deny examples: `pytest`, `pytest tests/unit -k billing`, `npm test`, `pnpm test`,
`flutter test`, `playwright test`, `node --test 'tests/**/*.test.ts'`,
`bash -lc 'npm test'`, `echo pytest | sh`, `make test`, and an npm alias that resolves
to an unscoped runner. `CI=true`/environment flags do not authorize a broad command.

## Explicit broad authorization

Only when the human chooses a full regression, submit this as the **entire user message**
in the same Claude/OpenCode session (actual absolute cwd and exact command):

```text
APPROVE_FULL_TEST {"cwd":"/absolute/repository","command":"npm test","reason":"Approved release regression"}
```

The user-prompt/chat hook records a session-scoped, exact cwd/command approval, valid
15 minutes and consumed once. Nothing executes when approval is recorded. No wildcard,
environment bypass, automatic authorization from a plan/merge gate, or CI=true override.
Normal agent/tool permissions still apply. Approved CI/release workflows run separately
and remain unchanged. Mandatory Mobile/other merge gates remain pending until authorized
and completed; focused success does not establish merge readiness.

## Maintenance and limits

No dependencies, network calls, suite collection or test execution inside the guard.
`reviewed_scripts.json` permits only explicitly inspected non-testing script hashes;
a changed script loses that exemption. Keep root/repo copies in sync with
`python3 tools/testing/sync_test_policy.py --check` (root only); writes only for maintenance.
Restart Claude/OpenCode sessions to load changed hooks/plugins.

This is a development command guard, not a security sandbox. Editable hooks/approval
storage can be tampered with; hooks can be disabled. Alternate MCP/terminal/custom tools,
user OpenCode shell commands, direct human terminals, nested agents/processes, arbitrary
unrecognized external executables, and tests hidden inside application/config/plugin code
are not universally intercepted. The guard cannot prove semantic impact or runtime
test-case count; agents must still map impact and inspect scoped collection. Unknown *local* script wrappers are denied. Runner
substring/regex filters may match similarly named files; inspect the scoped list first.
Approval covers the command, not mutable script contents. Remote/container execution is
denied unless explicitly approved. Existing worktrees need the configuration integrated;
primary workspace copies do not retroactively update their snapshots.
