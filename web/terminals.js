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

  // ---- ping output pacing ----
  // The backend resolves a whole `ping -c` in a sub-millisecond burst, so its
  // per-probe result events arrive far faster than the staged packet animation.
  // To make each line appear "when the response arrives", we buffer a device's
  // lines and flush them in seq order: a successful line waits for its reply
  // packet to animate back to the host; a timeout line is ready at once (there
  // is no reply to animate, and the backend already waited out the timeout).
  _pingBuf: new Map(),                  // device -> { next, lines: Map<seq,{text,ready,timer}> }
  _replySeq: new Map(),                 // ping_reply payload_id -> seq
  _pingArrived: new Set(),              // `${device}|${seq}` arrivals seen before the result line
  _pingFallbackMs: 6000,                // show a success line even if its arrival never fires

  // Append every contiguous ready line from the head of a device's buffer.
  _pingFlush(device) {
    const buf = this._pingBuf.get(device);
    if (!buf) return;
    const w = this._active.get(device);
    if (!w) { this._pingBuf.delete(device); return; }   // terminal closed — drop
    const out = w.querySelector('.term-out');
    if (!out) return;
    if (buf.next == null) {
      if (buf.lines.size === 0) return;
      buf.next = Math.min(...buf.lines.keys());
    }
    while (buf.lines.has(buf.next) && buf.lines.get(buf.next).ready) {
      const entry = buf.lines.get(buf.next);
      if (entry.timer) clearTimeout(entry.timer);
      out.textContent += entry.text;
      out.scrollTop = out.scrollHeight;
      buf.lines.delete(buf.next);
      buf.next++;
    }
    if (buf.lines.size === 0) buf.next = null;   // re-seed from the next burst
  },

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
    document.body.appendChild(w);
    // Clamp the restored position to the viewport: a window dragged off-screen
    // in an earlier session (or before clamping existed) must reopen on screen,
    // not out of reach. Measured after append so offsetWidth/Height are known;
    // persist the corrected value so the stale entry is healed.
    const headerH = w.querySelector('.term-header')?.offsetHeight || 28;
    const clamped = clampTermPos(
      pos.x, pos.y, w.offsetWidth, w.offsetHeight,
      window.innerWidth, window.innerHeight, headerH,
    );
    w.style.left = clamped.x + 'px';
    w.style.top = clamped.y + 'px';
    localStorage.setItem('term.pos.' + deviceName, JSON.stringify(clamped));
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
bus.addEventListener('sim:status-changed', () => {
  Terminals._applySimState(Sim.state);
  if (Sim.state === 'idle') {
    // Drop any paced lines still waiting on an animation that will never finish.
    for (const buf of Terminals._pingBuf.values()) {
      for (const entry of buf.lines.values()) if (entry.timer) clearTimeout(entry.timer);
    }
    Terminals._pingBuf.clear();
    Terminals._replySeq.clear();
    Terminals._pingArrived.clear();
  }
});
bus.addEventListener('canvas:terminal-requested', (e) => { Terminals.open(e.detail.name); });

// Learn each ping reply's seq from its packet emission so we can match the
// reply's visual arrival (below) back to the buffered terminal line.
bus.addEventListener('sim:packet', (e) => {
  const evt = e.detail;
  if (evt && evt.type === 'ping_reply' && evt.payload_id != null &&
      evt.payload && evt.payload.seq != null) {
    Terminals._replySeq.set(evt.payload_id, evt.payload.seq);
  }
});

// A ping reply finished animating: if it arrived at the pinging host, release
// that host's buffered line for this seq. (Intermediate router hops don't match
// a buffered line, which is only keyed under the pinging host.)
bus.addEventListener('sim:packet-arrived', (e) => {
  const { payloadId, device } = e.detail || {};
  if (payloadId == null || !device || !Terminals._replySeq.has(payloadId)) return;
  const seq = Terminals._replySeq.get(payloadId);
  const buf = Terminals._pingBuf.get(device);
  const entry = buf && buf.lines.get(seq);
  if (entry) { entry.ready = true; Terminals._pingFlush(device); }
  else { Terminals._pingArrived.add(`${device}|${seq}`); }   // result line not buffered yet
});

bus.addEventListener('sim:ping-result', (e) => {
  const { device, dst, seq, rtt_ms } = e.detail;
  if (!Terminals._active.has(device)) return;  // sender's terminal not open
  const text = rtt_ms == null
    ? `seq=${seq} ${dst}: timeout\n`
    : `seq=${seq} ${dst}: time=${rtt_ms.toFixed(2)} ms\n`;
  let buf = Terminals._pingBuf.get(device);
  if (!buf) { buf = { next: null, lines: new Map() }; Terminals._pingBuf.set(device, buf); }
  // A timeout has no reply to animate (ready now); a success waits for its reply
  // to arrive — unless that arrival already fired before this line was known.
  const ready = rtt_ms == null || Terminals._pingArrived.delete(`${device}|${seq}`);
  const entry = { text, ready, timer: null };
  if (!ready) {
    entry.timer = setTimeout(() => { entry.ready = true; Terminals._pingFlush(device); },
                             Terminals._pingFallbackMs);
  }
  buf.lines.set(seq, entry);
  Terminals._pingFlush(device);
});
