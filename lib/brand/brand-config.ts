/**
 * Brand configuration.
 *
 * The reference (live deployment) resolves the brand per vendor from the
 * desktop shell's User-Agent token. This workspace has no vendor shell: the
 * product ships with its own single brand, so the config is static and the
 * desktop flag is always off. The shape is kept so surfaces that read the
 * brand (home hero, workspace rail, site header) keep one source of truth.
 */

export interface BrandConfig {
  /** Full product name (page titles, logo alt text). */
  productName: string;
  /** Short name for space-constrained spots. */
  shortName: string;
  /** Horizontal logo asset under `public/`. */
  logoSrc: string;
  /** Whether `logoSrc` already carries the product wordmark. When false,
   *  surfaces render `markSrc` with `productName` beside it (`BrandLockup`). */
  logoHasWordmark: boolean;
  /** Square brand mark under `public/` (favicon, workspace header). */
  markSrc: string;
  /** Browser theme color (`<meta name="theme-color">` / PWA). */
  themeColor: string;
}

/**
 * The default brand: Teaching Engine, with no vendor overrides.
 *
 * No approved Teaching Engine logo exists yet. `public/logo-horizontal.png`
 * carries the upstream OpenMAIC wordmark, so it is no longer shown; until the
 * final assets land, every surface pairs the standalone mark (temporary, file
 * name kept for compatibility) with the product name set in app typography.
 */
export const DEFAULT_BRAND: BrandConfig = {
  productName: 'Teaching Engine',
  shortName: 'Teaching Engine',
  logoSrc: '/openmaic-mark.png',
  logoHasWordmark: false,
  markSrc: '/openmaic-mark.png',
  themeColor: '#722ed1',
};
