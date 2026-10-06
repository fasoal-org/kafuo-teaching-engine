/**
 * The drag contract for generated games. The fixture is the real mission-1
 * code of Learning Item 155's game ("محقق الأنماط والبيانات", Stage
 * `stage-WLeMHc2BkPyC`), which was unplayable: native `draggable=true`
 * hijacked the gesture, the card never moved, and «١٦» was compared with "16".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  buildPrompt,
  generateWidgetContent,
  GAME_DRAG_MAX_ATTEMPTS,
  injectGameDragRuntime,
  KAFUO_DRAG_RUNTIME_MARKER,
  PROMPT_IDS,
  validateGameDragContract,
  type AICallFn,
  type SceneOutline,
} from '@openmaic/generation';

const LI155_MISSION1 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'li155-game-mission1.js'),
  'utf-8',
);

const page = (script: string) => `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><title>لعبة</title></head>
<body><div id="pool"></div><div class="slot" data-accept="16">الخانة</div>
<script>${script}</script>
</body>
</html>`;

const COMPLIANT = page(`
const card = document.createElement('div');
card.textContent = '١٦';
card.dataset.value = '16';
document.getElementById('pool').append(card);
KafuoDrag.makeDraggable(card, {
  targets: '.slot',
  onDrop: (el, slot) => KafuoDrag.sameValue(el.dataset.value, slot.dataset.accept) ? el.remove() : null,
});
// اسحب البطاقة إلى الخانة، the price is $5.
`);

describe('validateGameDragContract', () => {
  test('flags every defect of the real Learning Item 155 mission 1', () => {
    const codes = validateGameDragContract(page(LI155_MISSION1)).map((issue) => issue.code);
    expect(codes).toEqual(['NATIVE_DRAG', 'CUSTOM_DRAG', 'RAW_VALUE_COMPARISON']);
  });

  test('a game that uses KafuoDrag passes', () => {
    expect(validateGameDragContract(COMPLIANT)).toEqual([]);
  });

  test('draggable="false" and the helper name itself are not native drag', () => {
    const html = COMPLIANT.replace('<div id="pool">', '<div id="pool" draggable="false">');
    expect(validateGameDragContract(html)).toEqual([]);
  });

  test('native drag events are flagged even with the helper present', () => {
    const html = COMPLIANT.replace(
      "document.getElementById('pool')",
      "document.addEventListener('drop', () => {}); document.getElementById('pool')",
    );
    expect(validateGameDragContract(html).map((issue) => issue.code)).toEqual(['NATIVE_DRAG']);
  });

  test('a game with no dragging at all is not touched', () => {
    expect(validateGameDragContract(page('let score = 0; function tap() { score += 1; }'))).toEqual(
      [],
    );
  });
});

describe('injectGameDragRuntime', () => {
  test('embeds the helper once, right after <head>, before any game script', () => {
    const injected = injectGameDragRuntime(COMPLIANT);
    expect(injected.split(KAFUO_DRAG_RUNTIME_MARKER)).toHaveLength(2);
    expect(injected.indexOf(KAFUO_DRAG_RUNTIME_MARKER)).toBeGreaterThan(injected.indexOf('<head>'));
    expect(injected.indexOf('window.KafuoDrag')).toBeLessThan(
      injected.indexOf('KafuoDrag.makeDraggable(card'),
    );
    // `$` in the game survives verbatim (no String.replace substitution).
    expect(injected).toContain('the price is $5.');
    expect(injectGameDragRuntime(injected)).toBe(injected);
  });

  test('the embedded helper is self-contained (no CDN, no storage)', () => {
    const runtime = injectGameDragRuntime('<html><head></head><body></body></html>');
    expect(runtime).not.toMatch(/https?:\/\//);
    expect(runtime).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe('generateWidgetContent — games', () => {
  const outline: SceneOutline = {
    id: 'game-scene',
    type: 'interactive',
    title: 'محقق الأنماط',
    description: 'Drag the terms into order.',
    keyPoints: ['patterns'],
    order: 1,
    widgetType: 'game',
    widgetOutline: { gameType: 'puzzle' } as SceneOutline['widgetOutline'],
  };

  function scripted(replies: string[]) {
    const calls: Array<{ system: string; user: string }> = [];
    const aiCall: AICallFn = async (system, user) => {
      calls.push({ system, user });
      return replies[Math.min(calls.length - 1, replies.length - 1)]!;
    };
    return { aiCall, calls };
  }

  test('a defective game is re-rolled once with the correction, then embedded with the helper', async () => {
    const { aiCall, calls } = scripted([page(LI155_MISSION1), COMPLIANT]);
    const result = await generateWidgetContent(outline, aiCall);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).toContain('## Drag and Drop (MANDATORY whenever anything is dragged)');
    expect(calls[0]!.user).not.toContain('Correction Required');
    expect(calls[1]!.user).toContain('Correction Required');
    expect(calls[1]!.user).toContain('KafuoDrag.sameValue');
    expect(result?.html.split(KAFUO_DRAG_RUNTIME_MARKER)).toHaveLength(2);
  });

  test('a game that keeps breaking the contract is refused after the bounded budget', async () => {
    const { aiCall, calls } = scripted([page(LI155_MISSION1)]);
    const failures: Array<{ code: string; detail?: string }> = [];
    const result = await generateWidgetContent(outline, aiCall, undefined, {
      onFailure: (failure) => failures.push(failure),
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(GAME_DRAG_MAX_ATTEMPTS);
    expect(failures).toEqual([
      {
        code: 'invalid-model-output',
        detail: 'game drag contract: NATIVE_DRAG, CUSTOM_DRAG, RAW_VALUE_COMPARISON',
      },
    ]);
  });

  test('a compliant game is accepted on the first answer', async () => {
    const { aiCall, calls } = scripted([COMPLIANT]);
    const result = await generateWidgetContent(outline, aiCall);
    expect(calls).toHaveLength(1);
    expect(result?.html).toContain('window.KafuoDrag');
  });

  test('without the new code path the game prompt is unchanged (no drag section)', () => {
    const prompts = buildPrompt(PROMPT_IDS.GAME_CONTENT, { title: 't' })!;
    expect(prompts.system).not.toContain('KafuoDrag');
    expect(prompts.system).not.toContain('{{#if');
  });
});
