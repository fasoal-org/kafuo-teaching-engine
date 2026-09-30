/** T14 — one real Cartesia call through the production generateTTS path + MP3 shape check. Not shipped. */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { generateTTS } from '../../../lib/audio/tts-providers';
import { joinAudio } from '../../../lib/server/speech/audio-concat';
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const text = 'طيب يا شباب، خلونا الحين نحل معادلة بسيطة: اثنين س زائد ثلاثة، يساوي أحد عشر.';
async function main() {
  const r = await generateTTS({ providerId: 'cartesia-tts', apiKey: env.TTS_CARTESIA_API_KEY || env.CARTESIA_API_KEY, voice: '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72', modelId: 'sonic-3.6', language: 'ar-SA', responseFormat: 'mp3' }, text);
  mkdirSync('scripts/spikes/satts/out/cartesia', { recursive: true });
  writeFileSync('scripts/spikes/satts/out/cartesia/smoke.mp3', r.audio);
  const b = r.audio;
  const id3 = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
  const head = Buffer.from(b.slice(0, 4000)).toString('latin1');
  const joined = joinAudio([b, b], r.format);
  console.log(JSON.stringify({ format: r.format, bytes: b.length, id3, xing: head.includes('Xing') || head.includes('Info'), singleSec: joinAudio([b], r.format).durationSeconds, joinedSec: joined.durationSeconds, chars: text.length }));
  appendFileSync('scripts/spikes/satts/out/ledger.jsonl', JSON.stringify({ t: new Date().toISOString(), task: 'T14-cartesia', label: 'cartesia/smoke.mp3', status: 200, inputChars: text.length, inputTok: 0, instrTok: 0, audioSec: null, estUsd: text.length * 39.2 / 1e6 }) + '\n');
}
main().catch((e) => { console.error(String(e?.message || e).slice(0, 300)); process.exit(1); });
