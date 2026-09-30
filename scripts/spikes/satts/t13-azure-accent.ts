/**
 * T13 — Saudi accent test on Azure native ar-SA voices (Hamed, Zariyah). Not shipped.
 * 3 sentences × {A: MSA text, C: white Saudi dialect text} × 2 voices = 12 calls (~1k chars, F0 free tier).
 * Azure has no free-text instructions, so variant B (stronger instructions) does not apply.
 * npx tsx scripts/spikes/satts/t13-azure-accent.ts
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const KEY = env.TTS_AZURE_API_KEY;
const REGION = (env.TTS_AZURE_BASE_URL || '').match(/https?:\/\/([a-z0-9]+)\./)?.[1] || 'uaenorth';
const ENDPOINT = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
const OUT = 'scripts/spikes/satts/out/accent-azure';
mkdirSync(OUT, { recursive: true });

const SENTENCES = [
  { nn: '01', label: 'prose', msa: 'في هذا الدرس سنتعرف على ثلاث أفكار رئيسية، ثم نحل 12 تمرينًا معًا.', saudi: 'في هذا الدرس راح نتعرف على ثلاث أفكار رئيسية، وبعدها نحل 12 تمرين سوا.' },
  { nn: '03', label: 'math', msa: '3 على 4 زائد س تربيع، أكبر من أو يساوي، 5.', saudi: 'عندنا 3 على 4 زائد س تربيع، وهذي أكبر من أو تساوي 5.' },
  { nn: '07', label: 'chemistry', msa: 'يتكون جزيء الماء، إتش تو أو، من ذرتي هيدروجين وذرة أكسجين واحدة.', saudi: 'جزيء الماء، إتش تو أو، يتكون من ذرتين هيدروجين وذرة أكسجين وحدة.' },
];
const VARIANTS = [
  { id: 'A', name: 'A · MSA text', text: (s: any) => s.msa },
  { id: 'C', name: 'C · white Saudi dialect text', text: (s: any) => s.saudi },
];
const VOICES = ['ar-SA-HamedNeural', 'ar-SA-ZariyahNeural'];
const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  if (!KEY) throw new Error('TTS_AZURE_API_KEY missing');
  const rows: any[] = [];
  let chars = 0;
  for (const s of SENTENCES) for (const va of VARIANTS) for (const voice of VOICES) {
    const text = va.text(s);
    const ssml = `<speak version='1.0' xml:lang='ar-SA'><voice xml:lang='ar-SA' name='${voice}'>${xml(text)}</voice></speak>`;
    const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': KEY, 'Content-Type': 'application/ssml+xml; charset=utf-8', 'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3', 'User-Agent': 'satts-spike' }, body: ssml });
    const buf = new Uint8Array(await r.arrayBuffer());
    const file = r.ok ? `${s.nn}-${va.id}-${voice}.mp3` : null;
    if (file) writeFileSync(join(OUT, file), buf);
    chars += text.length;
    const row = { t: new Date().toISOString(), task: 'T13-azure', s: s.nn, variant: va.id, voice, status: r.status, file, err: r.ok ? undefined : new TextDecoder().decode(buf).slice(0, 200) };
    rows.push(row); console.log(JSON.stringify(row));
    appendFileSync('scripts/spikes/satts/out/ledger.jsonl', JSON.stringify({ t: row.t, task: 'T13-azure', label: file ?? `${s.nn}-${va.id}-${voice}`, status: r.status, inputChars: text.length, inputTok: 0, instrTok: 0, audioSec: null, estUsd: r.ok ? (text.length * 15) / 1e6 : 0 }) + '\n');
  }
  console.log(`region=${REGION} chars=${chars}`);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = SENTENCES.map((s) => `<h2>${s.nn} · ${s.label}</h2><table><thead><tr><th>Variant</th><th>Text</th>${VOICES.map((v) => `<th>${v}</th>`).join('')}</tr></thead><tbody>${VARIANTS.map((va) => `<tr><th>${va.name}</th><td dir="rtl" lang="ar">${esc(va.text(s))}</td>${VOICES.map((v) => { const r = rows.find((x) => x.s === s.nn && x.variant === va.id && x.voice === v); return `<td>${r?.file ? `<audio controls preload="none" src="${r.file}"></audio>` : 'failed'}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`).join('\n');
  writeFileSync(join(OUT, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Azure ar-SA accent test</title><style>body{font-family:system-ui;margin:16px}table{border-collapse:collapse;margin-bottom:24px}td,th{border:1px solid #ddd;padding:6px}td[lang=ar]{font-size:18px;max-width:380px}audio{width:220px}</style></head><body><h1>Saudi accent test on Azure ar-SA voices (T13)</h1><p>Region ${REGION}. A = MSA text (as today), C = the same meaning in white Saudi dialect. Azure takes no free-text accent instructions; the Saudi accent comes from the voice.</p>${body}</body></html>`);
}
main().catch((e) => { console.error(String(e).replace(KEY || '§', '<key>')); process.exit(1); });
