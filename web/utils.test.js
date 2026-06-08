import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { escapeHtml, uniqueName, uniqueIface, pad2, cssEscape, el, toast, isValidIpv4, isValidNetworkCidr, addressInCidr, isPrivateCidr } from './utils.js';

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

  it('keeps an error toast on screen longer than a default toast', () => {
    // Error toasts must be obvious — they linger past the point a default
    // toast would have been removed from the DOM so the user has time to
    // read them.
    toast('boom', 'error');
    const wrap = document.getElementById('toasts');
    expect(wrap.children.length).toBe(1);
    // 2400 + 320 == the default dismissal-and-fade window. An error toast
    // must still be in the DOM at this point.
    vi.advanceTimersByTime(2400 + 320);
    expect(wrap.children.length).toBe(1);
    // Advance well past the longer error window; toast is now gone.
    vi.advanceTimersByTime(5000 + 320);
    expect(wrap.children.length).toBe(0);
  });

  it('renders a countdown bar inside the toast', () => {
    toast('hello');
    const bar = document.querySelector('#toasts .toast-bar');
    expect(bar).not.toBeNull();
  });
  it('sets the countdown bar animation duration to the toast lifetime', () => {
    toast('hello');             // default kind → 2400ms
    const bar = document.querySelector('#toasts .toast-bar');
    expect(bar.style.animationDuration).toBe('2400ms');
  });
  it('uses the longer lifetime for the error countdown bar', () => {
    toast('boom', 'error');     // error → 5000ms
    const bar = document.querySelector('#toasts .toast-bar');
    expect(bar.style.animationDuration).toBe('5000ms');
  });
  it('renders a close button', () => {
    toast('hello');
    expect(document.querySelector('#toasts .toast-close')).not.toBeNull();
  });
  it('dismisses immediately when the close button is clicked', () => {
    toast('hello');
    const wrap = document.getElementById('toasts');
    document.querySelector('#toasts .toast-close').click();
    vi.advanceTimersByTime(320);   // only the fade window, not the 2400ms lifetime
    expect(wrap.children.length).toBe(0);
  });
  it('dismisses immediately when the toast body is clicked', () => {
    toast('hello');
    const wrap = document.getElementById('toasts');
    wrap.querySelector('.toast').click();
    vi.advanceTimersByTime(320);
    expect(wrap.children.length).toBe(0);
  });
  it('pauses auto-dismiss while the pointer is hovering', () => {
    toast('hover me');                       // 2400ms lifetime
    const wrap = document.getElementById('toasts');
    const t = wrap.querySelector('.toast');
    t.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(5000);            // well past the normal lifetime
    expect(wrap.children.length).toBe(1);    // still here — paused
    expect(t.classList.contains('paused')).toBe(true);
  });
  it('resumes auto-dismiss after the pointer leaves', () => {
    toast('hover me');
    const wrap = document.getElementById('toasts');
    const t = wrap.querySelector('.toast');
    t.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(5000);
    t.dispatchEvent(new Event('mouseleave'));
    expect(t.classList.contains('paused')).toBe(false);
    vi.advanceTimersByTime(2400 + 320);      // remaining lifetime + fade
    expect(wrap.children.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isValidIpv4
// ---------------------------------------------------------------------------
describe('isValidIpv4', () => {
  it('accepts a valid dotted-quad', () => {
    expect(isValidIpv4('192.168.0.1')).toBe(true);
  });
  it('accepts all-zeros address', () => {
    expect(isValidIpv4('0.0.0.0')).toBe(true);
  });
  it('accepts 255.255.255.255', () => {
    expect(isValidIpv4('255.255.255.255')).toBe(true);
  });
  it('rejects empty string', () => {
    expect(isValidIpv4('')).toBe(false);
  });
  it('rejects null', () => {
    expect(isValidIpv4(null)).toBe(false);
  });
  it('rejects an octet out of range (256)', () => {
    expect(isValidIpv4('256.0.0.0')).toBe(false);
  });
  it('rejects leading zeros in an octet', () => {
    expect(isValidIpv4('10.01.0.1')).toBe(false);
  });
  it('rejects too few octets', () => {
    expect(isValidIpv4('10.0.0')).toBe(false);
  });
  it('rejects too many octets', () => {
    expect(isValidIpv4('10.0.0.1.2')).toBe(false);
  });
  it('rejects non-numeric octets', () => {
    expect(isValidIpv4('10.0.0.x')).toBe(false);
  });
  it('rejects a CIDR string (has slash)', () => {
    expect(isValidIpv4('10.0.0.0/24')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidNetworkCidr
// ---------------------------------------------------------------------------
describe('isValidNetworkCidr — network CIDR (0–32)', () => {
  it('accepts a valid /24', () => {
    expect(isValidNetworkCidr('192.168.0.0/24').ok).toBe(true);
  });
  it('accepts /0 (any prefix)', () => {
    expect(isValidNetworkCidr('0.0.0.0/0').ok).toBe(true);
  });
  it('accepts /32 (host route)', () => {
    expect(isValidNetworkCidr('10.0.0.1/32').ok).toBe(true);
  });
  it('returns ok:true for empty string', () => {
    expect(isValidNetworkCidr('').ok).toBe(true);
  });
  it('rejects string without slash', () => {
    const r = isValidNetworkCidr('192.168.0.0');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('malformed CIDR');
  });
  it('rejects host-bits-set address', () => {
    const r = isValidNetworkCidr('10.0.0.5/30');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not a network address');
    expect(r.reason).toContain('10.0.0.4/30');
  });
  it('rejects prefix > 32', () => {
    expect(isValidNetworkCidr('10.0.0.0/33').ok).toBe(false);
  });
  it('rejects malformed IP part', () => {
    expect(isValidNetworkCidr('999.0.0.0/24').ok).toBe(false);
  });
});

describe('isValidNetworkCidr — link CIDR (/30 or /31)', () => {
  const opts = { allowMaskMin: 30, allowMaskMax: 31 };

  it('accepts a valid /30', () => {
    expect(isValidNetworkCidr('10.0.0.0/30', opts).ok).toBe(true);
  });
  it('accepts a valid /31', () => {
    expect(isValidNetworkCidr('10.0.0.4/31', opts).ok).toBe(true);
  });
  it('rejects /29 with specific message', () => {
    const r = isValidNetworkCidr('10.0.0.0/29', opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('CIDR must be /30 or /31');
  });
  it('rejects /32 with specific message', () => {
    const r = isValidNetworkCidr('10.0.0.0/32', opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('CIDR must be /30 or /31');
  });
  it('rejects host-bits-set for /30', () => {
    const r = isValidNetworkCidr('10.0.0.1/30', opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not a network address');
  });
  it('returns ok:true for empty string', () => {
    expect(isValidNetworkCidr('', opts).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addressInCidr
// ---------------------------------------------------------------------------
describe('addressInCidr', () => {
  it('returns true when address is within the CIDR', () => {
    expect(addressInCidr('10.0.0.1', '10.0.0.0/30')).toBe(true);
  });
  it('returns false when address is outside the CIDR', () => {
    expect(addressInCidr('10.0.0.5', '10.0.0.0/30')).toBe(false);
  });
  it('returns true (bail) when address is empty', () => {
    expect(addressInCidr('', '10.0.0.0/30')).toBe(true);
  });
  it('returns true (bail) when cidr is empty', () => {
    expect(addressInCidr('10.0.0.1', '')).toBe(true);
  });
  it('returns true (bail) when address is malformed', () => {
    expect(addressInCidr('bad', '10.0.0.0/30')).toBe(true);
  });
  it('returns true (bail) when cidr is malformed', () => {
    expect(addressInCidr('10.0.0.1', 'bad')).toBe(true);
  });
  it('handles /31 correctly', () => {
    expect(addressInCidr('10.0.0.2', '10.0.0.2/31')).toBe(true);
    expect(addressInCidr('10.0.0.4', '10.0.0.2/31')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateCidr — RFC1918 detection (mirrors entities.Address.is_private)
// ---------------------------------------------------------------------------
describe('isPrivateCidr', () => {
  it('recognizes a CIDR fully inside 10.0.0.0/8', () => {
    expect(isPrivateCidr('10.0.0.0/24')).toBe(true);
    expect(isPrivateCidr('10.255.255.0/30')).toBe(true);
  });
  it('recognizes a CIDR fully inside 172.16.0.0/12', () => {
    expect(isPrivateCidr('172.16.5.0/24')).toBe(true);
    expect(isPrivateCidr('172.31.0.0/16')).toBe(true);
  });
  it('recognizes a CIDR fully inside 192.168.0.0/16', () => {
    expect(isPrivateCidr('192.168.1.0/24')).toBe(true);
    expect(isPrivateCidr('192.168.99.0/30')).toBe(true);
  });
  it('rejects public CIDRs that look adjacent to a private range', () => {
    // 172.32.x.x is just past the 172.16.0.0/12 ceiling.
    expect(isPrivateCidr('172.32.0.0/24')).toBe(false);
    // 192.169.x.x is just past 192.168/16.
    expect(isPrivateCidr('192.169.0.0/24')).toBe(false);
    // 9.x.x.x is just below 10/8.
    expect(isPrivateCidr('9.255.255.0/24')).toBe(false);
  });
  it('rejects fully public CIDRs', () => {
    expect(isPrivateCidr('200.100.0.0/24')).toBe(false);
    expect(isPrivateCidr('8.8.8.0/24')).toBe(false);
    expect(isPrivateCidr('198.51.100.0/30')).toBe(false);
  });
  it('rejects a CIDR that only partially overlaps a private range', () => {
    // Wider-than-private prefix: not "fully private".
    expect(isPrivateCidr('10.0.0.0/4')).toBe(false);
  });
  it('returns false for invalid input', () => {
    expect(isPrivateCidr('')).toBe(false);
    expect(isPrivateCidr('not-a-cidr')).toBe(false);
    expect(isPrivateCidr('10.0.0.0')).toBe(false);   // missing mask
    expect(isPrivateCidr(null)).toBe(false);
    expect(isPrivateCidr(undefined)).toBe(false);
  });
});
