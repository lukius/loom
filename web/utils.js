const SVG_NS = 'http://www.w3.org/2000/svg';

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
  setTimeout(() => {
    elT.style.transition = 'opacity .3s, transform .3s';
    elT.style.opacity = 0;
    elT.style.transform = 'translateY(6px)';
    setTimeout(() => elT.remove(), 320);
  }, 2400);
}
