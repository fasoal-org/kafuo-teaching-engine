/**
 * T10 — Saudi accent follow-up (user objection: Wave 0 samples sound like newsreader MSA).
 * 3 sentences × 3 variants × 2 voices = 18 calls. Writes out/accent/index.html. Not shipped.
 *   A  current: MSA text + ar-SA-saudi-edu-v1 instructions
 *   B  stronger accent: same MSA text + explicit Riyadh-teacher accent instructions
 *   C  dialect: the same meaning written in "white" Saudi dialect + dialect instructions
 * npx tsx scripts/spikes/satts/t10-accent.ts
 */
import { PINNED_MODEL, SAUDI_INSTRUCTIONS_V1 } from './fixtures';
import { mp3DurationSec } from './inspect-mp3';
import { guessSec, preflight, speech, writeOut } from './lib';

const VOICES = ['marin', 'cedar'];

const INSTR_B =
  'Accent: clearly Saudi, specifically Riyadh (Najdi). Sound exactly like an educated Saudi school teacher ' +
  'reading the textbook aloud to students in a Saudi classroom: Saudi vowel colour, Saudi intonation and rhythm. ' +
  'Not Egyptian, not Levantine, and not a formal news anchor. ' +
  'Read every word exactly as written; do not add, remove or change any word. ' +
  'Clear numbers and terms, brief pauses at commas, calm warm pace.';

const INSTR_C =
  'Speak in natural, warm Saudi Arabic dialect (Riyadh, Najdi), like a friendly Saudi teacher explaining ' +
  'to students in class. Read the text exactly as written; do not add, remove or change any word. ' +
  'Clear numbers and terms, brief pauses at commas, calm pace.';

const SENTENCES = [
  {
    nn: '01',
    label: 'prose',
    msa: 'في هذا الدرس سنتعرف على ثلاث أفكار رئيسية، ثم نحل 12 تمرينًا معًا.',
    saudi: 'في هذا الدرس راح نتعرف على ثلاث أفكار رئيسية، وبعدها نحل 12 تمرين سوا.',
  },
  {
    nn: '03',
    label: 'math',
    msa: '3 على 4 زائد س تربيع، أكبر من أو يساوي، 5.',
    saudi: 'عندنا 3 على 4 زائد س تربيع، وهذي أكبر من أو تساوي 5.',
  },
  {
    nn: '07',
    label: 'chemistry',
    msa: 'يتكون جزيء الماء، إتش تو أو، من ذرتي هيدروجين وذرة أكسجين واحدة.',
    saudi: 'جزيء الماء، إتش تو أو، يتكون من ذرتين هيدروجين وذرة أكسجين وحدة.',
  },
];

const VARIANTS = [
  { id: 'A', name: 'A · MSA + current instructions', text: (s: (typeof SENTENCES)[number]) => s.msa, instr: SAUDI_INSTRUCTIONS_V1 },
  { id: 'B', name: 'B · MSA + stronger Riyadh-accent instructions', text: (s: (typeof SENTENCES)[number]) => s.msa, instr: INSTR_B },
  { id: 'C', name: 'C · white Saudi dialect wording + dialect instructions', text: (s: (typeof SENTENCES)[number]) => s.saudi, instr: INSTR_C },
];

async function main() {
  const jobs = SENTENCES.flatMap((s) =>
    VARIANTS.flatMap((v) => VOICES.map((voice) => ({ s, v, voice }))),
  );
  preflight(
    'T10',
    jobs.map((j) => ({ input: j.v.text(j.s), instructions: j.v.instr })),
    guessSec,
  );
  for (const j of jobs) {
    const file = `accent/${j.s.nn}-${j.v.id}-${j.voice}.mp3`;
    const r = await speech(
      'T10',
      file,
      { model: PINNED_MODEL, voice: j.voice, input: j.v.text(j.s), instructions: j.v.instr },
      mp3DurationSec,
    );
    if (r.body.length) writeOut(file, r.body);
    console.log(`${file} ${r.status} ${r.ms}ms`);
  }
  writeOut('accent/index.html', html());
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function html() {
  const body = SENTENCES.map((s) => {
    const rows = VARIANTS.map(
      (v) =>
        `<tr><th>${esc(v.name)}</th><td dir="rtl" lang="ar">${esc(v.text(s))}</td>${VOICES.map(
          (voice) => `<td><audio controls preload="none" src="${s.nn}-${v.id}-${voice}.mp3"></audio></td>`,
        ).join('')}</tr>`,
    ).join('');
    return `<h2>${s.nn} · ${s.label}</h2><table><thead><tr><th>Variant</th><th>Text sent</th>${VOICES.map((v) => `<th>${v}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SATTS accent test</title>
<style>body{font-family:system-ui,sans-serif;margin:16px}table{border-collapse:collapse;margin-bottom:24px}
td,th{border:1px solid #ddd;padding:6px;vertical-align:middle;text-align:start}td[lang=ar]{font-size:18px;max-width:420px}
audio{width:200px}</style></head><body>
<h1>Saudi accent test (T10)</h1>
<p>Model <code>${PINNED_MODEL}</code>. A = today, B = same MSA text with stronger Riyadh-accent instructions, C = the same meaning written in white Saudi dialect.</p>
<details><summary>Instructions per variant</summary>${VARIANTS.map((v) => `<p><b>${v.id}</b>: ${esc(v.instr)}</p>`).join('')}</details>
${body}</body></html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
