#!/usr/bin/env node
/**
 * Budget counter calibration (Kafuo R1 plan §8.7, P0 deliverable).
 *
 * Reconstructs every recorded benchmark turn's prompt exactly as the benchmark
 * scripts sent it (`tutor_system(subject, grade, context)` + the running
 * student/tutor history + the current student message), counts it with
 * `o200k_base` plus the executor's framing overhead, and compares with the
 * provider-reported `prompt_tokens`:
 *
 *  - OpenAI corpora (gpt-5-nano, gpt-5.6-luna): the counter is EXACT in
 *    principle (GPT-5 tokenizes with o200k_base); the framing overhead must
 *    make `count >= reported` on >= 99 % of turns. If it does not, the
 *    per-message overhead is raised until it does, and the constant used is
 *    recorded — `lib/server/tutor/token-budget.ts` pins it by test.
 *  - Qwen corpus (qwen3.7-flash "nothink"): no Qwen tokenizer in the repo, so
 *    the counter is a PROXY: o200k count × `proxy_ratio`, seeded here as
 *    p99(reported / count) × 1.10.
 *
 * Usage (from OpenMAIC/):  node scripts/calibrate-token-ratio.mjs
 * Reads  ../benchmarks-scripts/results/multisubject/{dataset.json, extracted/*.md, raw_*.json}
 * Writes ../docs/frds/model_routing/token-calibration.v1.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getEncoding } from 'js-tiktoken';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(REPO, '..');
export const BENCH_DIR = path.join(WORKSPACE, 'benchmarks-scripts', 'results', 'multisubject');
export const OUTPUT_PATH = path.join(
  WORKSPACE,
  'docs',
  'frds',
  'model_routing',
  'token-calibration.v1.json',
);

/** Starting framing overhead (plan §8.7): 4 tokens per message + 3 per request. */
const INITIAL_PER_MESSAGE = 4;
const FIXED = 3;
const MAX_PER_MESSAGE = 64;
const REQUIRED_CONSERVATIVE_SHARE = 0.99;

// Copied verbatim from benchmarks-scripts/run_multisubject.py::tutor_system
// (run_gpt5nano.py and run_addround.py use the identical prompt). The Arabic
// subject names come from the same scripts' SUBJECT_AR map.
export const SUBJECT_AR = {
  Mathematics: 'الرياضيات',
  Physics: 'الفيزياء',
  Arabic: 'اللغة العربية',
  Biology: 'علوم الأحياء',
  'Social Studies': 'الدراسات الاجتماعية',
};

export function tutorSystem(subject, grade, context) {
  return (
    `أنت معلم افتراضي في منصة كفو التعليمية للمنهج السعودي.\n` +
    `تدرّس درساً لمادة ${SUBJECT_AR[subject] ?? subject} لطالب في الصف ${grade}.\n` +
    'القواعد:\n' +
    '1. أجب باللغة العربية دائماً.\n' +
    '2. اعتمد في إجاباتك على نص الدرس المرفق فقط، ولا تخترع معلومات أو ' +
    'أمثلة من خارج الدرس.\n' +
    '3. إذا لم يكن في الدرس ما يكفي للإجابة عن سؤال الطالب، قل ذلك بوضوح.\n' +
    '4. حافظ على الرموز الرياضية والمصطلحات العلمية والوحدات بشكل صحيح.\n' +
    '5. إذا أخطأ الطالب خطأً أو سوء فهماً، صحّحه بوضوح مع بيان السبب.\n' +
    '6. اشرح ودرّب ولا تكتفي بإعطاء الجواب النهائي.\n' +
    '7. إذا طلب الطالب تلميحاً فقط، أعطِ تلميحاً موجهاً دون أن تحل السؤال ' +
    'كاملاً.\n' +
    '8. راقب سياق المحادثة وذكّر بما قيل سابقاً عند الحاجة.\n' +
    '\n' +
    '=== نص الدرس (السياق التعليمي) ===\n' +
    `${context}\n` +
    '=== نهاية نص الدرس ==='
  );
}

export const CORPORA = [
  { file: 'raw_qwen_nothink.json', model: 'qwen:qwen3.7-flash', counter: 'proxy' },
  { file: 'raw_gpt5_nano.json', model: 'openai:gpt-5-nano', counter: 'exact' },
  { file: 'raw_addround_gpt_56_luna.json', model: 'openai:gpt-5.6-luna', counter: 'exact' },
];

const enc = getEncoding('o200k_base');
const encodeCache = new Map();
function tokens(text) {
  let n = encodeCache.get(text);
  if (n === undefined) {
    n = enc.encode(text).length;
    encodeCache.set(text, n);
  }
  return n;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  // Nearest-rank: the smallest value with at least p of the sample at or below it.
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

/**
 * Reconstruct every recorded turn of one corpus as the message list the
 * benchmark sent: `[system, user₁, assistant₁, …, userₙ]`, with the provider's
 * reported `prompt_tokens`. Shared with the golden test so both count the
 * SAME messages.
 */
export function reconstructTurns(benchDir, corpusFile) {
  const dataset = readJson(path.join(benchDir, 'dataset.json'));
  const lessonMeta = new Map(dataset.lessons.map((l) => [l.lesson_id, l]));
  const contexts = new Map(
    dataset.lessons.map((l) => [
      l.lesson_id,
      readFileSync(path.join(benchDir, 'extracted', `${l.lesson_id}.md`), 'utf8'),
    ]),
  );
  const raw = readJson(path.join(benchDir, corpusFile));
  const turns = [];
  for (const lesson of raw.lessons) {
    const meta = lessonMeta.get(lesson.lesson_id);
    if (!meta) throw new Error(`${corpusFile}: unknown lesson ${lesson.lesson_id}`);
    const history = [
      {
        role: 'system',
        content: tutorSystem(meta.subject, meta.grade, contexts.get(lesson.lesson_id)),
      },
    ];
    const ordered = [...lesson.turns].sort((a, b) => a.turn - b.turn);
    for (const turn of ordered) {
      if (typeof turn.prompt_tokens !== 'number' || turn.prompt_tokens <= 0) continue; // API failure rows
      history.push({ role: 'user', content: turn.student });
      turns.push({
        lessonId: lesson.lesson_id,
        turn: turn.turn,
        messages: history.map((m) => ({ ...m })),
        reported: turn.prompt_tokens,
      });
      history.push({ role: 'assistant', content: turn.tutor ?? '' });
    }
  }
  return turns;
}

/**
 * Per corpus: every turn's exact-part token sum and message count, so the
 * framing overhead can be re-applied without re-encoding.
 */
function loadTurns(corpus) {
  return reconstructTurns(BENCH_DIR, corpus.file).map((t) => ({
    lessonId: t.lessonId,
    turn: t.turn,
    messages: t.messages.length,
    textTokens: t.messages.reduce((sum, m) => sum + tokens(m.content), 0),
    reported: t.reported,
  }));
}

function evaluate(turns, perMessage) {
  const ratios = [];
  let conservative = 0;
  for (const t of turns) {
    const count = t.textTokens + perMessage * t.messages + FIXED;
    const ratio = t.reported / count;
    ratios.push(ratio);
    if (count >= t.reported) conservative += 1;
  }
  ratios.sort((a, b) => a - b);
  return {
    turns: turns.length,
    p50: percentile(ratios, 0.5),
    p90: percentile(ratios, 0.9),
    p99: percentile(ratios, 0.99),
    max: ratios[ratios.length - 1] ?? null,
    min: ratios[0] ?? null,
    conservativeShare: turns.length ? conservative / turns.length : null,
  };
}

export function calibrate() {
  const loaded = CORPORA.map((corpus) => ({ ...corpus, turns: loadTurns(corpus) }));

  // Raise the per-message framing overhead until every OpenAI corpus is
  // conservative on >= 99 % of turns.
  let perMessage = INITIAL_PER_MESSAGE;
  for (;;) {
    const exactOk = loaded
      .filter((c) => c.counter === 'exact')
      .every((c) => evaluate(c.turns, perMessage).conservativeShare >= REQUIRED_CONSERVATIVE_SHARE);
    if (exactOk || perMessage >= MAX_PER_MESSAGE) break;
    perMessage += 1;
  }

  const round = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);
  const corpora = loaded.map((c) => {
    const e = evaluate(c.turns, perMessage);
    return {
      file: c.file,
      model: c.model,
      counter: c.counter,
      turns: e.turns,
      p50: round(e.p50),
      p90: round(e.p90),
      p99: round(e.p99),
      max: round(e.max),
      min: round(e.min),
      conservativeShare: round(e.conservativeShare),
    };
  });

  const qwen = corpora.find((c) => c.model === 'qwen:qwen3.7-flash');
  const proxyRatio = { 'qwen:qwen3.7-flash': round(qwen.p99 * 1.1) };
  const exactConservativeShare = Object.fromEntries(
    corpora.filter((c) => c.counter === 'exact').map((c) => [c.model, c.conservativeShare]),
  );

  const output = {
    version: 'v1',
    generatedAt: new Date().toISOString(),
    generator: 'OpenMAIC/scripts/calibrate-token-ratio.mjs',
    tokenizer: 'o200k_base (js-tiktoken)',
    framing: {
      perMessage,
      fixed: FIXED,
      initialPerMessage: INITIAL_PER_MESSAGE,
      raised: perMessage !== INITIAL_PER_MESSAGE,
      requiredConservativeShare: REQUIRED_CONSERVATIVE_SHARE,
    },
    corpora,
    proxyRatio,
    exactConservativeShare,
    note:
      'ratio = provider prompt_tokens / (o200k_base token sum over system+history+current message + perMessage×messages + fixed). ' +
      'proxyRatio = p99 × 1.10 for the proxy-counted model. exactConservativeShare = share of turns where the exact count ≥ reported.',
  };

  return output;
}

// Run only when invoked directly; the golden test imports the helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = calibrate();
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
  console.log(`\nwrote ${OUTPUT_PATH}`);
}
