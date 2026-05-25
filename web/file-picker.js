// web/file-picker.js
//
// Import/Export file selection UI.
//   * openImportPicker() opens a modal listing *.yaml files from the server's
//     samples/ directory (via GET /samples) plus a "Browse local file…" button
//     that reads any YAML from disk via the native file input.
//   * runExportSave() calls window.showSaveFilePicker() so the user picks the
//     destination folder + filename through the browser's native save dialog,
//     then writes the YAML text into the chosen file.
//
// No state mutation here: callers receive the loaded YAML text + source
// filename and decide what to do with them (typically: feed to importYaml()
// and update state.sourceName).

import { escapeHtml, toast } from './utils.js';

/* ---------- import modal ------------------------------------------------- */

/** Build, mount, and return the import-picker modal element. The caller is
 *  responsible for nothing — the modal removes itself when dismissed or when
 *  a file is selected. */
export function openImportPicker({ onLoad }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-bg';
  wrap.innerHTML = `
    <div class="modal modal-picker" role="dialog" aria-modal="true" aria-label="Import topology">
      <div class="modal-head">
        <div class="ttl">Import topology</div>
        <button class="x" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="picker-section">
          <div class="picker-label">From samples/</div>
          <ul class="picker-list" id="picker-samples"><li class="picker-empty">Loading…</li></ul>
        </div>
        <div class="picker-section">
          <div class="picker-label">From your computer</div>
          <button class="btn outline picker-browse" type="button">Browse local file…</button>
          <input type="file" accept=".yaml,.yml,application/x-yaml,text/yaml" hidden />
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn outline cancel" type="button">Cancel</button>
      </div>
    </div>
  `;
  const close = () => wrap.remove();
  wrap.querySelector('.x').addEventListener('click', close);
  wrap.querySelector('.cancel').addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  const list = wrap.querySelector('#picker-samples');
  fetchSamples().then(files => {
    if (!files.length) {
      list.innerHTML = '<li class="picker-empty">No samples available</li>';
      return;
    }
    list.innerHTML = '';
    for (const name of files) {
      const li = document.createElement('li');
      li.innerHTML = `<button class="picker-item" type="button">${escapeHtml(name)}</button>`;
      li.querySelector('button').addEventListener('click', async () => {
        try {
          const text = await fetchSample(name);
          close();
          onLoad(text, name);
        } catch (err) {
          toast(err.message || 'Failed to load sample', 'error', 'Import');
        }
      });
      list.appendChild(li);
    }
  }).catch(err => {
    list.innerHTML = `<li class="picker-empty">${escapeHtml(err.message || 'Failed to list samples')}</li>`;
  });

  const fileInput = wrap.querySelector('input[type=file]');
  wrap.querySelector('.picker-browse').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      close();
      onLoad(String(reader.result || ''), file.name);
    };
    reader.onerror = () => toast('Failed to read file', 'error', 'Import');
    reader.readAsText(file);
  });

  document.body.appendChild(wrap);
}

async function fetchSamples() {
  const r = await fetch('/samples');
  if (!r.ok) throw new Error(`/samples: HTTP ${r.status}`);
  const body = await r.json();
  return Array.isArray(body.files) ? body.files : [];
}

async function fetchSample(name) {
  const r = await fetch(`/samples/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`/samples/${name}: HTTP ${r.status}`);
  const body = await r.json();
  return body.yaml || '';
}

/* ---------- export save -------------------------------------------------- */

/** Save `text` to disk through the browser's native save-file dialog. The
 *  dialog suggests `defaultName`; the user picks the folder + final filename.
 *  Requires the File System Access API (Chromium-based browsers). */
export async function runExportSave({ text, defaultName }) {
  if (typeof window.showSaveFilePicker !== 'function') {
    toast(
      'Export requires a Chromium-based browser (Chrome, Edge, Brave, Opera). Use a recent version.',
      'error', 'Export',
    );
    return false;
  }
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: defaultName,
      types: [{
        description: 'YAML topology',
        accept: { 'application/x-yaml': ['.yaml', '.yml'] },
      }],
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return false;
    toast(err.message || 'Save cancelled', 'error', 'Export');
    return false;
  }
  try {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  } catch (err) {
    toast(err.message || 'Write failed', 'error', 'Export');
    return false;
  }
  toast(`Saved ${handle.name}`, 'ok', 'Export');
  return true;
}

/** Fetch the basename of the server's LOOM_TOPOLOGY source. Used to seed
 *  state.sourceName on first boot, before the user has imported anything. */
export async function fetchSourceName() {
  try {
    const r = await fetch('/topology/source');
    if (!r.ok) return null;
    const body = await r.json();
    return typeof body.name === 'string' && body.name ? body.name : null;
  } catch (_) {
    return null;
  }
}
