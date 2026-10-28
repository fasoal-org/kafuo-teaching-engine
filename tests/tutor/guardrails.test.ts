/**
 * Guardrails review 28 Oct 2026: input moderation (Layer 2) and the identity
 * post-check (Layer 3). Pure functions plus the OpenAI moderation client against a
 * fake fetch; the turn-level wiring is pinned in `conversation-routes.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  IDENTITY_REPLY_AR,
  IDENTITY_REPLY_EN,
  identityReply,
  namesProvider,
} from '@/lib/server/tutor/identity-guard';
import {
  classifyModeration,
  createModerationCheck,
  getModerationCheck,
  isModerationEnabled,
  MODERATION_MODEL,
  MODERATION_REFUSAL_MESSAGE_AR,
  MODERATION_REFUSAL_MESSAGE_EN,
  moderateTurn,
  moderationReply,
  SELF_HARM_SUPPORT_MESSAGE_AR,
  SELF_HARM_SUPPORT_MESSAGE_EN,
} from '@/lib/server/tutor/moderation-guard';

function body(flagged: boolean, categories: Record<string, boolean>) {
  return { results: [{ flagged, categories }] };
}

describe('input moderation — classify', () => {
  it('self-harm wins over every other flagged category', () => {
    expect(
      classifyModeration(body(true, { violence: true, 'self-harm/intent': true, sexual: false })),
    ).toEqual({ outcome: 'self_harm', categories: ['self-harm/intent'] });
  });

  it('other flagged categories → flagged; nothing flagged → clear', () => {
    expect(classifyModeration(body(true, { harassment: true, hate: false }))).toEqual({
      outcome: 'flagged',
      categories: ['harassment'],
    });
    expect(classifyModeration(body(false, { harassment: false }))).toEqual({ outcome: 'clear' });
  });

  it('an unreadable body is unavailable, never clear', () => {
    expect(classifyModeration({})).toEqual({ outcome: 'unavailable', kind: 'invalid_body' });
    expect(classifyModeration(null)).toEqual({ outcome: 'unavailable', kind: 'invalid_body' });
  });
});

describe('input moderation — OpenAI client', () => {
  it('posts the text to /moderations with the server key and the omni model', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const check = createModerationCheck({
      credentials: () => ({ apiKey: 'sk-test', baseUrl: 'https://proxy.example/v1/' }),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body(false, {})), { status: 200 });
      },
    });
    expect(await check('سؤال')).toEqual({ outcome: 'clear' });
    expect(calls[0]!.url).toBe('https://proxy.example/v1/moderations');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: MODERATION_MODEL,
      input: 'سؤال',
    });
  });

  it('no key, a network error, a timeout or an HTTP error → unavailable (fail open)', async () => {
    const noKey = createModerationCheck({ credentials: () => ({ apiKey: '' }) });
    expect(await noKey('x')).toEqual({ outcome: 'unavailable', kind: 'no_api_key' });

    const network = createModerationCheck({
      credentials: () => ({ apiKey: 'k' }),
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await network('x')).toEqual({ outcome: 'unavailable', kind: 'network' });

    const timeout = createModerationCheck({
      credentials: () => ({ apiKey: 'k' }),
      fetch: async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    });
    expect(await timeout('x')).toEqual({ outcome: 'unavailable', kind: 'timeout' });

    const http = createModerationCheck({
      credentials: () => ({ apiKey: 'k' }),
      fetch: async () => new Response('busy', { status: 503 }),
    });
    expect(await http('x')).toEqual({ outcome: 'unavailable', kind: 'http_503' });
  });

  it('a throwing check is unavailable; an absent check is clear', async () => {
    const throwing = async () => {
      throw new Error('boom');
    };
    expect(await moderateTurn(throwing, 'x', 'turn-1')).toEqual({
      outcome: 'unavailable',
      kind: 'Error',
    });
    expect(await moderateTurn(null, 'x', 'turn-1')).toEqual({ outcome: 'clear' });
  });

  it('is on by default and off only with TUTOR_MODERATION_ENABLED=false', () => {
    expect(isModerationEnabled({})).toBe(true);
    expect(isModerationEnabled({ TUTOR_MODERATION_ENABLED: 'true' })).toBe(true);
    expect(isModerationEnabled({ TUTOR_MODERATION_ENABLED: 'FALSE' })).toBe(false);
    expect(getModerationCheck({ TUTOR_MODERATION_ENABLED: 'false' })).toBeNull();
  });
});

describe('input moderation — fixed replies', () => {
  it('self-harm gets the supportive reply in the student language, never the refusal', () => {
    const verdict = { outcome: 'self_harm' as const, categories: ['self-harm'] };
    expect(moderationReply(verdict, false, 'ar')).toEqual({
      text: SELF_HARM_SUPPORT_MESSAGE_AR,
      reason: 'moderation_self_harm',
    });
    // Even when the experiment guard also triggered.
    expect(moderationReply(verdict, true, 'en')).toEqual({
      text: SELF_HARM_SUPPORT_MESSAGE_EN,
      reason: 'moderation_self_harm',
    });
    expect(SELF_HARM_SUPPORT_MESSAGE_EN).not.toMatch(/[؀-ۿ]/);
  });

  it('flagged gets the refusal unless the experiment guard owns the turn', () => {
    const verdict = { outcome: 'flagged' as const, categories: ['violence'] };
    expect(moderationReply(verdict, false, 'ar')).toEqual({
      text: MODERATION_REFUSAL_MESSAGE_AR,
      reason: 'moderation_flagged',
    });
    expect(moderationReply(verdict, false, 'en')!.text).toBe(MODERATION_REFUSAL_MESSAGE_EN);
    expect(moderationReply(verdict, true, 'ar')).toBeNull();
  });

  it('clear and unavailable let the model answer', () => {
    expect(moderationReply({ outcome: 'clear' }, false, 'ar')).toBeNull();
    expect(moderationReply({ outcome: 'unavailable', kind: 'timeout' }, false, 'ar')).toBeNull();
  });
});

describe('identity post-check', () => {
  it('catches the tutor naming the model or provider, in English and Arabic', () => {
    for (const reply of [
      "I'm ChatGPT, a language model developed by OpenAI.",
      'I am Qwen, created by Alibaba Cloud.',
      'أنا ChatGPT، نموذج لغوي.',
      'أنا مساعد من تطوير أوبن إيه آي.',
      'I was trained by Google and my name is Gemini.',
      'أنا جيميني من جوجل.',
    ]) {
      expect(namesProvider(reply), reply).toBe(true);
    }
  });

  it('leaves ordinary school answers alone', () => {
    for (const reply of [
      'Claude Monet painted Water Lilies. I am happy to explain impressionism.',
      'كوكبة الجوزاء (Gemini) تظهر في الشتاء.',
      'I am glad you asked: the slope is \\(m = 2\\).',
      'أنا معلم كفو، خلّنا نحل المعادلة خطوة خطوة.',
      'The children played in the open air all afternoon.',
      'He was a philanthropic businessman who built schools.',
      'The city plans to reopen airports after the storm.',
    ]) {
      expect(namesProvider(reply), reply).toBe(false);
    }
  });

  it('the identity reply is «معلم كفو» in one language', () => {
    expect(identityReply('ar')).toBe(IDENTITY_REPLY_AR);
    expect(identityReply('en')).toBe(IDENTITY_REPLY_EN);
    expect(IDENTITY_REPLY_AR).toContain('معلم كفو');
    expect(IDENTITY_REPLY_EN).not.toMatch(/[؀-ۿ]/);
    expect(namesProvider(IDENTITY_REPLY_AR) || namesProvider(IDENTITY_REPLY_EN)).toBe(false);
  });
});
