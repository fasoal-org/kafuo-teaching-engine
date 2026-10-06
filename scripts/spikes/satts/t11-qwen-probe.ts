/** T11 — probe which Qwen TTS model/voice/language_type accepts Arabic on the intl endpoint. Not shipped. */
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).replace(/^["']|["']$/g,'')]));
const KEY = env.QWEN_API_KEY; const BASE = 'https://dashscope-intl.aliyuncs.com/api/v1';
const text = 'في هذا الدرس سنتعرف على ثلاث أفكار رئيسية.';
const combos: [string,string,string|undefined][] = [
  ['qwen-audio-3.0-tts-flash','Cherry','Arabic'],
  ['qwen-audio-3.0-tts-flash','Cherry',undefined],
  ['qwen3-tts-flash','Cherry','Auto'],
  ['qwen3-tts-instruct-flash','Cherry','Auto'],
];
async function main(){ for (const [model, voice, lang] of combos) {
  const r = await fetch(`${BASE}/services/aigc/multimodal-generation/generation`, { method:'POST', headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'}, body: JSON.stringify({ model, input: { text, voice, ...(lang?{language_type:lang}:{}) } }) });
  const j = await r.json().catch(()=>({}));
  console.log(model, voice, lang, r.status, JSON.stringify(j).slice(0,300).replace(/https?:\/\/[^"]+/g,'<url>'));
} }
main();
