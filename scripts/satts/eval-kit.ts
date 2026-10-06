/**
 * SATTS listening-evaluation kit generator (plan §12.4, FRD §27.3, Wave 9).
 *
 * 1. Renders the draft reference set (`tests/speech/scientific/golden/*.jsonl`)
 *    through the REAL renderer (natural reading for every case; accessible as
 *    well for the `modes` category).
 * 2. Synthesises each rendering with every voice in `SATTS_EVAL_VOICES`
 *    (default `marin,cedar` until H1 names the shortlist), with the
 *    `ar-SA-saudi-edu-v1` instructions AND without them (the control), on the
 *    pinned model at speed 1.0.
 * 3. Writes a blind, randomised listening page, a rating sheet (CSV) and a
 *    separate answer key to `scripts/spikes/satts/out/eval-kit/` (git-ignored).
 *
 * Every paid call goes through the Wave 0 client (`scripts/spikes/satts/lib.ts`):
 * same key handling (never printed), same ledger. The run refuses to start when
 * the ledger total plus the pessimistic estimate would exceed the $5 cap.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/satts/eval-kit.ts            # estimate only
 *   npx tsx --tsconfig tsconfig.json scripts/satts/eval-kit.ts --run      # synthesise
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DELIVERY_INSTRUCTIONS_AR_SA_V1 } from '@/lib/server/speech/delivery-instructions';
import { inspectMp3 } from '@/lib/server/speech/audio-concat';
import { renderScientificSpeech, loadPolicyPack } from '@/lib/speech/scientific';
import type { ScientificSubjectCode } from '@/lib/speech/scientific/context';
import { CAP_USD, estimateUsd, spentUsd, speech, tok, writeOut } from '../spikes/satts/lib';

const GOLDEN = join(__dirname, '..', '..', 'tests', 'speech', 'scientific', 'golden');
const MODEL = 'gpt-4o-mini-tts-2025-12-15';
const VOICES = (process.env.SATTS_EVAL_VOICES || 'marin,cedar').split(',').map((v) => v.trim()).filter(Boolean);
/** Pessimistic speaking rate for the estimate (Wave 0 measured 8–10 chars/s). */
const PESSIMISTIC_CHARS_PER_SEC = 7;
const CONCURRENCY = 4;

interface GoldenCase {
  id: string;
  category: string;
  subject: ScientificSubjectCode;
  original: string;
}

interface Clip {
  clip: string;
  caseId: string;
  category: string;
  subject: string;
  mode: 'natural' | 'accessible';
  voice: string;
  instructed: boolean;
  original: string;
  prepared: string;
}

/** Deterministic shuffle (mulberry32) so the blind order is reproducible from the key. */
function shuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function loadCases(): GoldenCase[] {
  return readdirSync(GOLDEN)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((file) =>
      readFileSync(join(GOLDEN, file), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as GoldenCase),
    );
}

function planClips(): Clip[] {
  // Draft policy (proposed entries) — the evaluation judges the draft before approval.
  const policy = loadPolicyPack('ar', { allowProposed: true });
  const renders: Array<Omit<Clip, 'clip' | 'voice' | 'instructed'>> = [];
  for (const c of loadCases()) {
    const modes: Array<'natural' | 'accessible'> = c.category === 'modes' ? ['natural', 'accessible'] : ['natural'];
    for (const mode of modes) {
      const prepared = renderScientificSpeech(
        {
          context: {
            originalText: c.original,
            subjectCode: c.subject,
            subjectSource: 'stage',
            language: 'ar-SA',
            readingMode: mode,
            policyVersion: policy.policyVersion,
            policyStatus: policy.status,
          },
        },
        policy,
      ).preparedText;
      renders.push({ caseId: c.id, category: c.category, subject: c.subject, mode, original: c.original, prepared });
    }
  }
  const clips: Omit<Clip, 'clip'>[] = renders.flatMap((render) =>
    VOICES.flatMap((voice) => [true, false].map((instructed) => ({ ...render, voice, instructed }))),
  );
  return shuffle(clips, 20260928).map((clip, i) => ({ ...clip, clip: `C${String(i + 1).padStart(4, '0')}` }));
}

function estimate(clips: Clip[]): number {
  const instructionTokens = tok(DELIVERY_INSTRUCTIONS_AR_SA_V1);
  return clips.reduce(
    (usd, clip) =>
      usd +
      estimateUsd(tok(clip.prepared), clip.instructed ? instructionTokens : 0, clip.prepared.length / PESSIMISTIC_CHARS_PER_SEC + 1),
    0,
  );
}

function listeningPage(clips: Clip[]): string {
  const rows = clips
    .map(
      (clip) => `<section>
  <h2>${clip.clip}</h2>
  <audio controls preload="none" src="audio/${clip.clip}.mp3"></audio>
  <p class="scales">Rate in the sheet: naturalness (Saudi) 1–5 · intelligibility 1–5 · fidelity pass/fail · pace 1–5</p>
  <details><summary>Reveal the narration (only AFTER rating intelligibility)</summary><p dir="rtl">${clip.original
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')}</p></details>
</section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="ar"><head><meta charset="utf-8"><title>SATTS listening evaluation</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px}section{border-bottom:1px solid #ddd;padding:12px 0}.scales{color:#555;font-size:13px}</style>
</head><body>
<h1>SATTS listening evaluation (blind)</h1>
<p>Clips are in a randomised order. Voice, instructions and case are hidden; the key is kept by the evaluation owner.
Rate each clip in <code>rating-sheet.csv</code>. Fidelity: any value, operator, unit, element, charge or direction wrong or missing ⇒ fail.</p>
${rows}
</body></html>
`;
}

async function main() {
  const run = process.argv.includes('--run');
  const clips = planClips();
  const cost = estimate(clips);
  const spent = spentUsd();
  console.log(
    `clips=${clips.length} (voices=${VOICES.join('/')}, instructed+control) estimate=$${cost.toFixed(2)} ledger=$${spent.toFixed(2)} cap=$${CAP_USD}`,
  );
  writeOut('eval-kit/index.html', listeningPage(clips));
  writeOut(
    'eval-kit/rating-sheet.csv',
    ['clip,reviewer,naturalness_1_5,intelligibility_1_5,fidelity_pass_fail,pace_1_5,notes', ...clips.map((c) => `${c.clip},,,,,,`)].join('\n') + '\n',
  );
  writeOut('eval-kit/answer-key.json', JSON.stringify(clips, null, 2));
  if (!run) {
    console.log('estimate only (pass --run to synthesise)');
    return;
  }
  if (spent + cost > CAP_USD) {
    console.error(`refusing: ledger $${spent.toFixed(2)} + estimate $${cost.toFixed(2)} exceeds $${CAP_USD}`);
    process.exit(2);
  }
  let next = 0;
  let failed = 0;
  const worker = async () => {
    for (;;) {
      const clip = clips[next];
      next += 1;
      if (!clip) return;
      const response = await speech(
        'W9eval',
        `${clip.clip} ${clip.caseId} ${clip.voice} ${clip.instructed ? 'instr' : 'control'}`,
        {
          model: MODEL,
          voice: clip.voice,
          input: clip.prepared,
          speed: 1.0,
          response_format: 'mp3',
          ...(clip.instructed ? { instructions: DELIVERY_INSTRUCTIONS_AR_SA_V1 } : {}),
        },
        (bytes) => {
          try {
            return inspectMp3(bytes).durationSeconds;
          } catch {
            return null;
          }
        },
      );
      if (response.status === 200) writeOut(`eval-kit/audio/${clip.clip}.mp3`, response.body);
      else failed += 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`done: ${clips.length - failed} clips, ${failed} failed, ledger=$${spentUsd().toFixed(4)}`);
}

void main();
