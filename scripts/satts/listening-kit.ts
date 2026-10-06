/**
 * SATTS listening kit (upgrade plan P5 and P8 human gates): renders a
 * curated set of audit cases with the experimental pack (what
 * `SATTS_ALLOW_EXPERIMENTAL=true` would send), synthesises each with the
 * governed voice (Cartesia sonic-3.6, "Reem") and writes a page for the
 * listener's sign-off. Paid API calls: logged in the spike ledger, capped.
 *
 * Usage: npx tsx scripts/satts/listening-kit.ts [--dry-run] [--only id1,id2]
 * (`--only` re-synthesises just those clips; the page is rebuilt for all.)
 * Output: scripts/spikes/satts/out/listening-kit/index.html (+ one mp3 per case),
 * served by the `satts-voice-samples` launch config at /listening-kit/.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateTTS } from '../../lib/audio/tts-providers';
import { DEFAULT_AR_MODEL, DEFAULT_AR_VOICE } from '../../lib/server/speech/config';
import { loadPolicyPack, renderScientificSpeech } from '../../lib/speech/scientific';
import type { ScientificSubjectCode } from '../../lib/speech/scientific/context';

const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'scripts', 'spikes', 'satts', 'out', 'listening-kit');
const LEDGER = join(ROOT, 'scripts', 'spikes', 'satts', 'out', 'ledger.jsonl');
/** Cartesia list price used by the Wave-0 ledger (USD per character). */
const USD_PER_CHAR = 39.2 / 1e6;
const CAP_USD = 5;

/** Audit cases to hear (natural mode unless the case is accessible). */
const CASES = [
  // P5 scope phrasing (O-6)
  'm-group-squared-n', 'm-sum-squared-n', 'm-nested-pow-n', 'm-pow-of-pow-n', 'm-kB-T-n', 'm-neg-x2-n',
  'm-sqrt2-x-n', 'm-x-n-plus-1-n', 'm-x-n-plus-1-group-n', 'm-compound-num-n', 'm-frac-then-factor-n',
  'm-times-whole-squared-n', 'c-complex-outer-n', 'c-complex-inner-n',
  // P4 math
  'm-dydx-slash-n', 'm-a-bc-n', 'm-mixed-frac-n', 'm-mixed-slash-n', 'm-p-of-x-n', 'm-P-of-A-n', 'm-qaf-of-sin-n',
  'm-x-times-group-n', 'm-times-n', 'm-cdot-n', 'm-ascii-x-n', 'm-given-n', 'm-factorial-n', 'm-sin-bare-n',
  // P6 physics
  'p-J-per-kgK-n', 'p-m-s-inv-n', 'p-N-m-n', 'p-text-unit-pow-n', 'p-mathrm-unit-n', 'p-glued-s-n', 'p-bare-unit-n',
  'p-math-cm2-n', 'p-mu-n', 'p-degC-cmd-n', 'p-uncertainty-n',
  // P1/P7 chemistry
  'c-water-n', 'c-sulfate-n', 'c-count-20-n', 'c-300K-n', 'c-decimal-coeff-n', 'c-hydrate-ascii-n',
  'c-ascii-charge-n', 'c-bonds-n', 'c-ce-double-bond-n', 'c-gas-arrow-n', 'c-no-space-reaction-n', 'c-electron-n',
  // P9 arrow condition (O-10)
  'c-delta-ce-n',
  // accessible samples
  'm-dydx-slash-a', 'm-half-x-a', 'm-mixed-frac-a', 'm-p-of-x-a', 'c-water-a',
];

interface AuditCase {
  id: string;
  phase: string;
  subject: ScientificSubjectCode;
  mode: 'natural' | 'accessible';
  original: string;
  expected: string;
  notes: string;
}

function env(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(ROOT, '.env.local'), 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
}

function spent(): number {
  try {
    return readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => sum + (JSON.parse(line) as { estUsd: number }).estUsd, 0);
  } catch {
    return 0;
  }
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const onlyArg = process.argv[process.argv.indexOf('--only') + 1];
  const only = process.argv.includes('--only') && onlyArg ? new Set(onlyArg.split(',')) : null;
  for (const id of only ?? []) if (!CASES.includes(id)) throw new Error(`unknown kit case ${id}`);
  const audit = new Map(
    readFileSync(join(ROOT, 'tests', 'speech', 'scientific', 'golden', 'audit', 'audit-p0.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditCase)
      .map((c) => [c.id, c]),
  );
  const pack = loadPolicyPack('ar', { allowProposed: true });
  const rows = CASES.map((id) => {
    const c = audit.get(id);
    if (!c) throw new Error(`unknown audit case ${id}`);
    const prepared = renderScientificSpeech(
      {
        context: {
          originalText: c.original,
          subjectCode: c.subject,
          subjectSource: 'stage',
          language: 'ar-SA',
          readingMode: c.mode,
          policyVersion: pack.policyVersion,
          policyStatus: pack.status,
        },
      },
      pack,
    ).preparedText;
    return { ...c, prepared };
  });
  const chars = rows.filter((row) => !only || only.has(row.id)).reduce((sum, row) => sum + row.prepared.length, 0);
  const estimate = chars * USD_PER_CHAR;
  console.log(`${rows.length} clips, ${chars} characters, ≈ $${estimate.toFixed(3)} (spent so far $${spent().toFixed(3)})`);
  if (spent() + estimate > CAP_USD) throw new Error('spend cap reached');
  mkdirSync(OUT, { recursive: true });
  const keys = env();
  const apiKey = keys.TTS_CARTESIA_API_KEY || keys.CARTESIA_API_KEY;
  if (!dryRun && !apiKey) throw new Error('TTS_CARTESIA_API_KEY is not set in .env.local');
  for (const [index, row] of rows.entries()) {
    const file = `${String(index + 1).padStart(2, '0')}-${row.id}.mp3`;
    if (dryRun || (only && !only.has(row.id))) continue;
    const audio = await generateTTS(
      { providerId: 'cartesia-tts', apiKey, voice: DEFAULT_AR_VOICE, modelId: DEFAULT_AR_MODEL, language: 'ar-SA', responseFormat: 'mp3' },
      row.prepared,
    );
    writeFileSync(join(OUT, file), audio.audio);
    appendFileSync(
      LEDGER,
      `${JSON.stringify({ t: new Date().toISOString(), task: 'P8-listening-kit', label: `listening-kit/${file}`, status: 200, inputChars: row.prepared.length, inputTok: 0, instrTok: 0, audioSec: null, estUsd: row.prepared.length * USD_PER_CHAR })}\n`,
    );
    process.stdout.write('.');
  }
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SATTS listening kit</title><style>
body{font-family:system-ui,sans-serif;margin:16px;background:#fafafa;color:#111}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ccc;padding:6px;vertical-align:top;font-size:15px}th{background:#e8eef7}code{direction:ltr;unicode-bidi:embed;display:inline-block}
.phase{color:#555;font-size:12px}audio{width:220px}</style></head><body>
<h1>عيّنات الاستماع — ${escape(pack.policyVersion)} (صوت ريم)</h1>
<p>لكل سطر: اسمع، وقرر هل النطق صحيح وطبيعي (P5: هل الأقواس والنطاق واضحة بالأذن؟). اكتب ملاحظاتك في العمود الأخير.</p>
<table><tr><th>#</th><th>المكتوب</th><th>ما يُرسل للصوت</th><th>استمع</th><th>صحيح؟ / ملاحظة</th></tr>
${rows
  .map(
    (row, i) => `<tr><td>${i + 1}<div class="phase">${escape(row.phase)} · ${escape(row.mode)}</div></td><td><code>${escape(row.original)}</code></td><td>${escape(row.prepared)}</td><td><audio controls preload="none" src="${String(i + 1).padStart(2, '0')}-${escape(row.id)}.mp3"></audio></td><td contenteditable="true"></td></tr>`,
  )
  .join('\n')}
</table></body></html>`;
  writeFileSync(join(OUT, 'index.html'), html);
  console.log(`\nwrote ${join(OUT, 'index.html')}`);
}

main().catch((error) => {
  console.error(String(error?.message || error).slice(0, 300));
  process.exit(1);
});
