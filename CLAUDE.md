# OpenMAIC / Teaching Engine

Next.js app/API: `app/`; server logic: `lib/server/`; rendering/contracts:
`packages/@openmaic/`. Kafuo client: `lib/server/tutor/kafuo-integration-client.ts`;
grants: `lib/server/tutor/student-grant.ts`. Preserve signed handoffs/webhooks, metering,
tenant/student scope and fail-closed behavior. Reuse packages and existing boundaries;
localize UI via `lib/i18n/`. No unsolicited refactors.

`package.json` pins pnpm 10.28.0 and Node >=22.19.0. From this root, replace FILE/SPEC:
- Develop: `pnpm dev` (port 3005).
- Size: `pnpm exec vitest list FILE`; `pnpm exec playwright test SPEC --list`.
- Verify: `pnpm exec vitest run FILE`; browser: `pnpm exec playwright test SPEC` for changed journeys.
- Static: `pnpm exec eslint FILE`; `pnpm exec prettier FILE --check`.
For package changes run the owning package's scoped tests. Map impact first; keep heavy
root/storage/PGlite test groups sequential as in `.github/workflows/ci.yml`.
No default full suites or repository-wide autofixes. Avoid reinstalling dependencies:
postinstall rebuilds packages/vendor output. Keep independent review.

Read `CONTRIBUTING.md` for PR, version-bump, environment and security requirements;
`scripts/check-package-version-bumps.mjs` defines publishable inputs. Focused iteration
checks do not replace required pre-submit CI/static/manual gates; report pending gates.
Relevant contracts: `docs/frds/kafuo-teaching-engine-integration-frd.md` and workspace
`../docs/frds/model_routing/r1-api-contracts.md`. Select the approved scope before reading
large plans. Never publish packages or loosen security guards as incidental validation.

## Enforced testing scope

Map affected modules and select the smallest meaningful test files before verification.
Never automatically run full unit/integration/E2E suites or test after every edit.
Claude Bash and OpenCode/GLM bash use the local command guard; broad runs need explicit
user authorization or approved CI/release workflows. Merge gates stay pending until
authorized/completed. See `tools/testing/README.md` for scope, approval and limitations.
