// web/terminals.js
// Floating device terminals: per-node command terminal windows that send
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
  // The summary (the command's response) is held as a trailer and printed only
  // after every probe line has flushed. Release is driven purely by the reply's
  // visual arrival — which always fires — so there is no timer racing the
  // (arbitrarily long, -i-spaced) animation.
  _pingBuf: new Map(),     // device -> { next, flushed, lines: Map<seq,{text,ready}>, trailer, trailerCount }
  _replySeq: new Map(),    // ping_reply payload_id -> seq
  _pingArrived: new Set(), // `${device}|${seq}` arrivals seen before the result line
  _seqDevice: new Map(),   // seq -> device, so a device-less arrival can still be routed

  _pingBufFor(device) {
    let buf = this._pingBuf.get(device);
    if (!buf) {
      buf = { next: null, flushed: 0, lines: new Map(), trailer: null, trailerCount: 0 };
      this._pingBuf.set(device, buf);
    }
    return buf;
  },

  // Append every contiguous ready line from the head of a device's buffer, then
  // print the summary trailer once all of this ping's probe lines have shown.
  _pingFlush(device) {
    const buf = this._pingBuf.get(device);
    if (!buf) return;
    const w = this._active.get(device);
    if (!w) { this._pingBuf.delete(device); return; }   // terminal closed — drop
    const out = w.querySelector('.term-out');
    if (!out) return;
    if (buf.next == null && buf.lines.size > 0) {
      buf.next = Math.min(...buf.lines.keys());
    }
    while (buf.next != null && buf.lines.has(buf.next) && buf.lines.get(buf.next).ready) {
      out.textContent += buf.lines.get(buf.next).text;
      out.scrollTop = out.scrollHeight;
      buf.lines.delete(buf.next);
      buf.next++;
      buf.flushed++;
    }
    // Summary waits until every probe line for this ping has been printed.
    if (buf.trailer != null && buf.flushed >= buf.trailerCount) {
      out.textContent += buf.trailer;
      out.scrollTop = out.scrollHeight;
      buf.trailer = null;
      buf.trailerCount = 0;
      buf.flushed = 0;
      if (buf.lines.size === 0) buf.next = null;
    } else if (buf.lines.size === 0) {
      buf.next = null;   // re-seed from the next burst
    }
  },

  // If `output` is a ping summary, hold it until the paced per-probe lines have
  // all printed; returns true when deferred (caller must not print it).
  _maybeDeferPingSummary(device, cmd, output) {
    if (cmd.trim().split(/\s+/)[0] !== 'ping') return false;
    const m = /(\d+)\s+sent\b/.exec(output);
    if (!m) return false;   // an error/syntax response, not a real summary
    const buf = this._pingBufFor(device);
    buf.trailer = output.endsWith('\n') ? output : output + '\n';
    buf.trailerCount = parseInt(m[1], 10);
    this._pingFlush(device);
    return true;
  },

  // ---- SPA-driven multi-probe ping ----
  // The on-canvas animation is far slower than the backend simulation, so a
  // backend `ping -c N` sends every probe (on the old route) long before the
  // user reacts to what they see. To make a live topology edit actually reroute
  // later probes, the web terminal drives the cadence itself: it sends probes
  // one at a time, waits for each probe's round trip to finish animating, then
  // waits the -i interval (the edit window) before sending the next.
  _pingInProgress: new Set(),

  // Parse a `ping <dst> [-W w] [-c n] [-i s]` line; null if it isn't a ping.
  _parsePing(cmd) {
    const parts = cmd.trim().split(/\s+/);
    if (parts[0] !== 'ping') return null;
    let dst = null, count = 1, interval = 1, timeout = 3;
    const rest = parts.slice(1);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-c') count = parseInt(rest[++i], 10);
      else if (rest[i] === '-i') interval = parseFloat(rest[++i]);
      else if (rest[i] === '-W') timeout = parseFloat(rest[++i]);
      else if (dst == null) dst = rest[i];
    }
    if (dst == null || !Number.isFinite(count) || count < 1) return null;
    if (!Number.isFinite(interval) || interval < 0) interval = 1;
    if (!Number.isFinite(timeout) || timeout <= 0) timeout = 3;
    return { dst, count, interval, timeout };
  },

  // Run a multi-probe ping as a sequence of single-probe backend pings, paced to
  // the animation. Per-probe lines stream via the usual pacing; the aggregate
  // summary is printed once every probe has been shown.
  async _runPacedPing(name, parsed, out) {
    if (this._pingInProgress.has(name)) return;
    this._pingInProgress.add(name);
    const { dst, count, interval, timeout } = parsed;
    let received = 0;
    try {
      for (let k = 0; k < count; k++) {
        if (Sim.state === 'idle') break;   // sim stopped mid-ping
        let r;
        try {
          r = await RuntimeClient.deviceCommand(name, `ping ${dst} -c 1 -W ${timeout}`);
        } catch (err) {
          out.textContent += `[error] ${err.message}\n`;
          out.scrollTop = out.scrollHeight;
          return;
        }
        if (!r || !r.ok) {
          const msg = (r && r.output) || 'ping failed';
          out.textContent += msg.endsWith('\n') ? msg : msg + '\n';
          out.scrollTop = out.scrollHeight;
          return;
        }
        const m = /(\d+)\s+received/.exec(r.output || '');
        if (m && parseInt(m[1], 10) > 0) {
          received++;
          // Wait for this probe's reply to finish animating before the next one,
          // so the edit window below lines up with the next probe's send.
          await this._waitForReplyAnimation(name, (timeout + 30) * 1000);
        }
        if (k < count - 1) await new Promise((res) => setTimeout(res, interval * 1000));
      }
      const loss = Math.round(100 * (count - received) / count);
      out.textContent += `--- ${dst} ping statistics ---\n${count} sent, ${received} received, ${loss}% loss\n`;
      out.scrollTop = out.scrollHeight;
    } finally {
      this._pingInProgress.delete(name);
    }
  },

  // Resolve once a ping reply has finished animating back to `device` (or after
  // a safety cap, so a lost reply can't hang the loop).
  _waitForReplyAnimation(device, capMs) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        bus.removeEventListener('sim:packet-arrived', onArrival);
        clearTimeout(timer);
        resolve();
      };
      const onArrival = (e) => {
        const d = e.detail || {};
        if (d.device === device && d.payloadId != null && this._replySeq.has(d.payloadId)) finish();
      };
      bus.addEventListener('sim:packet-arrived', onArrival);
      timer = setTimeout(finish, capMs);
    });
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
          const parsedPing = Terminals._parsePing(cmd);
          if (parsedPing && parsedPing.count > 1) {
            // Multi-probe ping: paced by the SPA so edits reroute later probes.
            await Terminals._runPacedPing(name, parsedPing, out);
          } else {
            try {
              const r = await RuntimeClient.deviceCommand(name, cmd);
              const txt = r.output || '(no output)';
              // A ping summary is held until its paced per-probe lines finish;
              // any other command's output prints immediately.
              if (!Terminals._maybeDeferPingSummary(name, cmd, txt)) {
                out.textContent += txt + (txt.endsWith('\n') ? '' : '\n');
              }
              if (cmd.trim() === 'help') {
                out.textContent += 'terminal: clear, Ctrl+L (clear), Ctrl+D (close)\n';
              }
            } catch (err) {
              out.textContent += `[error] ${err.message}\n`;
            }
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
    Terminals._pingBuf.clear();
    Terminals._replySeq.clear();
    Terminals._pingArrived.clear();
    Terminals._seqDevice.clear();
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
  if (payloadId == null || !Terminals._replySeq.has(payloadId)) return;
  const seq = Terminals._replySeq.get(payloadId);
  // Prefer the arrival's device; fall back to the device that buffered this seq
  // so a geometry-less (device:null) arrival still releases the line.
  const target = device || Terminals._seqDevice.get(seq);
  const buf = target && Terminals._pingBuf.get(target);
  const entry = buf && buf.lines.get(seq);
  if (entry) { entry.ready = true; Terminals._pingFlush(target); }
  else if (target) { Terminals._pingArrived.add(`${target}|${seq}`); }   // line not buffered yet
});

bus.addEventListener('sim:ping-result', (e) => {
  const { device, dst, seq, rtt_ms } = e.detail;
  if (!Terminals._active.has(device)) return;  // sender's terminal not open
  const text = rtt_ms == null
    ? `seq=${seq} ${dst}: timeout\n`
    : `seq=${seq} ${dst}: time=${rtt_ms.toFixed(2)} ms\n`;
  const buf = Terminals._pingBufFor(device);
  Terminals._seqDevice.set(seq, device);
  // A timeout has no reply to animate (ready now); a success waits for its reply
  // to visually return — unless that arrival already fired before this line.
  const ready = rtt_ms == null || Terminals._pingArrived.delete(`${device}|${seq}`);
  buf.lines.set(seq, { text, ready });
  Terminals._pingFlush(device);
});
