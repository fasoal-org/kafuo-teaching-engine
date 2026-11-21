import { describe, expect, it } from 'vitest';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import deDE from '@/lib/i18n/locales/de-DE.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import viVN from '@/lib/i18n/locales/vi-VN.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';

/**
 * The slide rail names a kept generation issue through the dynamic key
 * `edit.nav.generationIssue.<code>` (`components/edit/SlideNavRail/ThumbItem.tsx`), which
 * the editor-chrome key scan cannot expand. A locale missing a code silently shows the
 * server's raw message instead, so every code en-US names must resolve in all 12 locales.
 */
const locales = {
  'ar-SA': arSA,
  'de-DE': deDE,
  'en-US': enUS,
  'es-MX': esMX,
  'fr-FR': frFR,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'vi-VN': viVN,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

const issuesOf = (locale: unknown): Record<string, unknown> =>
  ((locale as { edit?: { nav?: { generationIssue?: Record<string, unknown> } } }).edit?.nav
    ?.generationIssue ?? {}) as Record<string, unknown>;

const CODES = Object.keys(issuesOf(enUS));

describe('edit.nav.generationIssue copy', () => {
  it('en-US names NARRATION_MISSING beside NARRATION_AUDIO_FAILED', () => {
    expect(CODES).toEqual(expect.arrayContaining(['NARRATION_AUDIO_FAILED', 'NARRATION_MISSING']));
  });

  it.each(Object.entries(locales))('%s carries every generation-issue code', (_name, locale) => {
    const issues = issuesOf(locale);
    const missing = CODES.filter((code) => {
      const value = issues[code];
      return typeof value !== 'string' || value.trim() === '';
    });
    expect(missing).toEqual([]);
  });
});
