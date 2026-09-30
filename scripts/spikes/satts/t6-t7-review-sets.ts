/**
 * T6 — integer reading (INTEGER_PROBE, marin + instructions) → out/numbers/REVIEW.md
 * T7 — English numerals inside chemical formulas (D-9a gate; marin + cedar + instructions) → out/chemistry/REVIEW.md
 * Not shipped. npx tsx scripts/spikes/satts/t6-t7-review-sets.ts
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHEMISTRY_SENTENCES,
  INTEGER_PROBE,
  PINNED_MODEL,
  SAUDI_INSTRUCTIONS_V1,
} from './fixtures';
import { mp3DurationSec } from './inspect-mp3';
import { guessSec, OUT, preflight, speech, writeOut } from './lib';

async function synth(task: string, file: string, voice: string, input: string) {
  if (existsSync(join(OUT, file)))
    return {
      status: 200,
      audioSec: null as number | null,
      error: undefined as string | undefined,
      skipped: true,
    };
  const r = await speech(
    task,
    file,
    { model: PINNED_MODEL, voice, input, instructions: SAUDI_INSTRUCTIONS_V1 },
    mp3DurationSec,
  );
  if (r.body.length) writeOut(file, r.body);
  console.log(`${file} ${r.status} ${r.ms}ms`);
  return {
    status: r.status,
    audioSec: r.body.length ? mp3DurationSec(r.body) : null,
    error: r.errorBody,
    skipped: false,
  };
}

const cell = (s: string) => s.replace(/\|/g, '\\|');

async function main() {
  preflight(
    'T6+T7',
    [
      ...INTEGER_PROBE.map((x) => ({ input: x.text, instructions: SAUDI_INSTRUCTIONS_V1 })),
      ...CHEMISTRY_SENTENCES.flatMap((x) => [x, x]).map((x) => ({
        input: x.text,
        instructions: SAUDI_INSTRUCTIONS_V1,
      })),
    ],
    guessSec,
  );

  const t6: unknown[] = [];
  for (const it of INTEGER_PROBE) {
    const file = `numbers/${it.id}-${it.range}-${it.script}-${it.gender}.mp3`;
    t6.push({ ...it, file, ...(await synth('T6', file, 'marin', it.text)) });
  }
  writeOut('numbers/results.json', JSON.stringify(t6, null, 2));
  const numRows = INTEGER_PROBE.map((it) => {
    const f = `${it.id}-${it.range}-${it.script}-${it.gender}.mp3`;
    return `| ${it.id} | ${it.range} | ${it.script} | ${it.gender} | <span dir="rtl">${cell(it.text)}</span> | <span dir="rtl">${cell(it.expected)}</span> | [▶](${f}) | |`;
  });
  writeOut(
    'numbers/REVIEW.md',
    `# T6 — Integer reading review (SATTS Wave 0)

Voice \`marin\`, model \`${PINNED_MODEL}\`, instructions \`ar-SA-saudi-edu-v1\`, speed 1.0.

**How to review.** Play each clip. Mark **Y** only if the number is spoken with the right value **and** the right
gender agreement with the counted noun (MSA). Mark **N** otherwise and write what you heard in *notes*.
The *expected* column is the spike author's reference. Correct it if it is wrong, and note the correction.

**Decision rule (plan §10.1).** If fewer than **98%** of the reference integers are voiced correctly
(i.e. fewer than 49 of 50), a deterministic Arabic number-to-words module is added to Wave 2.

| # | range | digits | noun gender | text | expected spoken | audio | correct? (Y/N) | notes |
|---|---|---|---|---|---|---|---|---|
${numRows.map((r) => r + ' |').join('\n')}

**Totals:** Y = ___ / 50 → ___ %  ⇒ contingency triggered? ___
`,
  );

  const t7: unknown[] = [];
  for (const it of CHEMISTRY_SENTENCES) {
    for (const voice of ['marin', 'cedar']) {
      const file = `chemistry/${voice}/${it.id}.mp3`;
      t7.push({ ...it, voice, file, ...(await synth('T7', file, voice, it.text)) });
    }
  }
  writeOut('chemistry/results.json', JSON.stringify(t7, null, 2));
  const chemRows = CHEMISTRY_SENTENCES.map(
    (it) =>
      `| ${it.id} | \`${it.formula}\` | ${it.englishCounts.join(', ') || '—'} | <span dir="rtl">${cell(it.text)}</span> | [marin](marin/${it.id}.mp3) | | [cedar](cedar/${it.id}.mp3) | | |`,
  );
  writeOut(
    'chemistry/REVIEW.md',
    `# T7 — English numerals inside chemical formulas (D-9a gate)

Model \`${PINNED_MODEL}\`, instructions \`ar-SA-saudi-edu-v1\`, speed 1.0. Voices \`marin\` and \`cedar\`.
Letter and numeral spellings in Arabic script are **provisional** (\`chem-letters.json\` is not approved yet).

**How to review.** For each clip, mark **Y** only if every English count ("تو", "ثري", "فور", …) is clearly
pronounced as the English number, inside otherwise natural Arabic speech, **and** the letter names and Arabic
coefficients ("اثنان") are correct. Mark **N** and describe the problem otherwise.

**Gate (plan §10.3, D-9a).** If the English counts are not clearly and correctly pronounced, D-9a returns to product.

| # | formula | English counts | text | marin | marin OK? (Y/N) | cedar | cedar OK? (Y/N) | notes |
|---|---|---|---|---|---|---|---|---|
${chemRows.join('\n')}

**Totals:** marin ___ / 12, cedar ___ / 12 ⇒ D-9a gate passed? ___
`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
