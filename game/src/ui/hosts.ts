// Hosts tab: spawn, list, and reap aviary pods at runtime — the absurd
// sandbox. Talks to the tower's /api/hosts. Any host here is wired ONLY to
// the pigeon CNI, so its traffic only flows if you route it.
import { PodTerminal } from './terminal';

interface Host {
  name: string;
  image: string;
  node: string;
  phase: string;
  podIP: string;
  labels?: Record<string, string>;
}

const TEMPLATES = [
  { id: 'ping', label: 'ping (idle busybox)', needsImage: false },
  { id: 'nginx', label: 'nginx server', needsImage: false },
  { id: 'iperf-server', label: 'iperf3 server', needsImage: false },
  { id: 'iperf-client', label: 'iperf3 client (idle)', needsImage: false },
  { id: 'custom', label: 'custom image…', needsImage: true },
];

export class Hosts {
  private el = document.getElementById('hosts')!;
  private timer: number | null = null;
  private hosts: Host[] = [];
  private busy = '';

  show(): void {
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 4000);
  }
  hide(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Don't clobber a field the user is typing in on the periodic refresh. */
  private typing(): boolean {
    const a = document.activeElement;
    return !!a && this.el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT');
  }

  private async refresh(): Promise<void> {
    try {
      const r = await fetch('/api/hosts');
      const body = await r.json();
      this.hosts = body.hosts ?? [];
      if (!this.typing()) this.render();
    } catch (e) {
      if (!this.typing()) this.el.innerHTML = `<h2>Hosts</h2><div class="sub bad">tower unreachable: ${(e as Error).message}</div>`;
    }
  }

  private async spawn(): Promise<void> {
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s)!;
    const name = q<HTMLInputElement>('#h-name').value.trim();
    const template = q<HTMLSelectElement>('#h-template').value;
    const image = q<HTMLInputElement>('#h-image').value.trim();
    const cmdRaw = q<HTMLInputElement>('#h-cmd').value.trim();
    if (!name) { this.flash('name required'); return; }
    const body: any = { name, template };
    if (template === 'custom') {
      if (!image) { this.flash('custom needs an image'); return; }
      body.image = image;
      if (cmdRaw) body.cmd = ['sh', '-c', cmdRaw];
    }
    this.busy = 'spawning ' + name;
    this.render();
    try {
      const r = await fetch('/api/hosts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${r.status}`); }
      this.flash('spawned ' + name);
    } catch (e) {
      this.flash('spawn failed: ' + (e as Error).message);
    }
    this.busy = '';
    this.refresh();
  }

  private async kill(name: string): Promise<void> {
    this.busy = 'reaping ' + name;
    this.render();
    try {
      await fetch('/api/hosts?name=' + encodeURIComponent(name), { method: 'DELETE' });
    } catch { /* ignore */ }
    this.busy = '';
    this.refresh();
  }

  private flash(msg: string): void {
    const el = this.el.querySelector('#h-flash');
    if (el) el.textContent = msg;
  }

  private render(): void {
    const tplOpts = TEMPLATES.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');
    const rows = this.hosts.map((h) => {
      return `<tr>
        <td>${esc(h.name)}</td>
        <td>${esc(h.image)}</td>
        <td>${esc(h.node)}</td>
        <td class="${h.phase === 'Running' ? 'ok' : ''}">${esc(h.phase)}</td>
        <td>${esc(h.podIP || '—')}</td>
        <td>
          <button data-shell="${esc(h.name)}" ${h.phase === 'Running' ? '' : 'disabled'}>shell</button>
          <button data-kill="${esc(h.name)}">kill</button>
        </td></tr>`;
    }).join('');

    this.el.innerHTML = `
      <h2>Hosts</h2>
      <div class="sub">spawn workloads into the aviary — each gets the pigeon CNI as its ONLY network, so its
      traffic only flows if you route it. Anything from busybox to a CTF container.</div>
      <div class="card" style="max-width:680px">
        <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="text" id="h-name" placeholder="name (dns-1123)" style="width:150px">
          <select id="h-template" style="width:auto">${tplOpts}</select>
          <input type="text" id="h-image" placeholder="image (custom)" style="width:150px">
          <input type="text" id="h-cmd" placeholder="cmd (custom, optional)" style="width:170px">
          <button id="h-spawn">Spawn</button>
        </div>
        <div class="small" id="h-flash" style="margin-top:6px;color:var(--accent)">${esc(this.busy)}</div>
      </div>
      <table class="grid" style="margin-top:14px">
        <tr><th>name</th><th>image</th><th>node</th><th>phase</th><th>pod IP</th><th></th></tr>
        ${rows || '<tr><td colspan="6" class="small">no hosts yet</td></tr>'}
      </table>`;

    this.el.querySelector('#h-spawn')!.addEventListener('click', () => this.spawn());
    this.el.querySelectorAll<HTMLButtonElement>('[data-shell]').forEach((b) => {
      b.addEventListener('click', () => new PodTerminal(b.dataset.shell!, 'aviary'));
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-kill]').forEach((b) => {
      b.addEventListener('click', () => this.kill(b.dataset.kill!));
    });
  }
}

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
