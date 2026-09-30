/**
 * T1 — voice screening (D-4). 13 voices × 10 sentences with SAUDI_INSTRUCTIONS_V1, plus marin/cedar without
 * instructions as a control. Writes out/voices/index.html (works from disk). Not shipped.
 * npx tsx scripts/spikes/satts/t1-voices.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_VOICES, PINNED_MODEL, SAUDI_INSTRUCTIONS_V1, SCREENING_SENTENCES } from './fixtures';
import { mp3DurationSec } from './inspect-mp3';
import { guessSec, OUT, preflight, speech, writeOut } from './lib';

const CONTROL_VOICES = ['marin', 'cedar'];

interface Row {
  voice: string;
  control: boolean;
  nn: string;
  category: string;
  file: string;
  status: number;
  ms: number;
  audioSec: number | null;
  error?: string;
}

async function main() {
  const jobs: { voice: string; control: boolean; s: (typeof SCREENING_SENTENCES)[number] }[] = [];
  for (const voice of ALL_VOICES)
    for (const s of SCREENING_SENTENCES) jobs.push({ voice, control: false, s });
  for (const voice of CONTROL_VOICES)
    for (const s of SCREENING_SENTENCES) jobs.push({ voice, control: true, s });
  const resultsPath = join(OUT, 'voices', 'results.json');
  const prior: Row[] = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : [];
  const done = new Set(prior.filter((r) => r.status === 200).map((r) => r.file));
  const todo = jobs.filter((j) => !done.has(fileOf(j)));
  preflight(
    'T1',
    todo.map((j) => ({
      input: j.s.text,
      instructions: j.control ? undefined : SAUDI_INSTRUCTIONS_V1,
    })),
    guessSec,
  );

  const rows: Row[] = prior.filter((r) => r.status === 200);
  for (const j of todo) {
    const file = fileOf(j);
    const r = await speech(
      'T1',
      file,
      {
        model: PINNED_MODEL,
        voice: j.voice,
        input: j.s.text,
        ...(j.control ? {} : { instructions: SAUDI_INSTRUCTIONS_V1 }),
      },
      mp3DurationSec,
    );
    if (r.body.length) writeOut(file, r.body);
    const row: Row = {
      voice: j.voice,
      control: j.control,
      nn: j.s.nn,
      category: j.s.category,
      file,
      status: r.status,
      ms: r.ms,
      audioSec: r.body.length ? mp3DurationSec(r.body) : null,
      error: r.errorBody,
    };
    rows.push(row);
    console.log(`${file} ${r.status} ${r.ms}ms ${row.audioSec?.toFixed(2) ?? '-'}s`);
    writeOut('voices/results.json', JSON.stringify(rows, null, 2));
  }
  writeOut('voices/index.html', html());
}

function fileOf(j: { voice: string; control: boolean; s: { nn: string; category: string } }) {
  return j.control
    ? `voices/_control/${j.voice}/${j.s.nn}.mp3`
    : `voices/${j.voice}/${j.s.nn}-${j.s.category}.mp3`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function html() {
  const cols = [
    ...ALL_VOICES.map((v) => ({ v, control: false })),
    ...CONTROL_VOICES.map((v) => ({ v, control: true })),
  ];
  const rows = SCREENING_SENTENCES.map((s) => {
    const cells = cols
      .map(({ v, control }) => {
        const rel = control ? `_control/${v}/${s.nn}.mp3` : `${v}/${s.nn}-${s.category}.mp3`;
        return `<td><audio controls preload="none" src="${rel}"></audio></td>`;
      })
      .join('');
    return `<tr class="text"><td colspan="${cols.length + 1}" dir="rtl" lang="ar"><b>${s.nn} · ${s.category}</b> — ${esc(s.text)}</td></tr><tr><th>${s.nn}</th>${cells}</tr>`;
  }).join('\n');
  const head = cols
    .map(({ v, control }) => `<th>${v}${control ? '<br><small>no instructions</small>' : ''}</th>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SATTS voice screening</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;background:#fff;color:#111}
table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px;vertical-align:middle}
tr.text td{background:#f5f5f5;font-size:18px;padding:8px}
thead th{position:sticky;top:0;background:#fff;z-index:1}
audio{width:150px;height:32px}
.wrap{overflow-x:auto}
</style></head><body>
<h1>SATTS Wave 0 — voice screening (D-4)</h1>
<p>Model <code>${PINNED_MODEL}</code>, speed 1.0, MP3. Columns 1–13 use the draft instructions <code>ar-SA-saudi-edu-v1</code>; the last two columns are the no-instructions control.
Listen per row, then shortlist 3–4 voices for the formal §12.4 evaluation. Open this file directly from disk; no server needed.</p>
<details><summary>Instructions sent</summary><pre style="white-space:pre-wrap">${esc(SAUDI_INSTRUCTIONS_V1)}</pre></details>
<div class="wrap"><table><thead><tr><th>#</th>${head}</tr></thead><tbody>
${rows}
</tbody></table></div>
<h2>Shortlist (fill in)</h2><ol><li></li><li></li><li></li><li></li></ol>
</body></html>`;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
