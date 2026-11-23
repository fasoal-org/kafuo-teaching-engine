// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PPTTableElement } from '@openmaic/dsl';
import { StaticTable } from '../../../src/elements/table/StaticTable';

const table: PPTTableElement = {
  id: 'table-1',
  type: 'table',
  left: 0,
  top: 0,
  width: 240,
  height: 80,
  rotate: 0,
  colWidths: [1],
  cellMinHeight: 80,
  outline: { width: 1, color: '#333333', style: 'solid' },
  data: [[{ id: 'cell-1', colspan: 1, rowspan: 1, text: 'Centered by default' }]],
};

describe('StaticTable', () => {
  it('vertically centers a cell when no explicit vertical alignment is stored', () => {
    const { container } = render(<StaticTable elementInfo={table} />);

    expect(
      (container.querySelector('.slide-renderer-cell-text') as HTMLElement).style.justifyContent,
    ).toBe('center');
  });

  it('uses unique render keys when source cell ids are duplicated', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const duplicateIds: PPTTableElement = {
      ...table,
      colWidths: [0.5, 0.5],
      data: [
        [
          { id: 'duplicate', colspan: 1, rowspan: 1, text: 'First' },
          { id: 'duplicate', colspan: 1, rowspan: 1, text: 'Second' },
        ],
      ],
    };

    render(<StaticTable elementInfo={duplicateIds} />);

    expect(error.mock.calls.some((call) => String(call[0]).includes('unique "key" prop'))).toBe(
      false,
    );
    error.mockRestore();
  });

  const withHeader = (...header: string[]): PPTTableElement => ({
    ...table,
    colWidths: header.map(() => 1 / header.length),
    data: [
      header.map((text, i) => ({ id: `h${i}`, colspan: 1, rowspan: 1, text })),
      header.map((_, i) => ({ id: `r${i}`, colspan: 1, rowspan: 1, text: 'T' })),
    ],
  });

  it('renders a truth table (Latin/symbol header) left to right on any page', () => {
    const { container } = render(
      <div dir="rtl">
        <StaticTable elementInfo={withHeader('p', 'q', '∼p → ∼q')} />
      </div>,
    );

    expect((container.querySelector('table') as HTMLElement).style.direction).toBe('ltr');
    // Each cell takes its own text's direction, so an Arabic cell still reads RTL.
    expect(container.querySelector('td')?.getAttribute('dir')).toBe('auto');
  });

  it('keeps the page direction for a physics header without a logic connective', () => {
    const physics = render(<StaticTable elementInfo={withHeader('t (s)', 'v (m/s)')} />);
    expect((physics.container.querySelector('table') as HTMLElement).style.direction).toBe('');
    expect(physics.container.querySelector('td')?.getAttribute('dir')).toBeNull();
  });

  it('keeps the page direction for an Arabic or mixed header', () => {
    const arabic = render(<StaticTable elementInfo={withHeader('العبارة', 'قيمة الصواب')} />);
    expect((arabic.container.querySelector('table') as HTMLElement).style.direction).toBe('');

    const mixed = render(<StaticTable elementInfo={withHeader('p', 'q', 'p و q')} />);
    expect((mixed.container.querySelector('table') as HTMLElement).style.direction).toBe('');
  });
});
