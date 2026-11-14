export type LocaleEntry = {
  code: string;
  /** Native name shown in dropdown, e.g. '简体中文' */
  label: string;
  /** Short label shown on the toggle button, e.g. 'CN' */
  shortLabel: string;
};

/**
 * Supported locales registry.
 *
 * To add a new language:
 *   1. Create `lib/i18n/locales/<code>.json` (copy an existing file as template)
 *   2. Add an entry here
 */
export const supportedLocales = [
  { code: 'zh-CN', label: '简体中文', shortLabel: 'CN' },
  { code: 'zh-TW', label: '繁體中文', shortLabel: 'TW' },
  { code: 'en-US', label: 'English', shortLabel: 'EN' },
  { code: 'ja-JP', label: '日本語', shortLabel: 'JA' },
  { code: 'ru-RU', label: 'Русский', shortLabel: 'RU' },
  { code: 'ar-SA', label: 'العربية', shortLabel: 'AR' },
  { code: 'pt-BR', label: 'Português (Brasil)', shortLabel: 'BR' },
  { code: 'ko-KR', label: '한국어', shortLabel: 'KO' },
  { code: 'es-MX', label: 'Español (México)', shortLabel: 'ES' },
  { code: 'fr-FR', label: 'Français', shortLabel: 'FR' },
  { code: 'vi-VN', label: 'Tiếng Việt', shortLabel: 'VI' },
  { code: 'de-DE', label: 'Deutsch', shortLabel: 'DE' },
] as const satisfies readonly LocaleEntry[];

/** Languages written right to left (by primary subtag). */
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);

/**
 * The page direction for a locale code: `rtl` for Arabic (and the other RTL scripts),
 * `ltr` otherwise. Owner, 14 Nov 2026: the teacher UI follows Arabic right to left.
 */
export function localeDirection(locale: string | null | undefined): 'rtl' | 'ltr' {
  const language = (locale ?? '').split('-')[0].toLowerCase();
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}
