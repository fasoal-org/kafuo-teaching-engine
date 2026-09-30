// @vitest-environment jsdom

/**
 * The shared lockup and the surfaces that draw the product identity.
 *
 * The lockup renders from `DEFAULT_BRAND` only, and no chrome surface may
 * carry its own product name or the upstream OpenMAIC wordmark image.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { BrandLockup } from '@/components/brand/brand-lockup';
import { BrandProvider } from '@/lib/brand/brand-context';
import { DEFAULT_BRAND } from '@/lib/brand/brand-config';
import { EXPORT_PRODUCT_NAME } from '@/lib/video-export/emit-hyperframes';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function render(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('BrandLockup', () => {
  it('pairs the mark with the product name when the logo has no wordmark', () => {
    const host = render(<BrandLockup testId="lockup" />);
    const img = host.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(DEFAULT_BRAND.markSrc);
    expect(img.getAttribute('alt')).toBe('Teaching Engine');
    expect(host.textContent).toBe('Teaching Engine');
    expect(host.querySelector('[data-testid="lockup"]')).not.toBeNull();
  });

  it('renders a wordmark logo alone when the brand ships one', () => {
    const host = render(
      <BrandProvider brand={{ ...DEFAULT_BRAND, logoSrc: '/wordmark.svg', logoHasWordmark: true }}>
        <BrandLockup />
      </BrandProvider>,
    );
    const imgs = host.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('/wordmark.svg');
    expect(imgs[0].getAttribute('alt')).toBe('Teaching Engine');
    expect(host.textContent).toBe('');
  });

  it('goes silent for assistive tech when decorative', () => {
    const host = render(<BrandLockup decorative />);
    expect(host.querySelector('img')!.getAttribute('alt')).toBe('');
    expect(host.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('chrome surfaces read the central brand', () => {
  it('video export metadata names the same product as the brand config', () => {
    expect(EXPORT_PRODUCT_NAME).toBe(DEFAULT_BRAND.productName);
  });

  const SURFACES = [
    'app/layout.tsx',
    'app/page.tsx',
    'components/access-code-modal.tsx',
    'components/stage/scene-sidebar.tsx',
    'components/scene-renderers/pbl/v2/workspace.tsx',
    'components/workbench/workspace/WorkspaceHome.tsx',
    'components/workbench/workspace/WorkspaceRail.tsx',
    'components/edit/SlideNavRail/SlideNavRail.tsx',
    'lib/video-export/emit-hyperframes/index.ts',
  ];

  it.each(SURFACES)('%s hardcodes no product name or wordmark image', (file) => {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8');
    // Strip comments: prose may still describe the upstream project.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/['"`>]\s*OpenMAIC\b/);
    expect(code).not.toMatch(/OpenMAIC (video|Open Source)/);
    expect(code).not.toContain('logo-horizontal.png');
    expect(code).not.toMatch(/alt="OpenMAIC"/);
  });
});
