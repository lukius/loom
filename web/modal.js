// web/modal.js
//
// Small, reusable confirmation dialog for the loom SPA. Built from the shared
// `.modal-bg` / `.modal` / `.modal-head` / `.modal-body` / `.modal-foot`
// classes (the same envelope file-picker.js uses) so it inherits theme,
// blur backdrop, and entrance animation for free.
//
// confirmModal() returns a Promise that resolves to a boolean: true when the
// user confirms, false when they cancel, dismiss, click the backdrop, or hit
// Escape. The dialog removes itself once settled.

import { escapeHtml } from './utils.js';

/** Show a confirmation dialog and resolve true (confirm) / false (cancel).
 *  Options: { title, body, confirmLabel, cancelLabel, danger }. When `danger`
 *  is set the confirm button uses the destructive style. */
export function confirmModal({
  title = 'Confirm',
  body = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.innerHTML = `
      <div class="modal modal-confirm" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-head">
          <div class="ttl">${escapeHtml(title)}</div>
          <button class="x" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="modal-body"><p class="modal-msg">${escapeHtml(body)}</p></div>
        <div class="modal-foot">
          <button class="btn outline cancel" type="button">${escapeHtml(cancelLabel)}</button>
          <button class="btn ${danger ? 'danger' : 'primary'} confirm" type="button">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;

    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };

    wrap.querySelector('.x').addEventListener('click', () => done(false));
    wrap.querySelector('.cancel').addEventListener('click', () => done(false));
    wrap.querySelector('.confirm').addEventListener('click', () => done(true));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(wrap);
    wrap.querySelector('.confirm').focus();
  });
}
