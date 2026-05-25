const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// IPv4 / CIDR validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `s` is a syntactically valid dotted-quad IPv4 address
 * (each octet 0–255, no leading zeros, no extra tokens).
 * Empty string returns false — callers handle "empty is OK" themselves.
 */
export function isValidIpv4(s) {
  if (!s || typeof s !== 'string') return false;
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    if (p === '' || p.length > 3) return false;
    if (p.length > 1 && p[0] === '0') return false; // no leading zeros
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/**
 * Validates a CIDR string `a.b.c.d/N`.
 *
 * Options:
 *   allowMaskMin  (default 0)  — minimum prefix length
 *   allowMaskMax  (default 32) — maximum prefix length
 *
 * Returns `{ ok: true }` when valid (or when `s` is empty / whitespace-only).
 * Returns `{ ok: false, reason: '<message>' }` when invalid.
 *
 * Error messages (most-specific first):
 *  - "CIDR must be /30 or /31"           — when allowMaskMin===30
 *  - "not a network address: should be …" — host bits set
 *  - "malformed CIDR"                     — anything else wrong
 */
export function isValidNetworkCidr(s, { allowMaskMin = 0, allowMaskMax = 32 } = {}) {
  if (!s || !s.trim()) return { ok: true };

  const slash = s.lastIndexOf('/');
  if (slash === -1) return { ok: false, reason: 'malformed CIDR' };

  const addrPart = s.slice(0, slash);
  const maskPart = s.slice(slash + 1);

  if (!isValidIpv4(addrPart)) return { ok: false, reason: 'malformed CIDR' };

  const prefix = Number(maskPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32 || String(prefix) !== maskPart) {
    return { ok: false, reason: 'malformed CIDR' };
  }

  if (prefix < allowMaskMin || prefix > allowMaskMax) {
    if (allowMaskMin === 30 && allowMaskMax === 31) {
      return { ok: false, reason: 'CIDR must be /30 or /31' };
    }
    return { ok: false, reason: 'malformed CIDR' };
  }

  // Check that the address is the canonical network address (no host bits set).
  const octets = addrPart.split('.').map(Number);
  const ipInt = (octets[0] << 24 | octets[1] << 16 | octets[2] << 8 | octets[3]) >>> 0;
  const maskInt = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const networkInt = (ipInt & maskInt) >>> 0;

  if (ipInt !== networkInt) {
    // Compute what the canonical address should be
    const b0 = (networkInt >>> 24) & 0xff;
    const b1 = (networkInt >>> 16) & 0xff;
    const b2 = (networkInt >>>  8) & 0xff;
    const b3 =  networkInt         & 0xff;
    return { ok: false, reason: `not a network address: should be ${b0}.${b1}.${b2}.${b3}/${prefix}` };
  }

  return { ok: true };
}

/**
 * Returns true when `addr` falls within the given `cidr`.
 * Bails out (returns true) when either argument is empty or malformed,
 * since format errors are already surfaced by the other validators.
 */
export function addressInCidr(addr, cidr) {
  if (!addr || !cidr) return true;
  const slash = cidr.lastIndexOf('/');
  if (slash === -1) return true;
  const addrPart = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (!isValidIpv4(addr) || !isValidIpv4(addrPart) || !Number.isInteger(prefix)) return true;

  const toInt = (a) => {
    const p = a.split('.').map(Number);
    return (p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]) >>> 0;
  };
  const maskInt = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return ((toInt(addr) & maskInt) >>> 0) === ((toInt(addrPart) & maskInt) >>> 0);
}

// RFC1918 ranges. A CIDR is "private" iff *every* address it covers falls
// inside one of these blocks — i.e. the CIDR's network range is wholly
// contained in the private block (matches src/entities/address.is_private).
const _PRIVATE_BLOCKS = [
  { addr: '10.0.0.0',    mask: 8 },
  { addr: '172.16.0.0',  mask: 12 },
  { addr: '192.168.0.0', mask: 16 },
];

function _toInt(ip) {
  const p = ip.split('.').map(Number);
  return (p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]) >>> 0;
}

export function isPrivateCidr(cidr) {
  if (typeof cidr !== 'string' || !cidr) return false;
  const slash = cidr.lastIndexOf('/');
  if (slash === -1) return false;
  const addr = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (!isValidIpv4(addr) || !Number.isInteger(prefix)) return false;
  if (prefix < 0 || prefix > 32) return false;

  const net = _toInt(addr);
  for (const blk of _PRIVATE_BLOCKS) {
    if (prefix < blk.mask) continue;  // wider than the block — not fully private
    const blkMask = blk.mask === 0 ? 0 : (~0 << (32 - blk.mask)) >>> 0;
    if ((net & blkMask) >>> 0 === (_toInt(blk.addr) & blkMask) >>> 0) {
      return true;
    }
  }
  return false;
}

export function el(tag, attrs = {}, kids = null) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') e.setAttribute('class', v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  if (kids) {
    if (Array.isArray(kids)) kids.forEach(c => c && e.appendChild(c));
    else if (typeof kids === 'string') e.textContent = kids;
    else e.appendChild(kids);
  }
  return e;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

export function uniqueName(prefix, dict) { let n = 1; while (dict[`${prefix}${n}`]) n++; return `${prefix}${n}`; }

export function uniqueIface(ifaces) { let n = 0; while (ifaces[`eth${n}`]) n++; return `eth${n}`; }

export function pad2(n) { return String(n).padStart(2, '0'); }

export function cssEscape(s) {
  return CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '');
}

export function toast(msg, kind = '', label = null) {
  const wrap = document.getElementById('toasts');
  const elT = document.createElement('div');
  elT.className = `toast ${kind}`;
  const iconSvg = kind === 'ok'
    ? `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 6.5l2.5 2.5 4.5-5"/></svg>`
    : kind === 'error'
      ? `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l6 6M9 3l-6 6"/></svg>`
      : `<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="0.7" fill="currentColor"/></svg>`;
  elT.innerHTML = `
    <div class="icon">${iconSvg}</div>
    <div class="body">
      ${label ? `<div class="lab">${escapeHtml(label)}</div>` : ''}
      <div class="msg">${escapeHtml(msg)}</div>
    </div>
  `;
  wrap.appendChild(elT);
  // Errors linger so the user actually sees them; other kinds dismiss fast.
  const lifetime = kind === 'error' ? 5000 : 2400;
  setTimeout(() => {
    elT.style.transition = 'opacity .3s, transform .3s';
    elT.style.opacity = 0;
    elT.style.transform = 'translateY(6px)';
    setTimeout(() => elT.remove(), 320);
  }, lifetime);
}
