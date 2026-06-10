// A live pod terminal: xterm.js bound to the tower's /api/shell WebSocket.
// Full ANSI/TTY so k9s, vim, top, htop render properly inside an aviary pod.
//
// Framing (matches tower/shell.go):
//   client -> server: binary/text frames = raw stdin; a text frame whose
//     first byte is 0x01 + JSON {"cols","rows"} is a resize control.
//   server -> client: binary frames = stdout bytes; a text "error: ..."
//     frame on setup failure, then close.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

export class PodTerminal {
  private term: Terminal;
  private fit = new FitAddon();
  private ws: WebSocket | null = null;
  private overlay: HTMLElement;
  private onResize = () => this.refit();

  constructor(private pod: string, private ns: string) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'term-overlay';
    this.overlay.innerHTML = `
      <div class="term-window">
        <div class="term-bar">
          <span class="term-title">▮ ${ns}/${pod} — /bin/sh</span>
          <span class="term-status" id="term-status">connecting…</span>
          <button class="term-close" id="term-close">✕</button>
        </div>
        <div class="term-body" id="term-body"></div>
      </div>`;
    document.body.appendChild(this.overlay);

    this.term = new Terminal({
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0b0e13', foreground: '#cfd8e3', cursor: '#ffb347' },
      cursorBlink: true,
    });
    this.term.loadAddon(this.fit);
    this.term.open(this.overlay.querySelector('#term-body') as HTMLElement);

    this.overlay.querySelector('#term-close')!.addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.escClose, true);

    this.connect();
    setTimeout(() => this.refit(), 30);
  }

  private escClose = (e: KeyboardEvent) => {
    // Esc closes ONLY when the terminal hasn't captured focus, so vim users
    // can still hit Escape inside the shell.
    if (e.key === 'Escape' && document.activeElement?.closest('.term-body') == null) {
      this.close();
    }
  };

  private wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = location.port === '5173'
      ? `${proto}://${location.hostname}` // dev: tower not same-origin; expect a proxy or override
      : `${proto}://${location.host}`;
    return `${base}/api/shell?pod=${encodeURIComponent(this.pod)}&ns=${encodeURIComponent(this.ns)}`;
  }

  private connect(): void {
    const ws = new WebSocket(this.wsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const status = this.overlay.querySelector('#term-status')!;

    ws.onopen = () => {
      status.textContent = '● live';
      status.classList.add('live');
      this.sendResize();
      this.term.focus();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.startsWith('error: ')) {
          this.term.write(`\r\n\x1b[31m${ev.data}\x1b[0m\r\n`);
        } else {
          this.term.write(ev.data);
        }
      } else {
        this.term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };
    ws.onclose = () => {
      status.textContent = '○ closed';
      status.classList.remove('live');
      this.term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    };
    ws.onerror = () => {
      status.textContent = '✕ error';
    };

    // Keystrokes → stdin.
    this.term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
  }

  private sendResize(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({ cols: this.term.cols, rows: this.term.rows });
    this.ws.send('\x01' + msg);
  }

  private refit(): void {
    try {
      this.fit.fit();
      this.sendResize();
    } catch { /* not yet laid out */ }
  }

  close(): void {
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.escClose, true);
    this.ws?.close();
    this.term.dispose();
    this.overlay.remove();
  }
}
