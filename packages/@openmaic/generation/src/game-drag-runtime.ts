/**
 * Kafuo drag runtime for generated games.
 *
 * Generated games used to improvise drag and drop, and a real one (Learning
 * Item 155, "محقق الأنماط والبيانات") shipped unplayable:
 * - native `draggable=true` hijacked the pointer, so the drop never fired;
 * - the element never followed the pointer;
 * - the answer check compared «١٦» with "16" as raw strings.
 *
 * Every game now gets ONE tested helper, `window.KafuoDrag`, embedded in its
 * HTML (self-contained: no CDN, no storage), so it works in the sandboxed web
 * iframe and in the mobile WebView alike. The prompt tells the model to use
 * it, and `validateGameDragContract` rejects the known defects before the
 * helper is injected.
 */

export const KAFUO_DRAG_RUNTIME_MARKER = '<!-- kafuo-drag-runtime v1 -->';

/**
 * The helper, ES5-only for older WebViews. Pointer events with pointer
 * capture; the element moves with `transform` and returns to its place after
 * the gesture (the game decides what a drop does); targets are resolved when
 * the gesture starts, so levels rendered later still work; answer values are
 * compared with Arabic-Indic and Western digits treated as equal.
 */
const RUNTIME = `${KAFUO_DRAG_RUNTIME_MARKER}
<style id="kafuo-drag-style">
.kd-draggable{touch-action:none;-webkit-user-select:none;user-select:none;cursor:grab}
.kd-dragging{cursor:grabbing;z-index:2147483000;opacity:.92;transition:none!important}
.kd-returning{transition:transform .2s ease}
.kd-over{outline:3px dashed currentColor;outline-offset:3px}
</style>
<script id="kafuo-drag-runtime">
(function () {
  if (window.KafuoDrag) return;
  var DIGITS = /[\\u0660-\\u0669\\u06F0-\\u06F9]/g;
  function normalize(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(DIGITS, function (d) {
        var code = d.charCodeAt(0);
        return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
      })
      .replace(/\\s+/g, ' ')
      .trim();
  }
  function toList(targets) {
    if (typeof targets === 'function') targets = targets();
    if (!targets) return [];
    if (typeof targets === 'string') return Array.prototype.slice.call(document.querySelectorAll(targets));
    if (targets.nodeType === 1) return [targets];
    return Array.prototype.slice.call(targets);
  }
  function hit(targets, x, y) {
    for (var i = 0; i < targets.length; i++) {
      var r = targets[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return targets[i];
    }
    return null;
  }
  // Native HTML5 drag cancels the pointer gesture; games drag with KafuoDrag only.
  document.addEventListener('dragstart', function (event) { event.preventDefault(); }, true);

  function makeDraggable(el, options) {
    options = options || {};
    if (!el || el.__kafuoDrag) return el;
    el.__kafuoDrag = true;
    el.classList.add('kd-draggable');
    el.setAttribute('draggable', 'false');
    el.addEventListener('pointerdown', function (down) {
      if (el.__kafuoDragDisabled || (down.button !== undefined && down.button > 0)) return;
      down.preventDefault();
      var targets = toList(options.targets);
      var startX = down.clientX;
      var startY = down.clientY;
      var over = null;
      var moved = false;
      var restorePosition = null;
      try { el.setPointerCapture(down.pointerId); } catch (e) {}
      if (window.getComputedStyle(el).position === 'static') {
        restorePosition = el.style.position;
        el.style.position = 'relative';
      }
      el.classList.remove('kd-returning');
      el.classList.add('kd-dragging');
      // No text selection while dragging (it would highlight the page).
      var bodyStyle = document.body ? document.body.style : null;
      var restoreSelect = bodyStyle ? bodyStyle.userSelect : '';
      if (bodyStyle) { bodyStyle.userSelect = 'none'; bodyStyle.webkitUserSelect = 'none'; }
      if (window.getSelection) { try { window.getSelection().removeAllRanges(); } catch (e) {} }
      function move(event) {
        if (event.pointerId !== down.pointerId) return;
        var dx = event.clientX - startX;
        var dy = event.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        var now = hit(targets, event.clientX, event.clientY);
        if (now !== over) {
          if (over) over.classList.remove('kd-over');
          if (now) now.classList.add('kd-over');
          over = now;
        }
      }
      function finish(event, cancelled) {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', cancel);
        if (over) over.classList.remove('kd-over');
        el.classList.remove('kd-dragging');
        if (bodyStyle) { bodyStyle.userSelect = restoreSelect; bodyStyle.webkitUserSelect = restoreSelect; }
        // A fast gesture may deliver no pointermove at all: judge it by where it ended.
        if (!moved) moved = Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY) > 3;
        el.classList.add('kd-returning');
        el.style.transform = '';
        setTimeout(function () {
          el.classList.remove('kd-returning');
          if (restorePosition !== null) el.style.position = restorePosition;
        }, 220);
        var target = cancelled ? null : hit(targets, event.clientX, event.clientY);
        if (target && typeof options.onDrop === 'function') options.onDrop(el, target);
        else if (!cancelled && moved && typeof options.onMiss === 'function') options.onMiss(el);
      }
      function up(event) { if (event.pointerId === down.pointerId) finish(event, false); }
      function cancel(event) { if (event.pointerId === down.pointerId) finish(event, true); }
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', cancel);
    });
    return el;
  }
  window.KafuoDrag = {
    makeDraggable: makeDraggable,
    disable: function (el) { if (el) { el.__kafuoDragDisabled = true; el.classList.remove('kd-draggable'); } },
    sameValue: function (a, b) { return normalize(a) === normalize(b); },
    normalize: normalize
  };
})();
</script>`;

/**
 * Embed the helper right after `<head>` (before any game script), once.
 * Inserted with index arithmetic: the runtime contains `$`, which
 * `String.replace` would interpret.
 */
export function injectGameDragRuntime(html: string): string {
  if (html.includes(KAFUO_DRAG_RUNTIME_MARKER)) return html;
  for (const opening of [/<head\b[^>]*>/i, /<html\b[^>]*>/i]) {
    const match = opening.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return `${html.slice(0, at)}\n${RUNTIME}\n${html.slice(at)}`;
    }
  }
  return `${RUNTIME}\n${html}`;
}

export type GameDragIssueCode = 'NATIVE_DRAG' | 'CUSTOM_DRAG' | 'RAW_VALUE_COMPARISON';

export interface GameDragIssue {
  code: GameDragIssueCode;
  evidence: string;
}

/** Native HTML5 drag: `draggable=true` or its events. `draggable="false"` is harmless. */
const NATIVE_DRAG =
  /\bdraggable\s*=\s*["']?true\b|\.draggable\s*=\s*true\b|setAttribute\(\s*["']draggable["']\s*,\s*["']?true|addEventListener\(\s*["'](?:dragstart|dragover|dragenter|dragleave|dragend|drop)["']|\bon(?:dragstart|dragover|dragenter|drop)\s*=/i;
/** The game asks the player to drag (Arabic «اسحب…» or the English word). */
const DRAG_INTENT = /اسحب|\bdrag\b/i;
/** Hand-rolled pointer dragging. */
const POINTER_CAPTURE = /setPointerCapture\s*\(/;
const USES_HELPER = /KafuoDrag\.makeDraggable\s*\(/;
const USES_SAME_VALUE = /KafuoDrag\.sameValue\s*\(/;
const ARABIC_INDIC_DIGIT = /[٠-٩۰-۹]/;
/** A raw equality test on a `data-*` value (`x.dataset.v === z.dataset.v`). */
const DATASET_EQUALITY = /dataset\.[\w$]+\s*[!=]==?|[!=]==?\s*[\w$.[\]]*dataset\./;

function evidence(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  return match
    ? html.slice(Math.max(0, match.index - 20), match.index + 60).replace(/\s+/g, ' ')
    : '';
}

/**
 * Known drag defects in a generated game, checked on the MODEL's HTML (before
 * the helper is injected). Empty when the game respects the drag contract.
 */
export function validateGameDragContract(html: string): GameDragIssue[] {
  const issues: GameDragIssue[] = [];
  if (NATIVE_DRAG.test(html)) {
    issues.push({ code: 'NATIVE_DRAG', evidence: evidence(html, NATIVE_DRAG) });
  }
  const usesHelper = USES_HELPER.test(html);
  if (!usesHelper && (DRAG_INTENT.test(html) || POINTER_CAPTURE.test(html))) {
    const pattern = POINTER_CAPTURE.test(html) ? POINTER_CAPTURE : DRAG_INTENT;
    issues.push({ code: 'CUSTOM_DRAG', evidence: evidence(html, pattern) });
  }
  if (ARABIC_INDIC_DIGIT.test(html) && DATASET_EQUALITY.test(html) && !USES_SAME_VALUE.test(html)) {
    issues.push({ code: 'RAW_VALUE_COMPARISON', evidence: evidence(html, DATASET_EQUALITY) });
  }
  return issues;
}

/** The correction appended to a game re-roll. */
export function formatGameDragCorrection(issues: readonly GameDragIssue[]): string {
  const lines = issues.map((issue) => {
    switch (issue.code) {
      case 'NATIVE_DRAG':
        return `- Native HTML5 drag is used (\`${issue.evidence}\`). Remove every \`draggable\` attribute/property and every dragstart/dragover/drop handler.`;
      case 'CUSTOM_DRAG':
        return `- Dragging is implemented by hand or not at all (\`${issue.evidence}\`). Make every dragged element with \`KafuoDrag.makeDraggable(element, { targets, onDrop, onMiss })\`.`;
      case 'RAW_VALUE_COMPARISON':
        return `- Answer values are compared as raw strings while the game shows Arabic-Indic digits (\`${issue.evidence}\`). Keep \`data-*\` answer keys in Western digits and compare with \`KafuoDrag.sameValue(a, b)\`.`;
    }
  });
  return lines.join('\n');
}

/** Append the drag-contract rejection to a game re-roll's user prompt. */
export function withGameDragCorrection(
  userPrompt: string,
  issues: readonly GameDragIssue[],
): string {
  return `${userPrompt}\n\n---\n\n## Correction Required\n\nYour previous game was REJECTED by validation:\n\n${formatGameDragCorrection(issues)}\n\nAnswer again with the complete HTML document, fixing every issue above.`;
}
