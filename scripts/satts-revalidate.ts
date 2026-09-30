/**
 * Policy revalidation (plan §13.4). DRY RUN BY DEFAULT: reports, per Stage,
 * which scientific Actions only need their `policyVersion` promoted (prepared
 * text unchanged) and which became stale. `--apply` is refused unless the
 * operator also passes `--confirm-owner-approval`, and even then only the
 * provenance `policyVersion` is rewritten — regeneration is a separate,
 * explicitly confirmed step (D-7). Not to be run with `--apply` without the
 * owner's written approval.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/satts-revalidate.ts [--apply --confirm-owner-approval]
 */
import { revalidateDocument, type MaintenanceDocument } from '@/lib/server/speech/maintenance';
import { loadPolicyPack } from '@/lib/speech/scientific/policy';
import { SCENES_SQL, STAGES_SQL, withReadOnly, type StageRow } from './satts/db-readonly';

async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && !process.argv.includes('--confirm-owner-approval')) {
    console.error('Refusing --apply without --confirm-owner-approval (no data change without approval).');
    process.exit(2);
  }
  if (apply) {
    console.error('The apply step writes through the owner-bound store; run it only in an approved maintenance window.');
    process.exit(2);
  }
  const policy = loadPolicyPack('ar', { allowProposed: false });
  await withReadOnly(async (query) => {
    for (const stage of await query<StageRow>(STAGES_SQL)) {
      const scenes = await query<{ id: string; data: { actions?: unknown[] } }>(SCENES_SQL, [stage.id]);
      const document: MaintenanceDocument = {
        stage: { ...stage.data, id: stage.id },
        scenes: scenes.map((scene) => ({ id: scene.id, actions: scene.data?.actions ?? [] })),
      };
      const { report } = revalidateDocument(document, policy);
      if (report.promotable.length || report.stale.length) console.log(JSON.stringify(report));
    }
  });
}

void main();
