/**
 * D-7 read-only legacy inventory (plan §18.2). Counts legacy MATH / PHYSICS /
 * CHEMISTRY Stages, their speech Actions with `legacy` audio (no provenance),
 * how many contain detected expressions, and the regeneration characters and
 * estimated cost. Writes only the Markdown report; never a Stage or asset.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/satts-legacy-inventory.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { inventoryDocument, type InventoryRow, type MaintenanceDocument } from '@/lib/server/speech/maintenance';
import { loadPolicyPack } from '@/lib/speech/scientific/policy';
import { SCENES_SQL, STAGES_SQL, withReadOnly, type StageRow } from './satts/db-readonly';

// Wave 0 measurement: plain Arabic ≈ 9 chars/s and 25 audio tokens/s at $12/1M.
const USD_PER_CHAR = (25 / 9) * (12 / 1e6);

async function main() {
  const policy = loadPolicyPack('ar', { allowProposed: true });
  const rows: InventoryRow[] = await withReadOnly(async (query) => {
    const out: InventoryRow[] = [];
    for (const stage of await query<StageRow>(STAGES_SQL)) {
      const subject = stage.data?.subjectCode ?? stage.attempt_subject;
      if (!subject) continue;
      const scenes = await query<{ id: string; data: { actions?: unknown[] } }>(SCENES_SQL, [stage.id]);
      const document: MaintenanceDocument = {
        stage: { ...stage.data, id: stage.id },
        scenes: scenes.map((scene) => ({ id: scene.id, actions: scene.data?.actions ?? [] })),
      };
      const row = inventoryDocument(document, subject, policy);
      if (row) out.push(row);
    }
    return out;
  });
  const total = (key: keyof InventoryRow) => rows.reduce((n, r) => n + (r[key] as number), 0);
  const date = new Date().toISOString().slice(0, 10);
  const bySubject = ['MATH', 'PHYSICS', 'CHEMISTRY'].map((s) => {
    const r = rows.filter((row) => row.subjectCode === s);
    return `| ${s} | ${r.length} | ${r.reduce((n, x) => n + x.legacyAudioActions, 0)} | ${r.reduce((n, x) => n + x.legacyWithExpressions, 0)} | ${r.reduce((n, x) => n + x.regenerationChars, 0)} |`;
  });
  const report = [
    `# SATTS Legacy Inventory — ${date}`,
    '',
    '- **Source:** read-only transaction on `DATABASE_URL` (plan §18.2, D-7). Nothing was written.',
    '- **Subject:** `Stage.subjectCode`, else the current attempt\'s `subject_code` column (predecessor walk not followed).',
    '- **Detection:** the renderer\'s run detector; regeneration size uses the draft (proposed) policy.',
    '',
    '| Subject | Stages | Legacy-audio Actions | …with detected expressions | Regeneration chars |',
    '|---|---|---|---|---|',
    ...bySubject,
    `| **Total** | ${rows.length} | ${total('legacyAudioActions')} | ${total('legacyWithExpressions')} | ${total('regenerationChars')} |`,
    '',
    `Estimated regeneration cost for the Actions with expressions: **≈ $${(total('regenerationChars') * USD_PER_CHAR).toFixed(2)}** (audio tokens dominate; Wave 0 rates).`,
    '',
    'Product revisits D-7 option "published lessons only" after reading this report.',
    '',
  ].join('\n');
  const path = join(__dirname, '..', 'docs', 'frds', `satts-legacy-inventory-${date}.md`);
  writeFileSync(path, report);
  console.log(`wrote ${path}: ${rows.length} scientific stages`);
}

void main();
