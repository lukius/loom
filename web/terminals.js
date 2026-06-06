// web/terminals.js
// Floating device terminals: per-device cmd.Cmd-style REPL windows that send
// commands through RuntimeClient. Listens on the shared bus for sim state
// (to disable input while paused) and open requests from the canvas.
import { bus } from './state.js';
import { escapeHtml, toast } from './utils.js';
import { Sim, RuntimeClient } from './sim.js';

// Keep a dragged terminal within the viewport. The header (height `headerH`)
// must never slide above the top of the page (y >= 0) — once it does the user
// loses the only grab handle — and the bottom of the header must stay on
// screen too. A sliver is also kept visible on the left/right edges.
const TERM_MIN_VISIBLE = 60;
export function clampTermPos(x, y, w, h, vw, vh, headerH = 28) {
  const minX = TERM_MIN_VISIBLE - w;
  const maxX = Math.max(minX, vw - TERM_MIN_VISIBLE);
  const maxY = Math.max(0, vh - headerH);
  return {
    x: Math.min(maxX, Math.max(minX, x)),
    y: Math.min(maxY, Math.max(0, y)),
  };
}

/* ---------- Terminals ---------- */
export const Terminals = {
  _active: new Map(),                   // name -> element

  open(deviceName) {
    if (Sim && Sim.state === 'idle') {
      toast('Start the simulation to use device terminals', 'info');
      return;
    }
    if (this._active.has(deviceName)) {
      const el = this._active.get(deviceName);
      el.style.display = 'flex';
      this._applySimState(Sim.state);
      el.querySelector('.term-in').focus();
      return;
    }
    const tmpl = `
      <div class="term-header">
        <div class="traffic">
          <span class="light close" title="Close"></span>
          <span class="light min" title=""></span>
          <span class="light max" title=""></span>
        </div>
        <div class="title">${escapeHtml(deviceName)}@loom</div>
        <div class="paused-chip" hidden>(paused)</div>
      </div>
      <pre class="term-out">loom v1.0 — ${escapeHtml(deviceName)}
type 'help' for commands

</pre>
      <div class="term-line">
        <span class="term-prompt">${escapeHtml(deviceName)}@loom:~$</span>
        <textarea class="term-in" rows="1" autocomplete="off" spellcheck="false"></textarea>
        <span class="term-cursor"></span>
      </div>`;
    const w = document.createElement('div');
    w.className = 'term';
    w.innerHTML = tmpl;
    const pos = JSON.parse(localStorage.getItem('term.pos.' + deviceName) || 'null') || { x: 120 + this._active.size * 20, y: 120 + this._active.size * 20 };
    w.style.left = pos.x + 'px';
    w.style.top = pos.y + 'px';
    document.body.appendChild(w);
    this._active.set(deviceName, w);
    this._wire(w, deviceName);
    this._applySimState(Sim.state);
    w.querySelector('.term-in').focus();
  },

  _applySimState(simState) {
    const paused = simState === 'paused';
    for (const w of this._active.values()) {
      const input = w.querySelector('.term-in');
      const chip = w.querySelector('.paused-chip');
      const cursor = w.querySelector('.term-cursor');
      if (input) input.disabled = paused;
      if (chip) chip.hidden = !paused;
      if (cursor) cursor.style.display = paused ? 'none' : '';
    }
  },

  _wire(w, name) {
    const out = w.querySelector('.term-out');
    const inp = w.querySelector('.term-in');
    const close = w.querySelector('.light.close');
    const history = JSON.parse(sessionStorage.getItem('term.hist.' + name) || '[]');
    let histIdx = history.length;

    const closeTerm = () => {
      w.remove();
      this._active.delete(name);
    };
    close.addEventListener('click', closeTerm);

    // Click anywhere on the term window refocuses the input — recovers from accidental blur.
    w.addEventListener('mousedown', (e) => {
      if (e.target.closest('.light.close')) return;
      if (e.target === inp) return;
      if (!inp.disabled) setTimeout(() => inp.focus(), 0);
    });

    // Drag
    const hdr = w.querySelector('.term-header');
    let drag = null;
    hdr.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX - w.offsetLeft, y: e.clientY - w.offsetTop };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const { x, y } = clampTermPos(
        e.clientX - drag.x, e.clientY - drag.y,
        w.offsetWidth, w.offsetHeight,
        window.innerWidth, window.innerHeight,
        hdr.offsetHeight,
      );
      w.style.left = x + 'px';
      w.style.top = y + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (drag) localStorage.setItem('term.pos.' + name, JSON.stringify({ x: w.offsetLeft, y: w.offsetTop }));
      drag = null;
    });

    const autoResize = () => {
      inp.style.height = 'auto';
      inp.style.height = inp.scrollHeight + 'px';
    };
    inp.addEventListener('input', autoResize);
    autoResize();

    inp.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) {
        if (inp.value === '') {
          e.preventDefault();
          closeTerm();
          return;
        }
      }
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        out.textContent = '';
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = inp.value;
        out.textContent += `${name}@loom:~$ ${cmd}\n`;
        inp.value = '';
        autoResize();
        if (cmd.trim() === 'clear') {
          out.textContent = '';
        } else if (cmd.trim() !== '') {
          try {
            const r = await RuntimeClient.deviceCommand(name, cmd);
            const txt = r.output || '(no output)';
            out.textContent += txt + (txt.endsWith('\n') ? '' : '\n');
            if (cmd.trim() === 'help') {
              out.textContent += 'terminal: clear, Ctrl+L (clear), Ctrl+D (close)\n';
            }
          } catch (err) {
            out.textContent += `[error] ${err.message}\n`;
          }
        }
        out.scrollTop = out.scrollHeight;
        if (cmd.trim()) {
          history.push(cmd);
          histIdx = history.length;
          sessionStorage.setItem('term.hist.' + name, JSON.stringify(history.slice(-200)));
        }
      } else if (e.key === 'ArrowUp') {
        if (histIdx > 0) {
          histIdx--;
          inp.value = history[histIdx] || '';
        }
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (histIdx < history.length - 1) {
          histIdx++;
          inp.value = history[histIdx] || '';
        } else {
          inp.value = '';
          histIdx = history.length;
        }
        e.preventDefault();
      }
    });
  },
};

/* ---------- bus listeners ---------- */
bus.addEventListener('sim:status-changed', () => Terminals._applySimState(Sim.state));
bus.addEventListener('canvas:terminal-requested', (e) => { Terminals.open(e.detail.name); });
bus.addEventListener('sim:ping-result', (e) => {
  const { device, dst, seq, rtt_ms } = e.detail;
  const w = Terminals._active.get(device);
  if (!w) return;  // sender's terminal not open — nothing to stream into
  const out = w.querySelector('.term-out');
  if (!out) return;
  const line = rtt_ms == null
    ? `seq=${seq} ${dst}: timeout\n`
    : `seq=${seq} ${dst}: time=${rtt_ms.toFixed(2)} ms\n`;
  out.textContent += line;
  out.scrollTop = out.scrollHeight;
});
