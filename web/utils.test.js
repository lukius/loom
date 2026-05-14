import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { escapeHtml, uniqueName, uniqueIface, pad2, cssEscape, el, toast } from './utils.js';

describe('escapeHtml', () => {
  it('escapes ampersand and angle brackets', () => {
    expect(escapeHtml('a & b <c>')).toBe('a &amp; b &lt;c&gt;');
  });
  it('escapes double and single quotes', () => {
    expect(escapeHtml(`"hi" 'there'`)).toBe('&quot;hi&quot; &#39;there&#39;');
  });
  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });
  it('coerces null to empty string', () => {
    expect(escapeHtml(null)).toBe('');
  });
  it('coerces undefined to empty string', () => {
    expect(escapeHtml(undefined)).toBe('');
  });
  it('coerces numbers via String()', () => {
    expect(escapeHtml(42)).toBe('42');
  });
  it('double-escapes ampersand because & is processed character-by-character', () => {
    // The implementation visits each char independently — & in '&amp;' is itself escaped.
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
  it('leaves plain text untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('uniqueName', () => {
  it('returns prefix+1 for empty dict', () => {
    expect(uniqueName('h', {})).toBe('h1');
  });
  it('returns next free index when 1..n are taken', () => {
    expect(uniqueName('h', { h1: 1, h2: 1 })).toBe('h3');
  });
  it('skips gaps and returns first free slot', () => {
    expect(uniqueName('h', { h1: 1, h3: 1 })).toBe('h2');
  });
  it('works with arbitrary prefixes', () => {
    expect(uniqueName('router-', { 'router-1': 1 })).toBe('router-2');
  });
  it('ignores keys outside the prefix family', () => {
    expect(uniqueName('h', { r1: 1, r2: 1 })).toBe('h1');
  });
  it('treats falsy values as free (any falsy entry yields availability)', () => {
    // The loop checks `dict[key]` truthiness, so a falsy value (0, undefined, '') is "not taken".
    expect(uniqueName('h', { h1: 0 })).toBe('h1');
  });
});

describe('uniqueIface', () => {
  it('returns eth0 for empty dict', () => {
    expect(uniqueIface({})).toBe('eth0');
  });
  it('returns eth0 when not taken even if eth1 exists', () => {
    expect(uniqueIface({ eth1: 1 })).toBe('eth0');
  });
  it('returns next sequential when first N are taken', () => {
    expect(uniqueIface({ eth0: 1, eth1: 1, eth2: 1 })).toBe('eth3');
  });
  it('finds first gap in the sequence', () => {
    expect(uniqueIface({ eth0: 1, eth2: 1 })).toBe('eth1');
  });
});

describe('pad2', () => {
  it('pads single digit with leading zero', () => {
    expect(pad2(3)).toBe('03');
  });
  it('leaves two digits alone', () => {
    expect(pad2(42)).toBe('42');
  });
  it('pads zero to "00"', () => {
    expect(pad2(0)).toBe('00');
  });
  it('passes numbers >= 100 through unchanged (padStart no-op)', () => {
    expect(pad2(123)).toBe('123');
  });
  it('handles negative numbers as-is (negative sign breaks the pad)', () => {
    // padStart only adds chars when string length < 2; '-3' is length 2, no padding.
    expect(pad2(-3)).toBe('-3');
  });
});

describe('cssEscape', () => {
  // happy-dom provides CSS.escape, so the primary branch runs in tests.
  it('escapes dots', () => {
    expect(cssEscape('a.b')).toBe('a\\.b');
  });
  it('escapes brackets', () => {
    expect(cssEscape('a[b]')).toBe('a\\[b\\]');
  });
  it('leaves plain identifiers alone', () => {
    expect(cssEscape('abc')).toBe('abc');
  });
  it('escapes colons (common in IPv6-ish strings)', () => {
    expect(cssEscape('a:b')).toBe('a\\:b');
  });
  it('escapes slashes (common in CIDR strings)', () => {
    // CSS.escape only escapes the slash here; the leading digit case is covered separately.
    expect(cssEscape('a/b')).toBe('a\\/b');
  });
  it('escapes a leading digit using a hex code-point sequence (CSS.escape spec)', () => {
    // Per CSS spec, identifiers cannot start with a digit, so CSS.escape rewrites the
    // leading "1" as "\31 " (hex 31 = '1', trailing space terminates the escape).
    expect(cssEscape('10/24')).toBe('\\31 0\\/24');
  });
  it('returns empty for empty input', () => {
    expect(cssEscape('')).toBe('');
  });
});

describe('el', () => {
  it('builds an element (in the SVG namespace) with the requested tag', () => {
    const node = el('rect');
    expect(node.tagName).toBe('rect');
    expect(node.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });
  it('sets attributes from the attrs object', () => {
    const node = el('rect', { x: '5', y: '10', width: '20' });
    expect(node.getAttribute('x')).toBe('5');
    expect(node.getAttribute('y')).toBe('10');
    expect(node.getAttribute('width')).toBe('20');
  });
  it('sets class via setAttribute (special-cased branch)', () => {
    const node = el('g', { class: 'foo' });
    expect(node.getAttribute('class')).toBe('foo');
  });
  it('uses the "text" key to set textContent', () => {
    const node = el('text', { text: 'hello' });
    expect(node.textContent).toBe('hello');
    expect(node.getAttribute('text')).toBeNull();
  });
  it('skips attributes whose value is null or undefined', () => {
    const node = el('rect', { x: '5', y: null, width: undefined });
    expect(node.getAttribute('x')).toBe('5');
    expect(node.hasAttribute('y')).toBe(false);
    expect(node.hasAttribute('width')).toBe(false);
  });
  it('appends a string child as textContent', () => {
    const node = el('text', {}, 'hello');
    expect(node.textContent).toBe('hello');
  });
  it('appends an array of element children in order', () => {
    const a = el('rect');
    const b = el('rect');
    const node = el('g', {}, [a, b]);
    expect(node.children[0]).toBe(a);
    expect(node.children[1]).toBe(b);
  });
  it('appends a single element child', () => {
    const child = el('rect');
    const node = el('g', {}, child);
    expect(node.children[0]).toBe(child);
  });
  it('filters falsy entries out of children arrays', () => {
    const a = el('rect');
    const node = el('g', {}, [a, null, undefined, false]);
    expect(node.children.length).toBe(1);
    expect(node.children[0]).toBe(a);
  });
  it('builds with no attrs and no children (defaults)', () => {
    const node = el('rect');
    expect(node.tagName).toBe('rect');
    expect(node.attributes.length).toBe(0);
    expect(node.children.length).toBe(0);
  });
});

describe('toast', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="toast-wrap" id="toasts"></div>';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('appends a toast element to #toasts', () => {
    toast('hello');
    const wrap = document.getElementById('toasts');
    expect(wrap.children.length).toBe(1);
    expect(wrap.children[0].classList.contains('toast')).toBe(true);
  });
  it('renders the message inside .msg', () => {
    toast('hello world');
    const msg = document.querySelector('#toasts .msg');
    expect(msg.textContent).toBe('hello world');
  });
  it('escapes HTML in the message', () => {
    toast('<script>x</script>');
    const msg = document.querySelector('#toasts .msg');
    // textContent decodes entities, so we see the literal characters back.
    expect(msg.textContent).toBe('<script>x</script>');
    // But the raw HTML should NOT contain a real <script> element.
    expect(document.querySelector('#toasts script')).toBeNull();
  });
  it('adds the kind class on the toast element', () => {
    toast('ok msg', 'ok');
    const t = document.querySelector('#toasts .toast');
    expect(t.classList.contains('ok')).toBe(true);
  });
  it('renders a .lab block when a label is provided', () => {
    toast('msg', 'ok', 'Label!');
    const lab = document.querySelector('#toasts .lab');
    expect(lab).not.toBeNull();
    expect(lab.textContent).toBe('Label!');
  });
  it('omits the .lab block when no label is provided', () => {
    toast('msg', 'ok');
    expect(document.querySelector('#toasts .lab')).toBeNull();
  });
  it('auto-dismisses after ~2400ms + 320ms fade', () => {
    toast('bye');
    const wrap = document.getElementById('toasts');
    expect(wrap.children.length).toBe(1);
    vi.advanceTimersByTime(2400);
    // After the outer timeout, fade-out starts but element still in DOM.
    expect(wrap.children.length).toBe(1);
    vi.advanceTimersByTime(320);
    // Inner timeout removes the element.
    expect(wrap.children.length).toBe(0);
  });
});
