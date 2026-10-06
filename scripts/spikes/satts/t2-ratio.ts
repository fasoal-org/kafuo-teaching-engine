/**
 * T2.1 — Arabic o200k tokens-per-character ratio per fixture category (local, no API calls). Not shipped.
 * ESTIMATE: the TTS tokenizer is undocumented (T3 later showed usage.input_tokens ≈ o200k count).
 * npx tsx scripts/spikes/satts/t2-ratio.ts
 */
import {
  CHEMISTRY_SENTENCES,
  INTEGER_PROBE,
  SAUDI_INSTRUCTIONS_V1,
  SCREENING_SENTENCES,
} from './fixtures';
import { stats, tok, writeOut } from './lib';

const groups: Record<string, string[]> = {};
const add = (k: string, s: string) => (groups[k] ??= []).push(s);
for (const s of SCREENING_SENTENCES) add(`screening:${s.category}`, s.text);
for (const s of INTEGER_PROBE) add(`integer:${s.range}:${s.script}`, s.text);
for (const s of CHEMISTRY_SENTENCES) add('chemistry-d9a', s.text);
groups['ALL screening'] = SCREENING_SENTENCES.map((s) => s.text);
groups['ALL integer probe'] = INTEGER_PROBE.map((s) => s.text);

const rows = Object.entries(groups).map(([k, xs]) => {
  const r = stats(xs.map((x) => tok(x) / x.length));
  return {
    group: k,
    n: xs.length,
    chars: xs.reduce((a, x) => a + x.length, 0),
    tokens: xs.reduce((a, x) => a + tok(x), 0),
    mean: +r.mean.toFixed(3),
    p95: +r.p95.toFixed(3),
    max: +r.max.toFixed(3),
  };
});
const instr = { chars: SAUDI_INSTRUCTIONS_V1.length, tokens: tok(SAUDI_INSTRUCTIONS_V1) };
writeOut(
  'ratio/results.json',
  JSON.stringify({ label: 'estimate (o200k_base)', instructions: instr, rows }, null, 2),
);
console.log('instructions', instr);
console.table(rows);
