/**
 * SATTS Wave 5 end-to-end smoke (goal prompt constraint 8a: at most 5 paid
 * calls). Runs the real Narration Synthesis Service against OpenAI with the
 * governed profile and SSE, writes audio to the git-ignored spike output dir,
 * and logs every call to `scripts/spikes/satts/out/ledger.jsonl`. It never
 * writes a Stage, classroom, asset or usage row, and never prints the key.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/satts/smoke-w5.ts [--dry-run]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readSpeechConfig } from '@/lib/server/speech/config';
import { synthesizeNarration } from '@/lib/server/speech/narration-synthesis';
import { prepareNarration } from '@/lib/server/speech/prepare';
import type { SpeechAction } from '@/lib/types/action';
import { appendLedger, CAP_USD, estimateUsd, spentUsd, tok, writeOut } from '../spikes/satts/lib';

const MAX_CALLS = 5;

function readKey(): string {
  const fromEnv = process.env.TTS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (fromEnv) return fromEnv;
  const path = join(__dirname, '..', '..', '.env.local');
  if (!existsSync(path)) return '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*(TTS_OPENAI_API_KEY|OPENAI_API_KEY)\s*=\s*(.*)\s*$/);
    if (match) return match[2]!.replace(/^['"]|['"]$/g, '');
  }
  return '';
}

const CASES: Array<{ id: string; subject: 'MATH' | 'PHYSICS' | 'CHEMISTRY'; text: string }> = [
  { id: 'math', subject: 'MATH', text: 'إذا كان x² + 2x = 5 فإن \\frac{1}{2} من الناتج يساوي 2.5' },
  { id: 'physics', subject: 'PHYSICS', text: 'السرعة 5 m/s ثابتة، والقانون F = ma يربط القوة بالتسارع.' },
  { id: 'chemistry', subject: 'CHEMISTRY', text: 'التفاعل 2H₂ + O₂ → 2H₂O يطلق طاقة.' },
  {
    id: 'multi-segment',
    subject: 'MATH',
    text: Array.from({ length: 12 }, (_, i) => `في الخطوة ${i + 1} نحسب \\frac{x+${i}}{y-${i}} ثم نبسطه`).join('، ') + '.',
  },
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const apiKey = readKey();
  if (!apiKey && !dryRun) throw new Error('No OpenAI key in the environment or .env.local');
  const config = readSpeechConfig({
    SCIENTIFIC_TTS_MODE: 'on',
    SCIENTIFIC_TTS_SUBJECTS: 'MATH,PHYSICS,CHEMISTRY',
    TTS_AR_VOICE: 'marin',
  });
  let calls = 0;
  for (const c of CASES) {
    const action: SpeechAction = { id: c.id, type: 'speech', text: c.text };
    const { plan, profile } = await prepareNarration({
      text: c.text,
      stage: { subjectCode: c.subject, language: 'ar-SA' },
      stageId: null,
      config,
      fallback: { providerId: 'openai-tts', modelId: 'gpt-4o-mini-tts', voice: 'alloy', speed: 1 },
      governedCredentials: () => ({ available: true, apiKey }),
      allowProposed: true,
    });
    const instrTok = profile.instructions ? tok(profile.instructions) : 0;
    const estimate = plan.segments.reduce((n, s) => n + estimateUsd(tok(s.text), instrTok, s.text.length / 8), 0);
    console.log(`[${c.id}] segments=${plan.segments.length} prepared=${JSON.stringify(plan.sentText)} est=$${estimate.toFixed(4)}`);
    if (dryRun) continue;
    if (calls + plan.segments.length > MAX_CALLS) throw new Error('smoke call cap reached');
    if (spentUsd() + estimate > CAP_USD - 0.5) throw new Error('spend cap would be exceeded');
    const started = Date.now();
    const outcome = await synthesizeNarration({
      action,
      stageId: null,
      plan,
      profile,
      config,
      reason: 'initial',
      entry: 'preview',
      persist: { kind: 'none' },
      recordUsage: false,
    }).catch((error: unknown) => ({ outcome: 'failed' as const, error: { code: 'THROWN', message: String(error) } }));
    calls += plan.segments.length;
    const ok = outcome.outcome !== 'failed' && 'audio' in outcome && outcome.audio;
    const audioSec = ok ? (outcome.audio!.durationSeconds ?? null) : null;
    const usage = 'usage' in outcome ? outcome.usage : undefined;
    appendLedger({
      t: new Date().toISOString(),
      task: 'W5smoke',
      label: `${c.id} segments=${plan.segments.length}`,
      status: ok ? 200 : 0,
      inputChars: plan.sentText.length,
      inputTok: tok(plan.sentText),
      instrTok: instrTok * plan.segments.length,
      audioSec,
      usage,
      estUsd:
        usage && usage.inputTokens !== undefined
          ? (usage.inputTokens * 0.6 + (usage.outputTokens ?? 0) * 12) / 1e6
          : estimateUsd(tok(plan.sentText), instrTok * plan.segments.length, audioSec ?? plan.sentText.length / 8),
    });
    if (ok) writeOut(`w5-smoke/${c.id}.mp3`, outcome.audio!.bytes);
    console.log(
      `[${c.id}] ${outcome.outcome} ${'error' in outcome && outcome.error ? outcome.error.code : ''} ` +
        `audio=${audioSec?.toFixed(1)}s usage=${JSON.stringify(usage)} ms=${Date.now() - started}`,
    );
  }
  console.log(`calls=${calls} spent-total=$${spentUsd().toFixed(4)}`);
}

void main();
