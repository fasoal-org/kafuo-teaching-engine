'use client';

/**
 * The product lockup every chrome surface draws its identity with.
 *
 * Reads the brand from `useBrand()` so the product name, mark and logo come
 * from `lib/brand/brand-config.ts` alone. A brand whose horizontal logo
 * already carries the wordmark renders that image; otherwise the square mark
 * sits beside the product name set in the app's own typography — the interim
 * Teaching Engine lockup until a final wordmark asset exists.
 */

import { useBrand } from '@/lib/brand/brand-context';
import { cn } from '@/lib/utils';

export function BrandLockup({
  className,
  logoClassName,
  markClassName,
  textClassName,
  decorative = false,
  useShortName = false,
  testId,
}: {
  /** Wrapper classes (layout, gap). */
  className?: string;
  /** Size of the horizontal logo when the brand ships a wordmark image. */
  logoClassName?: string;
  /** Size of the square mark in the mark + name lockup. */
  markClassName?: string;
  /** Type ramp of the product name in the mark + name lockup. */
  textClassName?: string;
  /** Hide from assistive tech when an enclosing control already names it. */
  decorative?: boolean;
  /** Use `shortName` for space-constrained spots. */
  useShortName?: boolean;
  testId?: string;
}) {
  const brand = useBrand();
  const name = useShortName ? brand.shortName : brand.productName;
  const alt = decorative ? '' : name;

  if (brand.logoHasWordmark) {
    return (
      <img
        src={brand.logoSrc}
        alt={alt}
        aria-hidden={decorative || undefined}
        data-testid={testId}
        className={cn(logoClassName, className)}
      />
    );
  }

  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-2', className)}
      aria-hidden={decorative || undefined}
      data-testid={testId}
    >
      <img src={brand.markSrc} alt={alt} className={cn('shrink-0', markClassName)} />
      <span
        aria-hidden="true"
        className={cn('whitespace-nowrap font-semibold tracking-tight', textClassName)}
        style={{ color: brand.themeColor }}
      >
        {name}
      </span>
    </span>
  );
}
