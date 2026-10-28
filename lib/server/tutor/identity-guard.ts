/**
 * Identity post-check (guardrails review 28 Oct 2026, §5d Layer 3).
 *
 * `tutor-rules@r6` tells the tutor it is «معلم كفو» and never names the model or
 * provider behind it. This deterministic check is the insurance for a reply that
 * still does (Math Free Chat answered "I'm ChatGPT" on r5): the whole reply is
 * replaced by a fixed identity line.
 *
 *  - Names that never belong in a school answer (ChatGPT, OpenAI, Qwen, Tongyi,
 *    Anthropic) trigger anywhere in the reply.
 *  - Names that do (GPT as in a unit, Claude Monet, Gemini the constellation, Google,
 *    Alibaba) trigger only in a sentence that also speaks about the tutor itself
 *    ("I am …", "made by …", «أنا …», «من تطوير …»).
 *
 * Pure functions; nothing here logs the reply.
 */

const ALWAYS = new RegExp(
  [
    // Word edges, so "open air" and "philanthropic" stay ordinary words.
    '\\bchat\\s*-?\\s*gpt\\b',
    '\\bopen\\s*ai\\b',
    '\\bqwen',
    '\\btongyi\\b',
    '通义',
    '\\banthropic\\b',
    'شات\\s*جي\\s*بي\\s*تي',
    '[أا]وبن\\s*[أاإآ]ي',
    'كوين\\s*\\d',
  ].join('|'),
  'iu',
);

const NAMED = new RegExp(
  [
    '\\bgpt\\b',
    '\\bgpt-?\\d',
    '\\bclaude\\b',
    '\\bgemini\\b',
    '\\bgoogle\\b',
    '\\balibaba\\b',
    'جوجل',
    'غوغل',
    'علي\\s*بابا',
    'جيميني',
    'جيمناي',
    'كلود',
  ].join('|'),
  'iu',
);

const SELF = new RegExp(
  [
    "\\bi\\s*(?:am|'m)\\b",
    '\\bi\\s+was\\s+(?:created|developed|made|trained|built)',
    '\\b(?:created|developed|made|trained|built|powered)\\s+by\\b',
    '\\bmy\\s+(?:model|creator|developer)',
    '(?:^|\\s)أنا(?:\\s|$)',
    'تم\\s*تطويري',
    'طوّرتني|طورتني|صنعتني|درّبتني|دربتني',
    'من\\s*تطوير',
    'من\\s*صنع',
    'نموذجي',
  ].join('|'),
  'iu',
);

/** True when the reply names the model or provider behind the tutor. */
export function namesProvider(reply: string): boolean {
  if (ALWAYS.test(reply)) return true;
  return reply.split(/[.!?؟\n]+/u).some((sentence) => NAMED.test(sentence) && SELF.test(sentence));
}

export const IDENTITY_REPLY_AR =
  'أنا معلم كفو، معلم ذكاء اصطناعي مخصص للمذاكرة في تطبيق كفو. وش تبغى نذاكر الحين؟';

export const IDENTITY_REPLY_EN =
  "I'm Kafuo Tutor, an AI tutor made for studying in the Kafuo app. What would you like to study now?";

export function identityReply(language: 'ar' | 'en'): string {
  return language === 'en' ? IDENTITY_REPLY_EN : IDENTITY_REPLY_AR;
}
