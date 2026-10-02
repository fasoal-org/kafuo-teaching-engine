/**
 * The server-owned spoken-language register policy: derived only from the
 * authoritative lesson language and subject code, and the bounded validator
 * that rejects obvious MSA narration and foreign-script contamination.
 * Evidence strings are the real Learning Item 155 output (Stage
 * `stage-yhjoDFo1Co5k`, 30 Sep 2026).
 */
import { describe, expect, it } from 'vitest';

import {
  resolveSpeechRegisterPolicy,
  SPEECH_REGISTER_POLICY_VERSION,
  validateSpeechRegister,
} from '@/lib/server/speech/register-policy';

/** Learning Item 155, scene 1: formal MSA narration where Saudi speech was required. */
const LI155_SCENE1 = [
  'مرحبًا بكم يا طلاب. لنبدأ بسؤال بسيط: ماذا يمكن أن تكشفه إجابات مجموعة من الأشخاص؟ قد تبدو الإجابات منفصلة، لكن عند جمعها قد يظهر بينها اتجاه أو نمط يستحق الانتباه.',
  'تخيّلوا أنكم تتابعون آراء العملاء خلال أشهر متتابعة. هل يمكن أن تساعدكم هذه البيانات على ملاحظة ما يفضله العملاء أو توقّع ما قد يحدث لاحقًا؟',
];
/** Learning Item 155, scene 4: a Latin word inside Arabic narration. */
const LI155_QUIZ =
  'حان الآن وقت التحقق مما فهمناه للتو. أجب عن كل سؤال independently وبأسلوبك الخاص، وحاول الاستناد إلى البيانات دون استعانة.';
const SAUDI_NARRATION = [
  'طيب يا شباب، خلونا الحين نشوف هذي البيانات مع بعض. لو جمعنا إجابات الناس، بنلاحظ إن فيه نمط يتكرر، وهذا اللي نبي نفهمه اليوم عشان نقدر نبني تخمين ونختبره بعدين.',
];

const saudi = resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'MATH' })!;

describe('resolveSpeechRegisterPolicy', () => {
  it('Arabic mathematics → a deterministic Saudi-spoken directive', () => {
    const again = resolveSpeechRegisterPolicy({ language: 'ar-SA', subjectCode: 'math' });
    expect(saudi.register).toBe('saudi-white-spoken');
    expect(saudi.version).toBe(SPEECH_REGISTER_POLICY_VERSION);
    expect(again).toEqual(saudi);
    // Visible slides and spoken text are separated explicitly.
    expect(saudi.directive).toContain('Visible slide content');
    expect(saudi.directive).toContain('clear academic Arabic');
    expect(saudi.directive).toContain('white" Saudi dialect');
    expect(saudi.directive).toContain('never written in formal Modern Standard Arabic');
  });

  it('every non-Arabic subject of an Arabic lesson gets the Saudi policy', () => {
    for (const subjectCode of ['PHYSICS', 'CHEMISTRY', 'BIOLOGY', 'SOCIAL_STUDIES']) {
      expect(resolveSpeechRegisterPolicy({ language: 'ar', subjectCode })?.register).toBe(
        'saudi-white-spoken',
      );
    }
  });

  it('the Arabic-language subject keeps Modern Standard Arabic', () => {
    const msa = resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'ARABIC' })!;
    expect(msa.register).toBe('msa');
    expect(msa.directive).toContain('Modern Standard Arabic');
    expect(msa.directive).not.toContain('Saudi dialect');
  });

  it('non-Arabic lessons, and Arabic lessons without a subject code, get no policy', () => {
    expect(resolveSpeechRegisterPolicy({ language: 'en', subjectCode: 'MATH' })).toBeNull();
    expect(resolveSpeechRegisterPolicy({ language: 'en', subjectCode: 'ENGLISH' })).toBeNull();
    expect(resolveSpeechRegisterPolicy({ language: undefined, subjectCode: 'MATH' })).toBeNull();
    // Never inferred from content: no routing code, no policy.
    expect(resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: null })).toBeNull();
  });
});

describe('validateSpeechRegister', () => {
  it('Learning Item 155 scene 1 (MSA-only) is rejected', () => {
    expect(validateSpeechRegister(LI155_SCENE1, saudi).map((issue) => issue.code)).toEqual([
      'MSA_ONLY_NARRATION',
    ]);
  });

  it('educated Saudi narration passes', () => {
    expect(validateSpeechRegister(SAUDI_NARRATION, saudi)).toEqual([]);
  });

  it('a Latin word inside Arabic speech is contamination (`independently`)', () => {
    const issues = validateSpeechRegister([LI155_QUIZ], saudi);
    expect(issues.find((issue) => issue.code === 'LATIN_SCRIPT')?.evidence).toEqual([
      'independently',
    ]);
  });

  it('CJK script inside Arabic speech is contamination (`提交`)', () => {
    const issues = validateSpeechRegister(['طيب، خلونا الحين نضغط 提交 ونشوف النتيجة.'], saudi);
    expect(issues.map((issue) => issue.code)).toEqual(['CJK_SCRIPT']);
    expect(issues[0]!.evidence).toEqual(['提交']);
  });

  it('a lone variable letter is left to SATTS; a raw quantity with a unit symbol is not (2 Oct 2026)', () => {
    // Changed on purpose: TTS-ready narration (policy ar-speech-register-2)
    // rejects raw quantities/units in Arabic scientific speech; `x` alone is
    // still a letter name SATTS reads.
    expect(validateSpeechRegister(['طيب، عندنا x يساوي خمسة كيلوجرام تقريبًا.'], saudi)).toEqual(
      [],
    );
    expect(validateSpeechRegister(['طيب، عندنا x يساوي 5 kg تقريبًا.'], saudi)).toEqual([
      { code: 'RAW_SPOKEN_NOTATION', evidence: ['5 kg'] },
    ]);
  });

  it('a short narration is not judged for register', () => {
    expect(validateSpeechRegister(['مرحبًا بكم يا طلاب.'], saudi)).toEqual([]);
  });

  it('an English lesson taught in Arabic may say English words', () => {
    const english = resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'ENGLISH' })!;
    expect(
      validateSpeechRegister(['طيب يا شباب، خلونا نقرأ كلمة independently مع بعض.'], english),
    ).toEqual([]);
  });

  it('the MSA policy does not demand dialect, but still rejects foreign script', () => {
    const msa = resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'ARABIC' })!;
    expect(validateSpeechRegister(LI155_SCENE1, msa)).toEqual([]);
    expect(validateSpeechRegister([LI155_QUIZ], msa).map((issue) => issue.code)).toEqual([
      'LATIN_SCRIPT',
    ]);
  });
});
