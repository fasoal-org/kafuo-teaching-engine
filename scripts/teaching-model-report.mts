/**
 * Teaching-model accounting report (Kafuo R1 plan §9.1, P8).
 *
 * Reads ONLY the ledger and the meter outbox in `DATABASE_URL` and prints,
 * per aggregate, a completeness line, cost per turn / conversation / student /
 * subject / model, generation cost per version / attempt, fallback rate by
 * subject and model (incl. `unusable_output`), TTFT / total latency
 * percentiles by model / role / capability, Help spend by origin, budget
 * breaches, the outbox counts with the oldest pending age, and lists every
 * incomplete ledger row and every conflict / terminal_failed finalize.
 *
 * Usage:
 *   pnpm tsx scripts/teaching-model-report.mts [--since 2026-09-01] [--until 2026-10-01] [--tenant 1] [--json]
 *   pnpm tsx scripts/teaching-model-report.mts --help
 */
import { Pool } from 'pg';

// Read-only: a plain `pg` pool on DATABASE_URL (no schema bootstrap, no
// stores). The app modules are CommonJS under tsx (no "type": "module"), so
// this entry is `.mts` and loads the report module through an interop-safe
// dynamic import. `@openmaic/storage` exports `require`/`default` conditions
// next to `import` (same built files) so the persistence modules this report
// reads through resolve `@openmaic/storage/document/pg` under tsx; the report
// builder itself is exercised end to end by tests/usage/reporting-queries.test.ts.
type ReportModule = typeof import('@/lib/server/teaching-model/report');

const USAGE = `Usage: pnpm tsx scripts/teaching-model-report.mts [options]

Reads ONLY the teaching-model ledger and the meter finalize outbox in DATABASE_URL
and prints the accounting report (Kafuo R1 plan §9.1, P8).

Options:
  --since <iso>    include rows started at or after this ISO date/time
  --until <iso>    include rows started before this ISO date/time
  --tenant <id>    restrict to one Kafuo tenant id
  --json           print the report as JSON instead of text
  --help, -h       print this usage and exit (no database needed)

Environment:
  DATABASE_URL     required for every run except --help
`;

async function load<T>(specifier: string): Promise<T> {
  const mod = (await import(specifier)) as T & { default?: T };
  return (mod.default && typeof mod.default === 'object' ? mod.default : mod) as T;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function epochSeconds(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms))
    throw new Error(`--${name} must be an ISO date/time, got ${JSON.stringify(value)}`);
  return ms / 1000;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const connectionString = process.env.DATABASE_URL ?? '';
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const since = epochSeconds(arg('since'), 'since');
  const until = epochSeconds(arg('until'), 'until');
  const tenantId = arg('tenant');
  const { buildTeachingModelReport, renderTeachingModelReport } = await load<ReportModule>(
    '@/lib/server/teaching-model/report',
  );
  const pool = new Pool({ connectionString });
  try {
    const report = await buildTeachingModelReport(pool, {
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
    });
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderTeachingModelReport(report)}\n`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
