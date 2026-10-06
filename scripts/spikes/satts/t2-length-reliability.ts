/**
 * T2.3 — length reliability ladder + I1 confirmation. SATTS Wave 0. Not shipped.
 * The cap probe showed near-cap inputs returning 200 with truncated audio. This measures audio seconds per
 * character for realistic plain Arabic (with instructions) at increasing length, via SSE (exact usage + done event).
 * npx tsx scripts/spikes/satts/t2-length-reliability.ts
 */
import { PINNED_MODEL, SAUDI_INSTRUCTIONS_V1, SCREENING_SENTENCES } from './fixtures';
import { mp3DurationSec } from './inspect-mp3';
import { appendLedger, preflight, rawSpeech, tok, writeOut } from './lib';

const PROSE = [
  'يتعلم الطلاب في هذا الدرس كيف يحسبون المسافة والسرعة والزمن، ثم يطبقون ذلك على أمثلة من الحياة اليومية.',
  'ويقرأ المعلم النص بهدوء، ويطرح على الطلاب أسئلة قصيرة تساعدهم على الفهم والتذكر.',
  'وفي نهاية الحصة يكتب كل طالب ملخصًا صغيرًا لما تعلمه، ويشاركه مع زملائه في الصف.',
  'وتهدف هذه الأنشطة إلى تنمية مهارات التفكير والتعاون، وبناء الثقة في النفس لدى جميع المتعلمين.',
  ...SCREENING_SENTENCES.map((s) => s.text),
];
let source = '';
for (let i = 0; source.length < 4000; i++) source += PROSE[i % PROSE.length] + ' ';
const prefix = (n: number) => {
  const s = source.slice(0, n + 1);
  return s.slice(0, s.lastIndexOf(' ')).trim();
};

const DIACRITISED =
  'يَتَعَلَّمُ الطُّلَّابُ فِي هَذَا الدَّرْسِ كَيْفَ يَحْسُبُونَ المَسَافَةَ وَالسُّرْعَةَ وَالزَّمَنَ، ثُمَّ يُطَبِّقُونَ ذَلِكَ عَلَى أَمْثِلَةٍ مِنَ الحَيَاةِ اليَوْمِيَّةِ. ';

async function sse(label: string, input: string) {
  const t0 = Date.now();
  let status = 0;
  let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null;
  let done = false;
  let audioSec: number | null = null;
  let error: string | undefined;
  try {
    const { res } = await rawSpeech({
      model: PINNED_MODEL,
      voice: 'marin',
      input,
      instructions: SAUDI_INSTRUCTIONS_V1,
      response_format: 'mp3',
      speed: 1.0,
      stream_format: 'sse',
    });
    status = res.status;
    const text = await res.text();
    if (!res.ok) error = text;
    else {
      const chunks: Buffer[] = [];
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') continue;
        try {
          const o = JSON.parse(d);
          if (typeof o.audio === 'string') chunks.push(Buffer.from(o.audio, 'base64'));
          if (o.type === 'speech.audio.done') {
            done = true;
            usage = o.usage ?? null;
          }
        } catch {
          /* ignore */
        }
      }
      const audio = new Uint8Array(Buffer.concat(chunks));
      audioSec = mp3DurationSec(audio);
      writeOut(`length/${label}.mp3`, audio);
    }
  } catch (e) {
    error = `transport: ${e instanceof Error ? e.message : String(e)}`;
  }
  const row = {
    label,
    chars: input.length,
    o200kInput: tok(input),
    o200kInstr: tok(SAUDI_INSTRUCTIONS_V1),
    status,
    done,
    usage,
    audioSec,
    charsPerSec: audioSec ? +(input.length / audioSec).toFixed(2) : null,
    wallMs: Date.now() - t0,
    error: error?.slice(0, 400),
  };
  appendLedger({
    t: new Date().toISOString(),
    task: 'T2len',
    label,
    status,
    inputChars: input.length,
    inputTok: row.o200kInput,
    instrTok: row.o200kInstr,
    audioSec,
    usage,
    // failed/aborted streams may still be billed: count them pessimistically as full-length audio
    estUsd: usage
      ? usage.input_tokens * 0.6e-6 + usage.output_tokens * 12e-6
      : status === 200 || error?.startsWith('transport')
        ? (input.length / 8) * 25 * 12e-6
        : 0,
  });
  console.log(JSON.stringify(row));
  await new Promise((r) => setTimeout(r, 400));
  return row;
}

async function main() {
  const sizes = [500, 1000, 1500, 2000, 2500];
  preflight(
    'T2len',
    sizes.map((n) => ({ input: prefix(n), instructions: SAUDI_INSTRUCTIONS_V1 })),
    (s) => (s.length / 8) * 1.5,
  );
  const rows = [];
  // I1 confirmation (expected 400, free): input alone < 2000 tokens, input + instructions > 2000.
  let d = '';
  while (tok(d + DIACRITISED) < 1950) d += DIACRITISED;
  rows.push(await sse('i1-confirm-reject', d.trim()));
  for (const n of sizes) rows.push(await sse(`plain-${n}`, prefix(n)));
  writeOut('length/results.json', JSON.stringify(rows, null, 2));
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
