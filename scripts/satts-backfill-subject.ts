/**
 * Subject backfill proposal (plan §18.2 item 1). DRY RUN ONLY in this
 * release: lists Stages without `subjectCode` whose governed attempt carries
 * one. Writing the recovered code back is a separate, explicitly approved
 * operation; `--apply` is refused.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/satts-backfill-subject.ts
 */
import { planSubjectBackfill } from '@/lib/server/speech/maintenance';
import { STAGES_SQL, withReadOnly, type StageRow } from './satts/db-readonly';

async function main() {
  if (process.argv.includes('--apply')) {
    console.error('Refusing --apply: the backfill writes Stages and needs explicit owner approval (plan §18.2).');
    process.exit(2);
  }
  const proposals = await withReadOnly(async (query) => {
    const stages = await query<StageRow>(STAGES_SQL);
    const bySubject = new Map(stages.map((s) => [s.id, s.attempt_subject]));
    return planSubjectBackfill(
      stages.map((s) => ({ id: s.id, subjectCode: s.data?.subjectCode ?? null })),
      async (id) => bySubject.get(id) ?? null,
    );
  });
  console.log(JSON.stringify({ dryRun: true, proposals }, null, 2));
}

void main();
