/**
 * T2.2 — cap probe (I1): does `instructions` count toward the 2,000-token input cap? SATTS Wave 0. Not shipped.
 * Uses fully diacritised Arabic (≈0.59 o200k tokens/char) so the token cap binds before the 4,096-char cap.
 * Accepted calls use stream_format "sse" so the exact `usage.input_tokens` is recorded.
 * npx tsx scripts/spikes/satts/t2-cap-probe.ts
 */
import { PINNED_MODEL, SAUDI_INSTRUCTIONS_V1 } from './fixtures';
import { mp3DurationSec } from './inspect-mp3';
import { appendLedger, estimateUsd, preflight, rawSpeech, tok, writeOut } from './lib';

const DIACRITISED = [
  'يَتَعَلَّمُ الطُّلَّابُ فِي هَذَا الدَّرْسِ كَيْفَ يَحْسُبُونَ المَسَافَةَ وَالسُّرْعَةَ وَالزَّمَنَ، ثُمَّ يُطَبِّقُونَ ذَلِكَ عَلَى أَمْثِلَةٍ مِنَ الحَيَاةِ اليَوْمِيَّةِ.',
  'وَيَقْرَأُ المُعَلِّمُ النَّصَّ بِهُدُوءٍ، وَيَطْرَحُ عَلَى الطُّلَّابِ أَسْئِلَةً قَصِيرَةً تُسَاعِدُهُمْ عَلَى الفَهْمِ وَالتَّذَكُّرِ.',
  'وَفِي نِهَايَةِ الحِصَّةِ يَكْتُبُ كُلُّ طَالِبٍ مُلَخَّصًا صَغِيرًا لِمَا تَعَلَّمَهُ، وَيُشَارِكُهُ مَعَ زُمَلَائِهِ فِي الصَّفِّ.',
  'وَتَهْدِفُ هَذِهِ الأَنْشِطَةُ إِلَى تَنْمِيَةِ مَهَارَاتِ التَّفْكِيرِ وَالتَّعَاوُنِ، وَبِنَاءِ الثِّقَةِ فِي النَّفْسِ لَدَى جَمِيعِ المُتَعَلِّمِينَ.',
];
const PLAIN =
  'يتعلم الطلاب في هذا الدرس كيف يحسبون المسافة والسرعة والزمن، ثم يطبقون ذلك على أمثلة من الحياة اليومية. ';

let source = '';
for (let i = 0; source.length < 5000; i++) source += DIACRITISED[i % DIACRITISED.length] + ' ';

/** Longest prefix ≤ n chars that ends at a word boundary. */
function prefix(n: number) {
  const s = source.slice(0, n + 1);
  const cut = s.lastIndexOf(' ');
  return s.slice(0, cut > 0 ? cut : n).trim();
}

const isSizeError = (status: number, body: string) =>
  status === 400 &&
  /(token|length|too long|maximum|characters|string_above_max_length|context)/i.test(body);

interface Probe {
  arm: string;
  chars: number;
  o200kInput: number;
  o200kInstr: number;
  status: number;
  errorBody?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  audioSec?: number | null;
}
const probes: Probe[] = [];

async function probe(arm: string, input: string, withInstr: boolean): Promise<Probe> {
  const req = {
    model: PINNED_MODEL,
    voice: 'marin',
    input,
    response_format: 'mp3' as const,
    speed: 1.0,
    stream_format: 'sse' as const,
    ...(withInstr ? { instructions: SAUDI_INSTRUCTIONS_V1 } : {}),
  };
  const { res } = await rawSpeech(req);
  const text = await res.text();
  const o200kInput = tok(input);
  const o200kInstr = withInstr ? tok(SAUDI_INSTRUCTIONS_V1) : 0;
  const p: Probe = { arm, chars: input.length, o200kInput, o200kInstr, status: res.status };
  if (!res.ok) {
    p.errorBody = text;
  } else {
    const chunks: Buffer[] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      try {
        const o = JSON.parse(d);
        if (typeof o.audio === 'string') chunks.push(Buffer.from(o.audio, 'base64'));
        if (o.usage) p.usage = o.usage;
      } catch {
        /* ignore */
      }
    }
    const audio = new Uint8Array(Buffer.concat(chunks));
    p.audioSec = mp3DurationSec(audio);
    writeOut(`cap/${arm}-${input.length}.mp3`, audio);
  }
  appendLedger({
    t: new Date().toISOString(),
    task: 'T2cap',
    label: `${arm}-${input.length}`,
    status: res.status,
    inputChars: input.length,
    inputTok: o200kInput,
    instrTok: o200kInstr,
    audioSec: p.audioSec ?? null,
    usage: p.usage,
    estUsd: res.ok
      ? p.usage
        ? p.usage.input_tokens * 0.6e-6 + p.usage.output_tokens * 12e-6
        : estimateUsd(o200kInput, o200kInstr, p.audioSec ?? 0)
      : 0,
  });
  probes.push(p);
  console.log(JSON.stringify({ ...p, errorBody: p.errorBody?.slice(0, 400) }));
  await new Promise((r) => setTimeout(r, 400));
  return p;
}

async function search(arm: string, withInstr: boolean, lo: number, hi: number, maxCalls: number) {
  // invariant: lo accepted (assumed), hi rejected (verified by phase A)
  let calls = 0;
  let bestAccepted: Probe | null = null;
  let firstRejected: Probe | null = null;
  while (hi - lo > 30 && calls < maxCalls) {
    const mid = Math.floor((lo + hi) / 2);
    const input = prefix(mid);
    const p = await probe(arm, input, withInstr);
    calls++;
    if (p.status === 200) {
      lo = input.length;
      bestAccepted = p;
    } else if (isSizeError(p.status, p.errorBody ?? '')) {
      hi = input.length;
      firstRejected = p;
    } else {
      console.log(`[${arm}] non-size error, stopping`);
      break;
    }
  }
  return { arm, lo, hi, calls, bestAccepted, firstRejected };
}

async function main() {
  const maxLen = 4096;
  const guessAcceptedSec = (s: string) => (s.replace(/[ً-ْ]/g, '').length / 11) * 1.3;
  // Planned: ≤2 phase A (rejects, free) + 1 char-cap check (reject, free) + ≤2×7 search (≈half accepted).
  preflight(
    'T2cap',
    Array.from({ length: 8 }, () => ({ input: prefix(3300), instructions: SAUDI_INSTRUCTIONS_V1 })),
    guessAcceptedSec,
  );

  // Phase A — oversized (≈2,400 o200k tokens, under 4,096 chars) with and without instructions.
  const big = prefix(maxLen);
  const a1 = await probe('A-noinstr', big, false);
  const a2 = await probe('A-instr', big, true);
  // Char cap — plain Arabic > 4,096 chars but only ≈1,220 o200k tokens.
  let plain = '';
  while (plain.length <= maxLen) plain += PLAIN;
  const c1 = await probe('C-charcap', plain.slice(0, maxLen + 1), false);

  if (a1.status === 200 || a2.status === 200)
    console.log('WARNING: oversized input accepted — check for truncation');
  const nonSize = [a1, a2].some(
    (p) => p.status !== 200 && !isSizeError(p.status, p.errorBody ?? ''),
  );
  const result: Record<string, unknown> = { phaseA: [a1, a2], charCap: c1 };
  if (!nonSize && a1.status !== 200 && a2.status !== 200) {
    result.noInstr = await search('B-noinstr', false, 2600, big.length, 7);
    result.withInstr = await search('B-instr', true, 2600, big.length, 7);
  }
  result.probes = probes;
  writeOut('cap/results.json', JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
