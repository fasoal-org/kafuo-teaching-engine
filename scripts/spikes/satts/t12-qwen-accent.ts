/**
 * T12 — same Saudi-accent comparison as T10, on Qwen (DashScope intl). Not shipped.
 * 3 sentences × variants A/B/C × Qwen model/voice set. Tries `instructions`; falls back without and records it.
 * npx tsx scripts/spikes/satts/t12-qwen-accent.ts
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]));
const KEY = env.QWEN_API_KEY;
const BASE = 'https://dashscope-intl.aliyuncs.com/api/v1';
const OUT = join('scripts/spikes/satts/out/accent-qwen');
mkdirSync(OUT, { recursive: true });

const INSTR_A = 'Read the Arabic text aloud exactly as written, with a natural Saudi Arabic accent. Keep the educational Modern Standard wording; never rewrite it into colloquial dialect. Clear numbers and terms, brief pauses at commas, calm warm teacher pace.';
const INSTR_B = 'Accent: clearly Saudi, specifically Riyadh (Najdi). Sound exactly like an educated Saudi school teacher reading the textbook aloud to students in a Saudi classroom: Saudi vowel colour, Saudi intonation and rhythm. Not Egyptian, not Levantine, and not a formal news anchor. Read every word exactly as written. Calm warm pace.';
const INSTR_C = 'Speak in natural, warm Saudi Arabic dialect (Riyadh, Najdi), like a friendly Saudi teacher explaining to students in class. Read the text exactly as written. Clear numbers, calm pace.';

const SENTENCES = [
  { nn: '01', label: 'prose', msa: 'في هذا الدرس سنتعرف على ثلاث أفكار رئيسية، ثم نحل 12 تمرينًا معًا.', saudi: 'في هذا الدرس راح نتعرف على ثلاث أفكار رئيسية، وبعدها نحل 12 تمرين سوا.' },
  { nn: '03', label: 'math', msa: '3 على 4 زائد س تربيع، أكبر من أو يساوي، 5.', saudi: 'عندنا 3 على 4 زائد س تربيع، وهذي أكبر من أو تساوي 5.' },
  { nn: '07', label: 'chemistry', msa: 'يتكون جزيء الماء، إتش تو أو، من ذرتي هيدروجين وذرة أكسجين واحدة.', saudi: 'جزيء الماء، إتش تو أو، يتكون من ذرتين هيدروجين وذرة أكسجين وحدة.' },
];
const VARIANTS = [
  { id: 'A', name: 'A · MSA + current instructions', text: (s: any) => s.msa, instr: INSTR_A },
  { id: 'B', name: 'B · MSA + stronger Riyadh instructions', text: (s: any) => s.msa, instr: INSTR_B },
  { id: 'C', name: 'C · white Saudi dialect wording', text: (s: any) => s.saudi, instr: INSTR_C },
];
const VOICES = [
  { key: 'plus-lingxin', model: 'qwen-audio-3.0-tts-plus', voice: 'longanlingxin', path: '/services/audio/tts/SpeechSynthesizer' },
  { key: 'plus-lufeng', model: 'qwen-audio-3.0-tts-plus', voice: 'longanlufeng', path: '/services/audio/tts/SpeechSynthesizer' },
  { key: 'flash-fengyue', model: 'qwen-audio-3.0-tts-flash', voice: 'longanfengyue', path: '/services/audio/tts/SpeechSynthesizer' },
  { key: 'q3instruct-cherry', model: 'qwen3-tts-instruct-flash', voice: 'Cherry', path: '/services/aigc/multimodal-generation/generation', lang: 'Auto' },
];

async function call(v: (typeof VOICES)[number], text: string, instr?: string) {
  const input: any = { text, voice: v.voice, ...(v.lang ? { language_type: v.lang } : {}) };
  const body: any = { model: v.model, input };
  if (instr) body.input.instructions = instr;
  const r = await fetch(BASE + v.path, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  return { status: r.status, url: j?.output?.audio?.url as string | undefined, msg: j?.message as string | undefined };
}

const log: any[] = [];
async function main() {
  for (const s of SENTENCES) for (const va of VARIANTS) for (const v of VOICES) {
    let res = await call(v, va.text(s), va.instr);
    let instrUsed = true;
    if (!res.url) { log.push({ s: s.nn, va: va.id, v: v.key, withInstr: res.status, msg: res.msg }); res = await call(v, va.text(s)); instrUsed = false; }
    let file: string | null = null;
    if (res.url) {
      const a = await fetch(res.url);
      const ct = a.headers.get('content-type') || '';
      const ext = ct.includes('mpeg') ? 'mp3' : 'wav';
      file = `${s.nn}-${va.id}-${v.key}.${ext}`;
      writeFileSync(join(OUT, file), new Uint8Array(await a.arrayBuffer()));
    }
    const row = { t: new Date().toISOString(), task: 'T12-qwen', s: s.nn, variant: va.id, voice: v.key, status: res.status, instrUsed, file, msg: res.url ? undefined : res.msg };
    log.push(row); console.log(JSON.stringify(row));
    appendFileSync('scripts/spikes/satts/out/ledger.jsonl', JSON.stringify({ t: row.t, task: 'T12-qwen', label: file ?? `${s.nn}-${va.id}-${v.key}`, status: res.status, inputChars: va.text(s).length, inputTok: 0, instrTok: 0, audioSec: null, estUsd: 0.001 }) + '\n');
  }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(log, null, 2));
  writeFileSync(join(OUT, 'index.html'), html(log));
}
const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function html(rows: any[]) {
  const f = (s: string, va: string, v: string) => rows.find((r) => r.s === s && r.variant === va && r.voice === v && r.file);
  const body = SENTENCES.map((s) => `<h2>${s.nn} · ${s.label}</h2><table><thead><tr><th>Variant</th><th>Text</th>${VOICES.map((v) => `<th>${v.model}<br><small>${v.voice}</small></th>`).join('')}</tr></thead><tbody>${VARIANTS.map((va) => `<tr><th>${va.name}</th><td dir="rtl" lang="ar">${esc(va.text(s))}</td>${VOICES.map((v) => { const r = f(s.nn, va.id, v.key); return `<td>${r ? `<audio controls preload="none" src="${r.file}"></audio>${r.instrUsed ? '' : '<br><small>no instructions accepted</small>'}` : 'failed'}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Qwen accent test</title><style>body{font-family:system-ui;margin:16px}table{border-collapse:collapse;margin-bottom:24px}td,th{border:1px solid #ddd;padding:6px}td[lang=ar]{font-size:18px;max-width:380px}audio{width:190px}</style></head><body><h1>Saudi accent test on Qwen (T12)</h1><p>A = MSA + current-style instructions, B = MSA + stronger Riyadh instructions, C = white Saudi dialect wording. Arabic is officially listed only for the qwen-audio-3.0 models; qwen3-tts-instruct-flash is included as a reference.</p>${body}</body></html>`;
}
main();
