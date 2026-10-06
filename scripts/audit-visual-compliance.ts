/**
 * Visual-compliance audit of EXISTING Teaching Packages (RSS 7.5.8).
 *
 * READ-ONLY on packages: it walks approved / superseded Stages, resolves each
 * image element to bytes, runs `screenVisual`, and writes VERDICTS to the
 * verdict store plus a Markdown report. It writes nothing to any Stage or scene
 * document, and deletes nothing. It is run explicitly by an operator.
 *
 * A `rejected` verdict is what the learner delivery boundary withholds (the
 * read-grant overlay and the media route). `unresolved` results on legacy
 * packages are listed for operator review and are NOT withheld (RSS-FR-125).
 * Remediation (regenerate / replace the image) stays operator-triggered.
 *
 * Usage:
 *   pnpm tsx scripts/audit-visual-compliance.ts [--out report.md]
 *   pnpm tsx scripts/audit-visual-compliance.ts --confirm <sha256> --by <operator> [--verdict rejected|approved]
 *
 * Requires DATABASE_URL, and a vision model (VISUAL_COMPLIANCE_MODEL, or a
 * vision-capable DEFAULT_MODEL) — without one every unscreened visual is
 * reported `unresolved`.
 */
import { writeFileSync } from 'node:fs';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  getVerdictStore,
  resolveMoeBrandProfile,
  screenVisualWithDefaults,
} from '@/lib/server/visual-compliance';
import { bytesOfSource } from '@/lib/server/visual-compliance/stage-gate';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function confirm(checksum: string, by: string, verdict: 'rejected' | 'approved') {
  const profile = resolveMoeBrandProfile();
  const store = await getVerdictStore();
  await store.put({
    profileId: profile.id,
    checksum,
    verdict,
    reasons: [`operator-confirmed ${verdict}`],
    method: 'operator',
    screenedAt: Date.now(),
    confirmedBy: by,
  });
  console.log(`Confirmed ${checksum} as ${verdict} by ${by} (profile ${profile.id}).`);
}

async function audit() {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const { rows } = await pool.query(
    `SELECT id, current_stage_id, status FROM teaching_package_versions
      WHERE status IN ('approved','superseded') ORDER BY approved_at NULLS LAST`,
  );
  const documents = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const lines: string[] = [
    '# Visual compliance audit',
    '',
    `Profile: \`${resolveMoeBrandProfile().id}\` · packages: ${rows.length} · generated ${new Date().toISOString()}`,
    '',
    '| package version | stage | scene | element | verdict | method | reasons | checksum |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const totals = { approved: 0, rejected: 0, unresolved: 0 };

  for (const row of rows as Array<{ id: string; current_stage_id: string }>) {
    const document = await documents.loadDocument(row.current_stage_id);
    if (!document) continue;
    for (const scene of document.scenes) {
      if (scene.type !== 'slide' || scene.content.type !== 'slide') continue;
      for (const element of scene.content.canvas.elements) {
        if (element.type !== 'image' || !element.src) continue;
        const source = await bytesOfSource(element.src);
        if (!source) {
          totals.unresolved += 1;
          lines.push(
            `| ${row.id} | ${row.current_stage_id} | ${scene.id} | ${element.id} | unresolved | none | bytes not readable (external source) | — |`,
          );
          continue;
        }
        const verdict = await screenVisualWithDefaults(source.bytes, {
          origin: 'existing-package',
          ...(source.mimeType ? { mimeType: source.mimeType } : {}),
        });
        totals[verdict.verdict] += 1;
        if (verdict.verdict !== 'approved') {
          lines.push(
            `| ${row.id} | ${row.current_stage_id} | ${scene.id} | ${element.id} | **${verdict.verdict}** | ${verdict.method} | ${verdict.reasons.join('; ')} | \`${verdict.checksum}\` |`,
          );
        }
      }
    }
  }

  lines.push(
    '',
    `Totals — approved: ${totals.approved}, rejected: ${totals.rejected}, unresolved: ${totals.unresolved}.`,
    '',
    '`rejected` visuals are withheld at the learner delivery boundary immediately (stored documents are unchanged). `unresolved` visuals on existing packages stay visible and need operator review: confirm with `--confirm <checksum> --by <operator>`. Remediate by regenerating the scene or replacing the image in the editor.',
  );
  const out = arg('out') ?? 'visual-compliance-audit.md';
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`Report written to ${out}:`, totals);
  await pool.end().catch(() => {});
}

const checksum = arg('confirm');
const operator = arg('by');
if (checksum && !operator) {
  console.error('--confirm requires --by <operator>: a confirmation is always attributed.');
  process.exit(1);
}
const run = checksum
  ? confirm(checksum, operator!, (arg('verdict') as 'rejected' | 'approved') ?? 'rejected')
  : audit();
run.catch((error) => {
  console.error(error);
  process.exit(1);
});
