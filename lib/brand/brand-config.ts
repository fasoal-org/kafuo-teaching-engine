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
 * The default brand: Teaching Engine, dressed in Kafuo's identity.
 *
 * Owner, 14 Nov 2026: the Kafuo hexagon mark (`public/kafuo-mark.png`, the same
 * file the website and the mobile app ship) and Kafuo navy replace the interim
 * OpenMAIC mark and purple. The product name stays Teaching Engine, set beside the
 * mark in app typography (`logoHasWordmark: false`). `public/openmaic-mark.png`
 * stays on disk for the PBL workspace assets that still reference it.
 */
export const DEFAULT_BRAND: BrandConfig = {
  productName: 'Teaching Engine',
  shortName: 'Teaching Engine',
  logoSrc: '/kafuo-mark.png',
  logoHasWordmark: false,
  markSrc: '/kafuo-mark.png',
  themeColor: '#001336',
};
