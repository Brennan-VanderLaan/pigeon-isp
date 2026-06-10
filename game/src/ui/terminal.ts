// Desktop-style pod terminals: floating windows you can drag, resize, and
// minimize to a taskbar. A minimized window KEEPS its session alive (the
// WebSocket stays open); only close tears it down. xterm.js drives a real
// TTY in an aviary pod (k9s/vim/top render).
//
// Framing (matches tower/shell.go):
//   client -> server: binary/text = raw stdin; a text frame leading with
//     0x01 + JSON {cols,rows} is a resize control.
//   server -> client: binary = stdout; one text "error: ..." on failure.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

class WindowManager {
  private taskbar: HTMLElement;
  private wins = new Set<TermWindow>();
  private z = 30;

  constructor() {
    this.taskbar = document.createElement('div');
    this.taskbar.id = 'term-taskbar';
    document.body.appendChild(this.taskbar);
  }

  open(pod: string, ns: string, sessionId?: string): void {
    // One window per pod: focus the existing one instead of stacking dupes.
    for (const w of this.wins) {
      if (w.pod === pod && w.ns === ns) { w.restore(); w.focus(); return; }
    }
    const w = new TermWindow(pod, ns, this, sessionId);
    this.wins.add(w);
    w.focus();
  }

  /** Sessions the player had open, remembered across reloads so windows
   *  can auto-rejoin the live shells. */
  private restoredKey = 'pigeon-isp-shell-sessions-v1';
  rememberSession(pod: string, ns: string, sessionId: string): void {
    try {
      const m = this.savedSessions();
      m[`${ns}/${pod}`] = sessionId;
      localStorage.setItem(this.restoredKey, JSON.stringify(m));
    } catch { /* storage blocked */ }
  }
  forgetSession(pod: string, ns: string): void {
    try {
      const m = this.savedSessions();
      delete m[`${ns}/${pod}`];
      localStorage.setItem(this.restoredKey, JSON.stringify(m));
    } catch { /* */ }
  }
  private savedSessions(): Record<string, string> {
    try { return JSON.parse(localStorage.getItem(this.restoredKey) || '{}'); } catch { return {}; }
  }

  /** On load, re-open windows for sessions that are still alive tower-side. */
  async restoreSessions(): Promise<void> {
    const saved = this.savedSessions();
    if (!Object.keys(saved).length) return;
    let live: Record<string, { id: string; pod: string; ns: string }> = {};
    try {
      const r = await fetch('/api/shells');
      const body = await r.json();
      for (const s of body.sessions ?? []) live[s.id] = s;
    } catch { return; }
    for (const [key, id] of Object.entries(saved)) {
      const s = live[id];
      if (s) this.open(s.pod, s.ns, id);
      else { const [ns, pod] = key.split('/'); this.forgetSession(pod, ns); }
    }
  }

  nextZ(): number {
    return ++this.z;
  }

  remove(w: TermWindow): void {
    this.wins.delete(w);
    this.renderTaskbar();
  }

  renderTaskbar(): void {
    this.taskbar.innerHTML = '';
    for (const w of this.wins) {
      if (!w.minimized) continue;
      const chip = document.createElement('button');
      chip.className = 'term-chip';
      chip.textContent = '▮ ' + w.pod;
      chip.addEventListener('click', () => { w.restore(); w.focus(); });
      this.taskbar.appendChild(chip);
    }
    this.taskbar.style.display = this.taskbar.childElementCount ? 'flex' : 'none';
  }
}

let manager: WindowManager | null = null;

function mgr(): WindowManager {
  if (!manager) manager = new WindowManager();
  return manager;
}

/** Open (or focus) a terminal window for a pod. */
export function openTerminal(pod: string, ns: string): void {
  mgr().open(pod, ns);
}

/** Re-open windows for shells that survived a page reload. */
export function restoreTerminals(): void {
  mgr().restoreSessions();
}

class TermWindow {
  minimized = false;
  private el: HTMLElement;
  private body: HTMLElement;
  private term: Terminal;
  private fit = new FitAddon();
  private ws: WebSocket | null = null;
  private closed = false;

  private sessionId?: string;

  constructor(readonly pod: string, readonly ns: string, private mgr: WindowManager, sessionId?: string) {
    this.sessionId = sessionId;
    this.el = document.createElement('div');
    this.el.className = 'term-win';
    const w = 640, h = 380;
    const offset = (mgr.nextZ() % 6) * 26;
    this.el.style.cssText = `left:${120 + offset}px; top:${90 + offset}px; width:${w}px; height:${h}px; z-index:${mgr.nextZ()};`;
    this.el.innerHTML = `
      <div class="tw-bar">
        <span class="tw-title">▮ ${escapeHtml(ns)}/${escapeHtml(pod)}</span>
        <span class="tw-status">connecting…</span>
        <span class="tw-spacer"></span>
        <button class="tw-btn" data-act="min" title="minimize">—</button>
        <button class="tw-btn" data-act="close" title="close">✕</button>
      </div>
      <div class="tw-body"></div>
      <div class="tw-grip" title="resize"></div>`;
    document.body.appendChild(this.el);
    this.body = this.el.querySelector('.tw-body') as HTMLElement;

    this.term = new Terminal({
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0b0e13', foreground: '#cfd8e3', cursor: '#ffb347' },
      cursorBlink: true,
      scrollback: 4000,
    });
    this.term.loadAddon(this.fit);
    this.term.open(this.body);

    this.el.querySelector('[data-act=min]')!.addEventListener('click', () => this.minimize());
    this.el.querySelector('[data-act=close]')!.addEventListener('click', () => this.close());
    this.el.addEventListener('pointerdown', () => this.focus(), true);
    this.makeDraggable(this.el.querySelector('.tw-bar') as HTMLElement);
    this.makeResizable(this.el.querySelector('.tw-grip') as HTMLElement);

    this.connect();
    requestAnimationFrame(() => this.refit());
  }

  focus(): void {
    this.el.style.zIndex = String(this.mgr.nextZ());
    setTimeout(() => this.term.focus(), 0);
  }

  minimize(): void {
    this.minimized = true;
    this.el.style.display = 'none';
    this.mgr.renderTaskbar();
  }

  restore(): void {
    this.minimized = false;
    this.el.style.display = 'flex';
    this.mgr.renderTaskbar();
    requestAnimationFrame(() => this.refit());
  }

  close(): void {
    this.closed = true;
    // Explicit close = done with this session: forget it so it isn't
    // re-opened on reload. (Minimize keeps it; reload rejoins it.)
    this.mgr.forgetSession(this.pod, this.ns);
    this.ws?.close();
    this.term.dispose();
    this.el.remove();
    this.mgr.remove(this);
  }

  // ---- session ----------------------------------------------------------------

  private wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = location.port === '5173' ? `${proto}://${location.hostname}` : `${proto}://${location.host}`;
    if (this.sessionId) return `${base}/api/shell?session=${encodeURIComponent(this.sessionId)}`;
    return `${base}/api/shell?pod=${encodeURIComponent(this.pod)}&ns=${encodeURIComponent(this.ns)}`;
  }

  private connect(): void {
    const ws = new WebSocket(this.wsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const status = this.el.querySelector('.tw-status')!;

    ws.onopen = () => {
      status.textContent = '● live';
      (status as HTMLElement).style.color = 'var(--good)';
      this.sendResize();
      this.term.focus();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // The server's first text frame on a NEW session is {"session":"sh-N"}.
        if (ev.data.startsWith('{') && ev.data.includes('"session"')) {
          try {
            const id = JSON.parse(ev.data).session;
            if (id) { this.sessionId = id; this.mgr.rememberSession(this.pod, this.ns, id); }
          } catch { /* not the session announce */ }
          return;
        }
        if (ev.data.startsWith('error: ')) this.term.write(`\r\n\x1b[31m${ev.data}\x1b[0m\r\n`);
        else this.term.write(ev.data);
      } else {
        this.term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      status.textContent = '○ closed';
      (status as HTMLElement).style.color = 'var(--dim)';
      this.term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    };
    ws.onerror = () => { status.textContent = '✕ error'; };

    this.term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
  }

  private sendResize(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send('\x01' + JSON.stringify({ cols: this.term.cols, rows: this.term.rows }));
  }

  private refit(): void {
    try { this.fit.fit(); this.sendResize(); } catch { /* not laid out yet */ }
  }

  // ---- window chrome ----------------------------------------------------------

  private makeDraggable(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.tw-btn')) return;
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev: PointerEvent) => {
        this.el.style.left = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx)) + 'px';
        this.el.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  private makeResizable(grip: HTMLElement): void {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = this.el.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        this.el.style.width = Math.max(320, ev.clientX - r.left) + 'px';
        this.el.style.height = Math.max(200, ev.clientY - r.top) + 'px';
        this.refit(); // live: the PTY follows the window, like a real terminal
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.refit();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}

/** Back-compat shim: existing call sites do `new PodTerminal(pod, ns)`. */
export class PodTerminal {
  constructor(pod: string, ns: string) {
    openTerminal(pod, ns);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
