/** T11b — probe qwen-audio-3.x TTS endpoint shape on the intl region. Not shipped. */
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).replace(/^["']|["']$/g,'')]));
const KEY = env.QWEN_API_KEY; const BASE = 'https://dashscope-intl.aliyuncs.com/api/v1';
const text = 'في هذا الدرس سنتعرف على ثلاث أفكار رئيسية.';
async function main(){
  const tries: [string, any][] = [
    ['/services/audio/tts/SpeechSynthesizer', { model:'qwen-audio-3.0-tts-flash', input:{ text, voice:'longanfengyue' } }],
    ['/services/audio/tts/SpeechSynthesizer', { model:'qwen-audio-3.0-tts-flash', input:{ text, voice:'loongeva_v3.6' } }],
    ['/services/audio/tts/SpeechSynthesizer', { model:'qwen-audio-3.0-tts-plus', input:{ text, voice:'longanlingxin' } }],
  ];
  for (const [path, body] of tries) {
    const r = await fetch(BASE+path, { method:'POST', headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const t = await r.text();
    console.log(path, body.model, JSON.stringify(body.input.language_type), r.status, t.slice(0,300).replace(/https?:\/\/[^"]+/g,'<url>'));
  }
}
main();
