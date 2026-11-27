/**
 * S6 stage export (source-fidelity s6-s7-readiness §1.4 G0, §1.8): saves one teaching
 * package's current stage, its producing attempt and that attempt's ledger before a
 * full regeneration destroys them. READ-ONLY; see
 * `lib/server/teaching-package/s6-stage-export.ts` for what is read and written.
 *
 * Usage:
 *   pnpm exec tsx scripts/export-package-stage-for-s6.mts --tenant 1 --version tpv-... \
 *     --out ../source-fidelity-benchmark/s6 [--te-url https://...] [--label before-s6] [--no-http]
 *   pnpm exec tsx scripts/export-package-stage-for-s6.mts --help
 *
 * Run it only where the owner has opened read access, against the Teaching Engine's own
 * database. It never writes to the database: the pool connects with
 * `default_transaction_read_only=on` and the export refuses any other connection.
 */
import { Pool } from 'pg';

type ExportModule = typeof import('@/lib/server/teaching-package/s6-stage-export');

const USAGE = `Usage: pnpm exec tsx scripts/export-package-stage-for-s6.mts [options]

Saves under <out>/<learningItemId>/<attemptId>[__<label>]/ the version's stage
(document_stages, document_scenes, document_outlines, stage_meta), the version row,
its producing attempt, that attempt's Content Units, ledger rows and narration usage,
the version's review events, slide regenerations and insertions, and (unless
--no-http) GET .../agent-read/scenes and GET .../outline. Writes manifest.json with
each file's sha256. Never writes to the database.

Options:
  --tenant <id>     the Kafuo tenant id (required)
  --version <id>    the teaching package version id, tpv-... (required)
  --out <dir>       the export root, e.g. source-fidelity-benchmark/s6 (required)
  --te-url <url>    the Teaching Engine base URL for the two HTTP reads
  --no-http         skip the HTTP reads (recorded as skipped in the manifest)
  --label <name>    folder suffix, when the same attempt is exported twice
  --help, -h        print this usage and exit (no database needed)

Environment:
  DATABASE_URL                  the Teaching Engine database (required)
  TEACHING_ENGINE_SERVICE_KEY   the service key for the HTTP reads (never printed)
`;

async function load<T>(specifier: string): Promise<T> {
  const mod = (await import(specifier)) as T & { default?: T };
  return (mod.default && typeof mod.default === 'object' ? mod.default : mod) as T;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = arg(name);
  if (!value || value.startsWith('--')) throw new Error(`--${name} is required (see --help)`);
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const tenantId = required('tenant');
  const versionId = required('version');
  const outRoot = required('out');
  const noHttp = process.argv.includes('--no-http');
  const teUrl = noHttp ? null : (arg('te-url') ?? null);
  if (!noHttp && !teUrl) throw new Error('pass --te-url for the HTTP reads, or --no-http');
  const label = arg('label');
  const connectionString = process.env.DATABASE_URL ?? '';
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const serviceKey = teUrl ? process.env.TEACHING_ENGINE_SERVICE_KEY?.trim() || null : null;

  const { collectS6StageExport, writeS6StageExport } = await load<ExportModule>(
    '@/lib/server/teaching-package/s6-stage-export',
  );
  const pool = new Pool({
    connectionString,
    options: '-c default_transaction_read_only=on',
    max: 1,
  });
  try {
    const exported = await collectS6StageExport({
      queryable: pool,
      tenantId,
      versionId,
      teUrl,
      serviceKey,
    });
    const { dir, files } = await writeS6StageExport(outRoot, exported, label ? { label } : {});
    process.stdout.write(
      `Exported ${exported.manifest.sceneCount as number} scenes and ` +
        `${exported.manifest.ledgerRowCount as number} ledger rows of ${versionId} ` +
        `(attempt ${exported.attemptId}) to ${dir} (${files.length} files + manifest.json)\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
